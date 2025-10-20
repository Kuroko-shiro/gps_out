/* ===== タイムライン Viewer =====
 * 必要なHTML要素:
 *  - 合計距離表示: <span id="summary-total"></span>
 *  - トリップ件数: <span id="summary-count"></span>
 *  - 地図: <div id="map"></div>  (CSSで高さを指定: #map {height: 420px})
 *
 * 期待するAPIレスポンス:
 * {
 *   ok: true,
 *   trips: [{ distance_km: 1.23, from:{lat,lon,time,label}, to:{...}, ...}, ...],
 *   geojson: { type:"FeatureCollection", features:[ {geometry:{type:"LineString",coordinates:[[lon,lat],...]}, properties:{...}}, ... ] },
 *   stays: [...], visits: [...]
 * }
 */

const API_BASE = window.VIEWER_API_BASE; // 例: 'https://xxxxx.execute-api.us-east-1.amazonaws.com/prod'
const DEFAULT_DEVICE = window.DEFAULT_DEVICE_ID || '';
const DEFAULT_DATE = window.DEFAULT_DATE || '';

/* ---- DOM ---- */
const elTotalKm   = document.getElementById('summary-total');
const elTripCount = document.getElementById('summary-count');

/* ---- Map (MapLibre or Amazon Location) ---- */
let map; // maplibregl.Map 互換

function ensureMap() {
  if (map) return map;

  // MapLibre GL が読み込まれている前提（<script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js">）
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json', // Amazon Locationのスタイルに差し替え可
    center: [139.7000, 35.6800],
    zoom: 9
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('load', () => {
    // 線分ソース
    if (!map.getSource('trip-lines')) {
      map.addSource('trip-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }
    // 線分レイヤ（赤）
    if (!map.getLayer('trip-lines-layer')) {
      map.addLayer({
        id: 'trip-lines-layer',
        type: 'line',
        source: 'trip-lines',
        paint: {
          'line-color': '#e11d48',      // 赤（rose-600）
          'line-width': 4,
          'line-opacity': 0.85
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });
    }
    // 出発/到着のポイントもあると見やすい
    if (!map.getLayer('trip-points-layer')) {
      map.addLayer({
        id: 'trip-points-layer',
        type: 'circle',
        source: 'trip-lines',
        paint: {
          'circle-radius': 5,
          'circle-color': '#111827',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff'
        },
        filter: ['==', ['geometry-type'], 'Point']
      });
    }
  });

  return map;
}

/* GeoJSON を地図へ反映。LineString だけでなく端点の Point も追加して可視化 */
function renderGeoJSON(fc) {
  const m = ensureMap();

  // features が空なら何もしない
  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    // 空データでもソースはクリアしておく
    if (m.getSource('trip-lines')) {
      m.getSource('trip-lines').setData({ type: 'FeatureCollection', features: [] });
    }
    return;
  }

  // 端点ポイントを追加（見やすさ向上）
  const pointFeatures = [];
  for (const f of fc.features) {
    if (f?.geometry?.type === 'LineString' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length > 1) {
      const coords = f.geometry.coordinates;
      const from = coords[0];
      const to   = coords[coords.length - 1];
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: from },
        properties: { kind: 'start', label: f.properties?.from_label || 'start' }
      });
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: to },
        properties: { kind: 'end', label: f.properties?.to_label || 'end' }
      });
    }
  }

  const merged = {
    type: 'FeatureCollection',
    features: [...fc.features, ...pointFeatures]
  };

  if (m.getSource('trip-lines')) {
    m.getSource('trip-lines').setData(merged);
  }

  // 画面に収まるようにフィット
  try {
    const bbox = turf.bbox(merged); // turf.js を読み込んでいる場合
    m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 800 });
  } catch {
    // turf が無くても、単純に最初の線の中心へ
    const firstLine = fc.features.find(f => f.geometry?.type === 'LineString');
    if (firstLine) {
      const coords = firstLine.geometry.coordinates;
      const mid = coords[Math.floor(coords.length / 2)];
      m.setCenter(mid);
      m.setZoom(11);
    }
  }
}

/* 合計距離・件数の描画 */
function renderSummary(trips) {
  const count = Array.isArray(trips) ? trips.length : 0;
  const sumKm = (Array.isArray(trips) ? trips : [])
    .reduce((acc, t) => acc + (Number(t?.distance_km) || 0), 0);

  if (elTripCount) elTripCount.textContent = String(count);
  if (elTotalKm)   elTotalKm.textContent   = `${sumKm.toFixed(2)} km`;
}

/* タイムライン読み込み（ボタンや初期表示から呼ぶ） */
async function loadTimeline(deviceId, date) {
  const url = `${API_BASE}/timeline?deviceId=${encodeURIComponent(deviceId)}&date=${encodeURIComponent(date)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();

  // 1) サマリ
  renderSummary(json.trips || []);

  // 2) 地図（赤線）
  renderGeoJSON(json.geojson || { type: 'FeatureCollection', features: [] });

  // 3) 必要なら滞在やダイアリもここで反映
  //    json.stays / json.visits / json.diary ...
}

/* 例: ページ初期化時に読み込む */
document.addEventListener('DOMContentLoaded', () => {
  ensureMap();
  if (DEFAULT_DEVICE && DEFAULT_DATE) {
    loadTimeline(DEFAULT_DEVICE, DEFAULT_DATE)
      .catch(err => console.error('loadTimeline failed:', err));
  }
});
