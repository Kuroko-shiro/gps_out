/********************************************
 * 既存UIを変えずに「距離サマリ」「赤線ルート」を追加
 * - HTMLは一切変更不要
 * - 既存の #map を使って地図表示（高さはCSS側のまま）
 * - 合計距離の出力先は既存IDに合わせて自分で設定
 ********************************************/

/* ====== 1) 既存UIの要素IDをここで指定 ====== */
// 例: <span id="totalDistance"></span> と <span id="tripCount"></span> がある前提
const SUMMARY_IDS = {
  totalKm: 'totalDistance',  // 合計距離の出力先（km）
  count:   'tripCount'       // トリップ本数の出力先
};
// 地図コンテナ（既存UIで使っているID）
const MAP_CONTAINER_ID = 'map';

/* ====== 2) MapLibre GL を動的ロード（HTMLを触らずOK） ====== */
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
function loadCss(href){return new Promise((res,rej)=>{const l=document.createElement('link');l.rel='stylesheet';l.href=href;l.onload=res;l.onerror=rej;document.head.appendChild(l);});}
async function ensureLibs(){
  if(!window.maplibregl){
    await loadCss('https://unpkg.com/maplibre-gl@3.6.1/dist/maplibre-gl.css');
    await loadScript('https://unpkg.com/maplibre-gl@3.6.1/dist/maplibre-gl.js');
  }
  if(!window.turf){
    try{ await loadScript('https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js'); }catch(e){}
  }
}

/* ====== 3) 地図の用意（元UIの #map をそのまま使う） ====== */
let _mapInstance = null;
async function ensureMap(){
  await ensureLibs();
  if (_mapInstance) return _mapInstance;

  const container = document.getElementById(MAP_CONTAINER_ID);
  if (!container) {
    console.warn(`[map] container #${MAP_CONTAINER_ID} が見つかりません。地図はスキップします。`);
    return null;
  }

  const map = new maplibregl.Map({
    container: MAP_CONTAINER_ID,
    style: 'https://demotiles.maplibre.org/style.json', // 必要なら Amazon Location のスタイルに変更
    center: [139.7000, 35.6800],
    zoom: 9
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // 既存UIのCSS高さを尊重。高さ0の場合は暫定で与える
  const rect = container.getBoundingClientRect();
  if (rect.height < 100) container.style.height = '420px';

  map.on('load', () => {
    if (!map.getSource('trip-lines')) {
      map.addSource('trip-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }
    if (!map.getLayer('trip-lines-layer')) {
      map.addLayer({
        id: 'trip-lines-layer',
        type: 'line',
        source: 'trip-lines',
        paint: {
          'line-color': '#e11d48', // 赤
          'line-width': 4,
          'line-opacity': 0.85
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });
    }
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

  _mapInstance = map;
  return map;
}

/* ====== 4) GeoJSON を赤線レイヤに反映 ====== */
async function renderGeoJSON(fc){
  const map = await ensureMap();
  if (!map) return;

  const empty = { type: 'FeatureCollection', features: [] };
  if (!fc || !Array.isArray(fc.features)) {
    map.getSource('trip-lines')?.setData(empty);
    return;
  }

  // 端点ポイントを足して見やすく
  const pointFeatures = [];
  for (const f of fc.features) {
    if (f?.geometry?.type === 'LineString' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length > 1) {
      const coords = f.geometry.coordinates;
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[0] },
        properties: { kind: 'start', label: f.properties?.from_label || 'start' }
      });
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
        properties: { kind: 'end', label: f.properties?.to_label || 'end' }
      });
    }
  }
  const merged = { type: 'FeatureCollection', features: [...fc.features, ...pointFeatures] };
  map.getSource('trip-lines')?.setData(merged);

  // フィット
  try {
    const bbox = turf.bbox(merged);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 800 });
  } catch {
    const firstLine = fc.features.find(f => f.geometry?.type === 'LineString');
    if (firstLine?.geometry?.coordinates?.length) {
      const mid = firstLine.geometry.coordinates[Math.floor(firstLine.geometry.coordinates.length/2)];
      map.setCenter(mid);
      map.setZoom(11);
    }
  }
}

/* ====== 5) 合計距離と件数を既存UIへ反映 ====== */
function renderSummary(trips){
  const totalEl = document.getElementById(SUMMARY_IDS.totalKm);
  const countEl = document.getElementById(SUMMARY_IDS.count);

  const count = Array.isArray(trips) ? trips.length : 0;
  const sumKm = (Array.isArray(trips) ? trips : [])
    .reduce((acc, t) => acc + (Number(t?.distance_km) || 0), 0);

  if (totalEl) totalEl.textContent = `${sumKm.toFixed(2)} km`;
  if (countEl) countEl.textContent = String(count);
}

/* ====== 6) あなたの既存ロード処理にフック ======
 * 既存コードで API から { trips, geojson, ... } を得た“直後”に
 *   renderSummary(json.trips);
 *   renderGeoJSON(json.geojson);
 * を呼んでください。
 *
 * 例:
 *   const res = await fetch(`${API_BASE}/timeline?...`);
 *   const json = await res.json();
 *   // ▼ 追記:
 *   renderSummary(json.trips || []);
 *   renderGeoJSON(json.geojson || {type:'FeatureCollection', features:[]});
 */
