/*******************************************************
 * 行動タイムライン ビューア（MapLibre + API）
 * - <meta name="api-base"> / <meta name="api-key"> を使用
 * - ルート（LineString）と 滞在/立寄り（Point）を描画
 * - サマリ（合計距離・件数）と日記テキストを表示
 * - 滞在/立寄りポイントは、geojson に無くても stays/visits から補完
 *******************************************************/

/* ========= 設定の読み込み ========= */
function meta(name, fallback = "") {
  return (document.querySelector(`meta[name="${name}"]`)?.content || fallback).trim();
}
const API_BASE = meta("api-base", "https://hnuu6hrszj.execute-api.us-east-1.amazonaws.com/prod");           // 例: https://xxxxx.execute-api.us-east-1.amazonaws.com/prod
const API_KEY  = meta("api-key", "");            // 未使用なら空でOK
const MAPTILER_KEY = meta("maptiler-key", "zDVOQBS4Owriuq8wXYs4");   // 未設定ならデモスタイルにフォールバック

/* ========= DOM 参照 ========= */
const elDevice = document.getElementById("deviceId");
const elDate   = document.getElementById("date");
const elPrev   = document.getElementById("prev");
const elNext   = document.getElementById("next");
const elLoad   = document.getElementById("load");
const elStatus = document.getElementById("status");
const elDiary  = document.getElementById("diary");
const elSummary= document.getElementById("summary");
const elRaw    = document.getElementById("raw");

/* ========= MapLibre 初期化（Leaflet があっても MapLibre を必ず使う） ========= */
let mlMap = null;
function ensureMap() {
  if (mlMap && typeof mlMap.getSource === "function") return mlMap;

  if (!window.maplibregl) {
    throw new Error("MapLibre(GL) が読み込まれていません。HTMLに maplibre-gl の <script> を追加してください。");
  }

  const styleUrl = MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}` // 地名・POIが豊富
    : "https://demotiles.maplibre.org/style.json";                               // フォールバック

  mlMap = new maplibregl.Map({
    container: "map",
    style: styleUrl,
    center: [139.7, 35.68],
    zoom: 10,
    attributionControl: true,
  });
  mlMap.addControl(new maplibregl.NavigationControl(), "top-right");
  return mlMap;
}

/* ========= GeoJSON 表示（stays/visits 補完・フィルタ両対応） ========= */
function renderGeo(geojson, stays = [], visits = []) {
  const m = ensureMap();
  if (typeof m.getSource !== "function") {
    throw new Error("MapLibre map not initialized correctly.");
  }

  const ROUTE_SRC = "route-src";
  const ROUTE_LAYER = "route-layer";
  const PT_SRC = "pt-src";
  const STAY_LAYER = "stay-layer";
  const VISIT_LAYER = "visit-layer";

  const onReady = () => {
    // 既存レイヤ/ソース掃除
    [ROUTE_LAYER, STAY_LAYER, VISIT_LAYER].forEach(id => { if (m.getLayer(id)) m.removeLayer(id); });
    [ROUTE_SRC, PT_SRC].forEach(id => { if (m.getSource(id)) m.removeSource(id); });

    // もとの features をコピー
    const base = (geojson && Array.isArray(geojson.features)) ? geojson : { type:'FeatureCollection', features: [] };
    const features = [...base.features];

    // --- stays/visits の点を補完して必ず載せる ---
    if (Array.isArray(stays)) {
      for (const s of stays) {
        const c = s?.center || {};
        const lat = parseFloat(c.lat ?? c.latitude);
        const lon = parseFloat(c.lon ?? c.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: { kind: "stay", layer: "stay", label: s.label || "", start: s.start || "", end: s.end || "" }
          });
        }
      }
    }
    if (Array.isArray(visits)) {
      for (const v of visits) {
        const c = v?.center || {};
        const lat = parseFloat(c.lat ?? c.latitude);
        const lon = parseFloat(c.lon ?? c.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: { kind: "visit", layer: "visit", label: v.label || "", start: v.start || "", end: v.end || "" }
          });
        }
      }
    }

    // 1) ルート（LineString まとめ）
    const lineFC = {
      type: "FeatureCollection",
      features: features.filter(f => f.geometry?.type === "LineString")
    };
    if (lineFC.features.length) {
      m.addSource(ROUTE_SRC, { type: "geojson", data: lineFC });
      m.addLayer({
        id: ROUTE_LAYER, type: "line", source: ROUTE_SRC,
        paint: { "line-color": "#d9534f", "line-width": 4, "line-opacity": 0.9 }
      });
    }

    // 2) 点（stay/visit まとめ）
    const pointFC = {
      type: "FeatureCollection",
      features: features.filter(f => f.geometry?.type === "Point")
    };
    if (pointFC.features.length) {
      m.addSource(PT_SRC, { type: "geojson", data: pointFC });

      // フィルタは kind と layer のどちらでも通るよう OR 条件
      const isStay  = ["any", ["==", ["get","kind"], "stay"],  ["==", ["get","layer"], "stay"]];
      const isVisit = ["any", ["==", ["get","kind"], "visit"], ["==", ["get","layer"], "visit"]];

      m.addLayer({
        id: STAY_LAYER, type: "circle", source: PT_SRC, filter: ["all", isStay],
        paint: {
          "circle-radius": 6,
          "circle-color": "#1976d2",        // 滞在＝青
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
      m.addLayer({
        id: VISIT_LAYER, type: "circle", source: PT_SRC, filter: ["all", isVisit],
        paint: {
          "circle-radius": 6,
          "circle-color": "#2e7d32",        // 立寄り＝緑（お好みで）
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });

      // クリックでポップアップ
      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      [STAY_LAYER, VISIT_LAYER].forEach(layerId => {
        m.on("click", layerId, (e) => {
          const f = e.features && e.features[0];
          if (!f) return;
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          const label = p.label || "";
          const start = p.start || "";
          const end   = p.end || "";
          popup.setLngLat([lon, lat]).setHTML(`
            <div style="font-size:12px">
              <div><b>${(p.kind || p.layer) === "stay" ? "滞在" : "立寄り"}</b></div>
              ${label ? `<div>${escapeHtml(label)}</div>` : ""}
              ${start ? `<div>開始: ${escapeHtml(start)}</div>` : ""}
              ${end   ? `<div>終了: ${escapeHtml(end)}</div>` : ""}
            </div>`).addTo(m);
        });
        m.on("mouseenter", layerId, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", layerId, () => { m.getCanvas().style.cursor = ""; });
      });
    }

    // 3) 画面フィット
    try {
      const merged = { type: "FeatureCollection", features };
      if (window.turf) {
        const bbox = turf.bbox(merged);
        m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 400 });
      } else {
        const coords = [];
        merged.features.forEach(f => {
          const g = f.geometry;
          if (!g) return;
          if (g.type === "Point") coords.push(g.coordinates);
          if (g.type === "LineString") coords.push(...g.coordinates);
        });
        if (coords.length) {
          const xs = coords.map(c => c[0]);
          const ys = coords.map(c => c[1]);
          const sw = [Math.min(...xs), Math.min(...ys)];
          const ne = [Math.max(...xs), Math.max(...ys)];
          m.fitBounds([sw, ne], { padding: 40, duration: 400 });
        }
      }
    } catch {}
  };

  if (mlMap.loaded()) onReady(); else mlMap.once("load", onReady);
}

/* ========= サマリ（合計距離） ========= */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function totalDistanceKm(geojson) {
  try {
    if (window.turf) {
      return (geojson.features || []).reduce((sum, f) => {
        if (f.geometry?.type === "LineString") {
          return sum + turf.length(f, { units: "kilometers" });
        }
        return sum;
      }, 0);
    }
  } catch {}
  let total = 0;
  (geojson.features || []).forEach(f => {
    if (f.geometry?.type !== "LineString") return;
    const cs = f.geometry.coordinates || [];
    for (let i = 1; i < cs.length; i++) total += haversineKm(cs[i-1], cs[i]);
  });
  return total;
}

function updateSummary(payload) {
  const stays  = payload.stays  || [];
  const visits = payload.visits || [];
  const geo    = payload.geojson || { type: "FeatureCollection", features: [] };
  const distKm = totalDistanceKm(geo);

  elSummary.innerHTML = "";
  const add = (label, value) => {
    const li = document.createElement("li");
    li.textContent = `${label}: ${value}`;
    elSummary.appendChild(li);
  };
  add("滞在件数", stays.length);
  add("立寄り件数", visits.length);
  add("移動距離(概算)", `${distKm.toFixed(2)} km`);
}

/* ========= 日記表示 ========= */
function updateDiary(payload) {
  const txt = (payload.diary || "").trim();
  elDiary.textContent = txt || "（この日の日記はまだありません）";
}

/* ========= フェッチ & 描画 ========= */
async function loadTimeline() {
  const deviceId = (elDevice.value || "").trim();
  const date = (elDate.value || "").trim();
  if (!API_BASE) {
    setStatus("⚠️ API Base が未設定です。<meta name=\"api-base\"> を設定してください。");
    return;
  }
  if (!deviceId || !date) {
    setStatus("⚠️ Device ID と 日付 を指定してください。");
    return;
  }

  // 保存（次回のデフォルトに）
  localStorage.setItem("viewer:deviceId", deviceId);
  localStorage.setItem("viewer:date", date);

  setStatus("読み込み中…");
  try {
    const url = `${API_BASE.replace(/\/$/, "")}/timeline?deviceId=${encodeURIComponent(deviceId)}&date=${encodeURIComponent(date)}`;
    const headers = { "Content-Type": "application/json" };
    if (API_KEY) headers["x-api-key"] = API_KEY;

    const resp = await fetch(url, { headers, method: "GET" });
    const json = await resp.json().catch(() => ({}));
    elRaw.textContent = JSON.stringify(json, null, 2);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json)}`);

    // geojson が無ければ trips から最小構成を作る（後方互換）
    let geo = json.geojson;
    if (!geo || !geo.features) {
      geo = buildGeoJsonFromPayload(json);
      json.geojson = geo;
    }

    // 地図・サマリ・日記
    renderGeo(geo, json.stays || [], json.visits || []);
    updateSummary(json);
    updateDiary(json);
    setStatus("読み込み完了");
  } catch (e) {
    console.error(e);
    setStatus("読み込みに失敗しました。コンソールをご確認ください。");
  }
}

// 後方互換: stays/visits/trips から最低限の GeoJSON を作る
function buildGeoJsonFromPayload(p) {
  const feats = [];

  // trips: {geometry: {type:LineString, coordinates:[...]}}
  (p.trips || []).forEach(tr => {
    if (tr.geometry?.type === "LineString") {
      feats.push({
        type: "Feature",
        properties: { kind: "trip", layer: "trip" },
        geometry: { type: "LineString", coordinates: tr.geometry.coordinates }
      });
    }
  });

  // stays/visits を点に（描画側でも補完するが、ここでも入れておく）
  (p.stays || []).forEach(s => {
    if (!s.center) return;
    feats.push({
      type: "Feature",
      properties: {
        kind: "stay", layer: "stay",
        label: s.label || "", start: s.start || "", end: s.end || ""
      },
      geometry: { type: "Point", coordinates: [s.center.lon, s.center.lat] }
    });
  });

  (p.visits || []).forEach(v => {
    if (!v.center) return;
    feats.push({
      type: "Feature",
      properties: {
        kind: "visit", layer: "visit",
        label: v.label || "", start: v.start || "", end: v.end || ""
      },
      geometry: { type: "Point", coordinates: [v.center.lon, v.center.lat] }
    });
  });

  return { type: "FeatureCollection", features: feats };
}

/* ========= ユーティリティ ========= */
function setStatus(msg) { elStatus.textContent = msg; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function addDays(isoDate, delta) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/* ========= イベント ========= */
elLoad?.addEventListener("click", loadTimeline);
elPrev?.addEventListener("click", () => { elDate.value = addDays(elDate.value, -1); loadTimeline(); });
elNext?.addEventListener("click", () => { elDate.value = addDays(elDate.value, +1); loadTimeline(); });

/* ========= 初期化 ========= */
document.addEventListener("DOMContentLoaded", () => {
  // 入力の復元
  const savedDev  = localStorage.getItem("viewer:deviceId") || "";
  const savedDate = localStorage.getItem("viewer:date") || new Date().toISOString().slice(0,10);
  if (savedDev) elDevice.value = savedDev;
  if (savedDate) elDate.value = savedDate;

  // 地図だけ先に作成
  try { ensureMap(); } catch (e) { console.warn(e.message); }

  if (!API_BASE) {
    setStatus("⚠️ API Base が未設定です。<meta name=\"api-base\"> を設定してください。");
  }
});
