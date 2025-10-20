// ===== 1) 設定（index.html の <meta> から読む） =====
function getApiBase() {
  return document.querySelector('meta[name="api-base"]')?.content?.trim() || "";
}
function getApiKey() {
  return document.querySelector('meta[name="api-key"]')?.content?.trim() || "";
}

// ===== 2) DOM =====
const $id = (s)=>document.getElementById(s);
const deviceIdInput = $id("deviceId");
const dateInput     = $id("date");
const prevBtn       = $id("prev");
const nextBtn       = $id("next");
const loadBtn       = $id("load");
const statusBox     = $id("status");
const diaryBox      = $id("diary");
const summaryList   = $id("summary");
const rawBox        = $id("raw");

let map, stayLayer, visitLayer, tripLayer;

// ===== 3) 起動時の初期化 =====
document.addEventListener("DOMContentLoaded", () => {
  // localStorage に保存してある deviceId を入れる（無ければ空）
  const saved = localStorage.getItem("deviceId");
  if (saved) deviceIdInput.value = saved;

  // 初期日付は今日（UTC）
  const todayUtc = new Date().toISOString().slice(0,10);
  dateInput.value = dateInput.value || todayUtc;

  // 地図初期化（OSMタイル）
  initMap();

  // イベント
  prevBtn.addEventListener("click", () => shiftDate(-1));
  nextBtn.addEventListener("click", () => shiftDate(+1));
  loadBtn.addEventListener("click", () => loadTimeline());
  deviceIdInput.addEventListener("keydown", e=>{ if(e.key==="Enter") loadTimeline(); });
  dateInput.addEventListener("keydown", e=>{ if(e.key==="Enter") loadTimeline(); });

  // 初回ロード
  loadTimeline();
});

// ===== 4) 地図初期化 =====
function initMap() {
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  map.setView([35.681,139.767], 11); // 東京駅付近
}

// ===== 5) ユーティリティ =====
function setStatus(msg) { statusBox.textContent = msg; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
function fmt(s) { try { return new Date(s).toLocaleString("ja-JP"); } catch { return s || ""; } }

function shiftDate(delta) {
  const d = new Date(dateInput.value);
  d.setUTCDate(d.getUTCDate() + delta);
  dateInput.value = d.toISOString().slice(0,10);
  loadTimeline();
}

function clearMapLayers() {
  if (stayLayer) { map.removeLayer(stayLayer); stayLayer=null; }
  if (visitLayer){ map.removeLayer(visitLayer); visitLayer=null; }
  if (tripLayer) { map.removeLayer(tripLayer); tripLayer=null; }
}

// ===== 6) 表示API 呼び出し =====
async function loadTimeline() {
  const apiBase = getApiBase();
  if (!apiBase) { setStatus("API Base が未設定です（index.html の meta を確認）"); return; }

  const deviceId = deviceIdInput.value.trim();
  if (!deviceId) { alert("deviceId を入力してください"); return; }
  localStorage.setItem("deviceId", deviceId);

  const date = dateInput.value;
  setStatus("読み込み中…");

  const headers = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  if (apiKey) headers["x-api-key"] = apiKey;

  const url = `${apiBase}/timeline?deviceId=${encodeURIComponent(deviceId)}&date=${date}`;

  try {
    const res = await fetch(url, { headers });
    const text = await res.text(); // ← 一旦文字列で受け取るとエラー時の中身が見やすい
    if (!res.ok) {
      setStatus(`HTTP ${res.status}`);
      diaryBox.textContent = "";
      summaryList.innerHTML = "";
      rawBox.textContent = text; // サーバからのエラー本文を表示
      clearMapLayers();
      return;
    }
    const data = JSON.parse(text);
    rawBox.textContent = JSON.stringify(data, null, 2);
    renderDiaryAndSummary(data);
    renderMap(data);
    setStatus("読み込み完了");
  } catch (e) {
    console.error(e);
    setStatus("取得に失敗しました。コンソールを確認してください。");
  }
}

// ===== 7) 地図描画（stays/visits/trips） =====
function renderMap(data) {
  clearMapLayers();

  const stays  = data.stays || [];
  const visits = data.visits || [];
  const trips  = data.trips || [];
  const bounds = [];

  // 滞在: 青い円マーカー（少し大きめ）
  const stayMarkers = stays.map((s,i)=>{
    const {lat, lon} = s.center;
    const m = L.circleMarker([lat,lon], {
      radius: 8, color:"#1d4ed8", fillColor:"#2563eb", fillOpacity:0.9, weight:2
    }).bindPopup(`${escapeHtml(s.label || "滞在")}<br>${fmt(s.start)}〜${fmt(s.end)}`);
    bounds.push([lat,lon]); 
    return m;
  });
  stayLayer = L.layerGroup(stayMarkers).addTo(map);

  // 立寄り: 緑の小円マーカー
  const visitMarkers = visits.map((v,i)=>{
    const c = v.center || v.location || {};
    const {lat, lon} = c;
    if (lat==null || lon==null) return null;
    const m = L.circleMarker([lat,lon], {
      radius: 5, color:"#15803d", fillColor:"#16a34a", fillOpacity:0.9, weight:2
    }).bindPopup(`${escapeHtml(v.label || "立寄り")}${v.start?("<br>"+fmt(v.start)):""}`);
    bounds.push([lat,lon]); 
    return m;
  }).filter(Boolean);
  visitLayer = L.layerGroup(visitMarkers).addTo(map);

  // 移動: 赤いポリライン（座標は [lon,lat] → Leaflet は [lat,lon] へ入れ替え）
  const tripLines = trips.map(t=>{
    const coords = (t.route && t.route.coordinates) || [];
    if (coords.length<2) return null;
    const latlngs = coords.map(([lon,lat])=>[lat,lon]);
    const pl = L.polyline(latlngs, { color:"#ef4444", weight:4, opacity:0.9 });
    bounds.push(latlngs[0], latlngs[latlngs.length-1]);
    return pl.bindPopup(`移動(${t.mode || "-"}) 距離:${((t.distance_m||0)/1000).toFixed(1)}km`);
  }).filter(Boolean);
  tripLayer = L.layerGroup(tripLines).addTo(map);

  // どこかに寄せる
  if (bounds.length) map.fitBounds(bounds, { padding:[24,24] });
  else map.setView([35.681,139.767], 11);
}

// ===== 8) 日記とサマリ描画 =====
function renderDiaryAndSummary(data) {
  // 日記（なければ案内文）
  diaryBox.textContent = data.diary || "（この日の日記は未生成です）";

  // サマリ（件数と移動距離）
  const stays = data.stays || [];
  const trips = data.trips || [];
  const visits= data.visits || [];
  const totalDistKm = (trips.reduce((a,t)=>a+(t.distance_m||0),0)/1000).toFixed(1);

  const items = [
    `滞在: ${stays.length} 件`,
    `立寄り: ${visits.length} 件`,
    `移動: ${trips.length} 区間 / 合計距離 ${totalDistKm} km`
  ];
  summaryList.innerHTML = items.map(s=>`<li>${escapeHtml(s)}</li>`).join("");
}
