// ---- 設定取得 ----
function getApiBase() {
  return (document.querySelector('meta[name="api-base"]')?.content || '').trim();
}
function getApiKey() {
  return (document.querySelector('meta[name="api-key"]')?.content || '').trim();
}

// ---- DOM ----
const elDevice   = document.getElementById('deviceId');
const elDate     = document.getElementById('date');
const btnPrev    = document.getElementById('prev');
const btnNext    = document.getElementById('next');
const btnLoad    = document.getElementById('load');
const elStatus   = document.getElementById('status');
const elDiary    = document.getElementById('diary');
const elSummary  = document.getElementById('summary');
const elRaw      = document.getElementById('raw');

// ---- MapLibre ----
let map; // maplibregl.Map
// === MapTiler + MapLibre 用の ensureMap() ===
function ensureMap() {
  if (window.map) return window.map;

  // 1) APIキーを index.html の <meta> から読む
  const MAPTILER_KEY =
    document.querySelector('meta[name="maptiler-key"]')?.content?.trim() || "";

  if (!MAPTILER_KEY) {
    console.warn("⚠️ MapTiler APIキーが未設定です。<meta name=\"maptiler-key\" ... > を入れてください。");
  }

  // 2) 使うスタイル（地名・POIが出る “streets-v2” を推奨）
  // ほか: outdoor-v2 / basic-v2 / topo-v2 など
  const STYLE = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

  // 3) MapLibre マップ生成
  window.map = new maplibregl.Map({
    container: "map",
    style: STYLE,
    center: [139.7000, 35.6800], // 初期表示（新宿周辺など）
    zoom: 10
  });

  // ズーム・向きコントロール
  window.map.addControl(new maplibregl.NavigationControl(), "top-right");

  // 著作表示（MapTiler のクレジットは必須）
  window.map.addControl(
    new maplibregl.AttributionControl({
      customAttribution: '© MapTiler © OpenStreetMap contributors'
    })
  );

  // あなたの既存処理：ソース/レイヤの作成（なければ初期化）
  window.map.on("load", () => {
    if (!window.map.getSource("timeline")) {
      window.map.addSource("timeline", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
    }

    // 既存のレイヤ追加（例：滞在/立寄り/移動線）
    if (!window.map.getLayer("trip-lines")) {
      window.map.addLayer({
        id: "trip-lines",
        type: "line",
        source: "timeline",
        filter: ["==", ["get", "layer"], "trip"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#d85866", "line-width": 4, "line-opacity": 0.9 }
      });
    }
    if (!window.map.getLayer("stay-points")) {
      window.map.addLayer({
        id: "stay-points",
        type: "circle",
        source: "timeline",
        filter: ["==", ["get", "layer"], "stay"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#1e3a8a",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
    }
    if (!window.map.getLayer("visit-points")) {
      window.map.addLayer({
        id: "visit-points",
        type: "circle",
        source: "timeline",
        filter: ["==", ["get", "layer"], "visit"],
        paint: {
          "circle-radius": 6,
          "circle-color": "#0ea5e9",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
    }
  });

  return window.map;
}


// GeoJSON描画（LineString + stays/visits の points をマージ）
function renderGeo(fc, stays, visits) {
  const m = ensureMap();
  if (!m) return;
  const base = (fc && Array.isArray(fc.features)) ? fc : { type:'FeatureCollection', features: [] };
  const features = [...base.features];

  // stays → Point
  if (Array.isArray(stays)) {
    for (const s of stays) {
      const c = s?.center || {};
      const lat = parseFloat(c.lat ?? c.latitude);
      const lon = parseFloat(c.lon ?? c.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { kind: 'stay', label: s.label || '' }
        });
      }
    }
  }
  // visits → Point
  if (Array.isArray(visits)) {
    for (const v of visits) {
      const c = v?.center || {};
      const lat = parseFloat(c.lat ?? c.latitude);
      const lon = parseFloat(c.lon ?? c.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { kind: 'visit', label: v.label || '' }
        });
      }
    }
  }

  const merged = { type: 'FeatureCollection', features };
  if (m.getSource('timeline')) {
    m.getSource('timeline').setData(merged);
  }

  // フィット
  try {
    const bbox = turf.bbox(merged);
    m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 800 });
  } catch {
    const line = features.find(f => f.geometry?.type === 'LineString');
    if (line) {
      const coords = line.geometry.coordinates;
      if (coords?.length) {
        const mid = coords[Math.floor(coords.length/2)];
        m.setCenter(mid);
        m.setZoom(11);
      }
    }
  }
}

// サマリ描画（合計距離・件数）
function renderSummary(trips) {
  const list = Array.isArray(trips) ? trips : [];
  const sumKm = list.reduce((acc, t) => acc + (Number(t?.distance_km) || 0), 0);
  const items = [
    `合計距離: ${sumKm.toFixed(2)} km`,
    `移動回数: ${list.length}`
  ];
  elSummary.innerHTML = items.map(s => `<li>${escapeHtml(s)}</li>`).join('');
}

// 日記描画
function renderDiary(text) {
  const t = (text || '').trim();
  elDiary.textContent = t || '（この日の自動日記はありません）';
}

// ステータス
function setStatus(msg) {
  elStatus.textContent = msg || '';
}

// JSON表示
function renderRaw(obj) {
  try {
    elRaw.textContent = JSON.stringify(obj, null, 2);
  } catch {
    elRaw.textContent = String(obj);
  }
}

// ---- 読み込み処理 ----
async function loadTimeline() {
  const api = getApiBase();
  const key = getApiKey();
  const deviceId = (elDevice.value || '').trim();
  const date = (elDate.value || '').trim();

  if (!api) { alert('API Base が未設定です（metaタグ）'); return; }
  if (!deviceId || !date) { alert('Device ID と日付を入力してください'); return; }

  setStatus('読み込み中…');
  try {
    const url = `${api.replace(/\/$/, '')}/timeline?deviceId=${encodeURIComponent(deviceId)}&date=${encodeURIComponent(date)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-api-key'] = key;

    const resp = await fetch(url, { method: 'GET', headers });
    const json = await resp.json().catch(() => ({}));
    renderRaw(json);

    if (!resp.ok) {
      setStatus(`エラー: HTTP ${resp.status}`);
      return;
    }

    // サマリ
    renderSummary(json.trips || []);
    // 地図（geojson + stays + visits）
    renderGeo(json.geojson || {type:'FeatureCollection', features:[]}, json.stays || [], json.visits || []);
    // 日記
    renderDiary(json.diary || '');

    setStatus('読み込み完了');
  } catch (e) {
    console.error(e);
    setStatus('読み込みに失敗しました（Console参照）');
  }
}

// ---- 日付ナビ ----
function shiftDate(days) {
  const d = new Date(elDate.value || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  elDate.value = `${yyyy}-${mm}-${dd}`;
}

// ---- Utils ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

// ---- 起動 ----
document.addEventListener('DOMContentLoaded', () => {
  ensureMap(); // 先に地図準備
  btnLoad?.addEventListener('click', loadTimeline);
  btnPrev?.addEventListener('click', () => { shiftDate(-1); loadTimeline(); });
  btnNext?.addEventListener('click', () => { shiftDate(+1); loadTimeline(); });

  // URLパラメータで deviceId/date を受け取ったら初期セット
  const u = new URL(location.href);
  const did = u.searchParams.get('deviceId');
  const dt  = u.searchParams.get('date');
  if (did) elDevice.value = did;
  if (dt)  elDate.value   = dt;

  // どちらも指定があれば自動読み込み
  if (elDevice.value && elDate.value) {
    loadTimeline();
  }
});
