"use strict";
// ---------- state ----------
const LS_KEY = "growth-tracker-v1";
const Z_LINES = [
  { z: -1.8808, label: "3rd" }, { z: -1.0364, label: "15th" }, { z: 0, label: "50th" },
  { z: 1.0364, label: "85th" }, { z: 1.8808, label: "97th" }
];
let state = { children: [], entries: [] };
let prefs = { units: "metric" };
try { const u = localStorage.getItem("growth-units"); if (u === "imperial" || u === "metric") prefs.units = u; } catch (e) {}
const ui = { metric: "height", view: "values", refSex: null, hidden: new Set(), addKid: null, range: "all", rangeKid: null, custom: null };
let chart = null, syncMode = "loading", readOnly = false;

const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- dates & formatting ----------
function parseDate(s){
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(s || "");
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d); const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return t;
}
const isoFromUTC = t => new Date(t).toISOString().slice(0, 10);
function todayISO(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function ageDaysOf(child, dateStr){ return Math.round((parseDate(dateStr) - parseDate(child.dob)) / 864e5); }
function fmtAge(days){
  if (days < 0 || !isFinite(days)) return "–";
  const totalM = Math.floor(days / DAYS_PER_MONTH);
  if (totalM < 1) return `${Math.floor(days / 7)} wk`;
  if (totalM < 24) return `${totalM} mo`;
  const y = Math.floor(totalM / 12), m = totalM % 12;
  return m ? `${y} y ${m} mo` : `${y} y`;
}
function fmtDate(s){ const t = parseDate(s); return new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }); }
function ordinal(n){ const v = n % 100; if (v >= 11 && v <= 13) return n + "th"; return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"); }
function pctText(z){
  if (z == null || !isFinite(z)) return null;
  const p = normCdf(z) * 100;
  if (p < 0.1) return "below 0.1st";
  if (p > 99.9) return "above 99.9th";
  if (p < 1 || p > 99) return p.toFixed(1) + (p < 1 ? "" : "") + "th";
  return ordinal(Math.round(p));
}

// ---------- units ----------
const UNIT = {
  metric: { height: "cm", weight: "kg", bmi: "kg/m²", h: v => v, w: v => v, hIn: v => v, wIn: v => v },
  imperial: { height: "in", weight: "lb", bmi: "kg/m²", h: v => v / 2.54, w: v => v / 0.45359237, hIn: v => v * 2.54, wIn: v => v * 0.45359237 }
};
const U = () => UNIT[prefs.units] || UNIT.metric;
function disp(metric, v){
  if (v == null) return null;
  if (metric === "height") return U().h(v);
  if (metric === "weight") return U().w(v);
  return v;
}
function fmtVal(metric, v){ const d = disp(metric, v); return d == null ? "–" : `${d.toFixed(1)} ${U()[metric]}`; }

// ---------- measurement math ----------
function defaultPos(days){ return days < 731 ? "L" : "H"; }
function metricValue(child, e, metric){
  const days = ageDaysOf(child, e.date);
  const hs = e.h > 0 ? standardHeight(days, e.h, e.pos || defaultPos(days)) : null;
  if (metric === "height") return hs;
  if (metric === "weight") return e.w > 0 ? e.w : null;
  if (metric === "bmi") return hs && e.w > 0 ? e.w / Math.pow(hs / 100, 2) : null;
  return null;
}
function zFor(child, e, metric){
  if (!(child.sex === 1 || child.sex === 2)) return null;
  const v = metricValue(child, e, metric); if (v == null) return null;
  return zScore(W, metric, child.sex, ageDaysOf(child, e.date), v);
}
const entriesOf = id => state.entries.filter(e => e.childId === id).sort((a, b) => parseDate(a.date) - parseDate(b.date));
const childColor = c => getComputedStyle(document.documentElement).getPropertyValue(`--c${(c.color ?? 0) % 4}`).trim();
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- persistence: offline-first with a queue of changes synced to the Google Sheet ----------
const DATA_KEY = "gt-data", OUTBOX_KEY = "gt-outbox", CONF_KEY = "gt-config", META_KEY = "gt-meta";
const entryId = (childId, date) => `${childId}_${date}`;
let outbox = [], conf = null, meta = { lastSync: 0, sheetUrl: "", by: "" }, syncing = false, syncTimer = null, lastError = "";
function readJSON(k, d){ try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch (e) { return d; } }
function writeJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function validState(p){ return p && Array.isArray(p.children) && Array.isArray(p.entries); }
function cacheLocal(){ writeJSON(DATA_KEY, { children: state.children, entries: state.entries }); }
function loadLocal(){
  const d = readJSON(DATA_KEY, null); if (validState(d)) state = d;
  outbox = readJSON(OUTBOX_KEY, []); conf = readJSON(CONF_KEY, null); meta = Object.assign(meta, readJSON(META_KEY, {}));
}
function normalise(p){ // backup files from the Claude version
  const children = p.children.map((c, i) => ({ id: String(c.id), name: c.name || "", sex: c.sex === 1 || c.sex === 2 ? c.sex : null, dob: c.dob || "", color: c.color ?? i, created: c.created ?? i }));
  const map = new Map();
  for (const e of p.entries) {
    if (!e.childId || isNaN(parseDate(e.date))) continue;
    const id = entryId(e.childId, e.date), ex = map.get(id) || { id, childId: String(e.childId), date: e.date, h: null, w: null, pos: null };
    if (e.h > 0) { ex.h = e.h; ex.pos = e.pos || null; } if (e.w > 0) ex.w = e.w;
    map.set(id, ex);
  }
  return { children, entries: [...map.values()] };
}
function queue(op){ outbox.push(op); writeJSON(OUTBOX_KEY, outbox); cacheLocal(); updateSyncUI(); scheduleSync(800); }
function applyOp(st, op){ // re-apply a not-yet-synced change on top of data from the Sheet
  if (op.type === "putKid") { const i = st.children.findIndex(x => x.id === op.kid.id); if (i >= 0) st.children[i] = op.kid; else st.children.push(op.kid); }
  else if (op.type === "delKid") { st.children = st.children.filter(x => x.id !== op.id); st.entries = st.entries.filter(e => e.childId !== op.id); }
  else if (op.type === "putEntries") for (const p of op.entries) {
    const i = st.entries.findIndex(x => x.id === p.id);
    const e = i >= 0 ? { ...st.entries[i] } : { id: p.id, childId: p.childId, date: p.date, h: null, w: null, pos: null };
    if (p.h !== undefined) { e.h = p.h; e.pos = p.pos ?? null; } if (p.w !== undefined) e.w = p.w;
    if (i >= 0) st.entries[i] = e; else st.entries.push(e);
  }
  else if (op.type === "delEntry") st.entries = st.entries.filter(x => x.id !== op.id);
  else if (op.type === "replaceAll") { st.children = op.data.children.slice(); st.entries = op.data.entries.slice(); }
  return st;
}
const store = {
  putKid(c){ queue({ type: "putKid", kid: c }); applyOp(state, { type: "putKid", kid: c }); cacheLocal(); },
  delKid(id){ applyOp(state, { type: "delKid", id }); queue({ type: "delKid", id }); },
  putPatches(patches){ applyOp(state, { type: "putEntries", entries: patches }); queue({ type: "putEntries", entries: patches }); },
  delEntry(id){ applyOp(state, { type: "delEntry", id }); queue({ type: "delEntry", id }); },
  replaceAll(next){ applyOp(state, { type: "replaceAll", data: next }); queue({ type: "replaceAll", data: next }); }
};
function scheduleSync(ms){ clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync(){
  if (syncing || !conf || !conf.url || !conf.key) { updateSyncUI(); return; }
  if (navigator.onLine === false) { updateSyncUI(); return; }
  syncing = true; updateSyncUI();
  const sent = outbox.length, ops = outbox.slice(0, sent);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    const res = await fetch(conf.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: conf.key, by: meta.by || "", ops }), signal: ctl.signal, redirect: "follow" });
    clearTimeout(t);
    const r = await res.json();
    if (!r.ok) throw new Error(r.error === "bad_key" ? "The setup link is out of date — ask for a new one." : (r.error || "Sync failed"));
    outbox = outbox.slice(sent); writeJSON(OUTBOX_KEY, outbox);
    let fresh = { children: r.data.children.sort((a, b) => (a.created || 0) - (b.created || 0)), entries: r.data.entries };
    for (const op of outbox) fresh = applyOp(fresh, op); // changes made while this sync was running
    state = fresh; cacheLocal();
    meta.lastSync = Date.now(); meta.sheetUrl = r.data.url || meta.sheetUrl; writeJSON(META_KEY, meta);
    lastError = "";
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#settings .kid-edit");
    if (!typing) { renderAll(); if ($("#settings").open) { renderKidEdit(); fillBulkKid(); } } else renderCards();
  } catch (e) {
    lastError = e.name === "AbortError" ? "The Google Sheet took too long to answer." : (e instanceof TypeError ? "No connection to Google right now." : String(e.message || e));
  } finally {
    syncing = false; updateSyncUI();
    if (outbox.length && !lastError) scheduleSync(300);
  }
}
function ago(t){
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(t).toLocaleDateString();
}
function setStatus(){ updateSyncUI(); }
function updateSyncUI(){
  const n = outbox.length;
  let t;
  if (!conf) t = n ? `Not connected to a Google Sheet. ${n} change${n === 1 ? "" : "s"} saved on this phone will sync once you connect (Settings › Sync).` : "Saved on this phone. Connect a Google Sheet in Settings › Sync to share with another phone.";
  else if (syncing) t = "Syncing…";
  else if (lastError) t = `${lastError} ${n ? `${n} change${n === 1 ? "" : "s"} waiting; they'll sync automatically.` : "Everything on this phone is saved."}`;
  else if (navigator.onLine === false) t = `Offline. ${n ? `${n} change${n === 1 ? "" : "s"} waiting to sync.` : "Showing data from the last sync."}`;
  else t = n ? `${n} change${n === 1 ? "" : "s"} waiting to sync.` : `Synced ${ago(meta.lastSync)}.`;
  $("#syncStatus").textContent = t;
  const ss = $("#syncState"); if (ss) ss.textContent = t;
  const a = $("#sheetLink"); if (a) { a.hidden = !meta.sheetUrl; if (meta.sheetUrl) a.href = meta.sheetUrl; }
  const cs = $("#connState"); if (cs) cs.textContent = conf ? "Connected to your Google Sheet." : "Not connected.";
  const dc = $("#disconnectBtn"); if (dc) dc.hidden = !conf;
}
function parseSetup(text){
  const m = /#setup=([A-Za-z0-9_\-=]+)/.exec(text || ""); if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const o = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
    return o && /^https:\/\/script\.google(usercontent)?\.com\//.test(o.url) && o.key ? { url: o.url, key: o.key } : null;
  } catch (e) { return null; }
}
function connect(c){ conf = c; writeJSON(CONF_KEY, conf); lastError = ""; updateSyncUI(); sync(); }
function initRemote(){
  const fromLink = parseSetup(location.hash);
  if (fromLink) { connect(fromLink); history.replaceState(null, "", location.pathname + location.search); }
  updateSyncUI(); sync();
  window.addEventListener("online", () => sync());
  window.addEventListener("offline", updateSyncUI);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) { if (outbox.length || Date.now() - meta.lastSync > 60000) sync(); else updateSyncUI(); } }, 30000);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
}

// ---------- rendering ----------
function renderAll(){
  const has = state.children.length > 0;
  $("#emptyState").hidden = has; $("#app").hidden = !has;
  if (!ui.addKid || !state.children.find(c => c.id === ui.addKid)) ui.addKid = state.children[0]?.id || null;
  $("#hLabel").textContent = `Height (${U().height})`;
  $("#wLabel").textContent = `Weight (${U().weight})`;
  $("#fHeight").placeholder = prefs.units === "metric" ? "e.g. 104.5" : "e.g. 41.1";
  $("#fWeight").placeholder = prefs.units === "metric" ? "e.g. 17.2" : "e.g. 37.9";
  setSeg("#metricSeg", ui.metric); setSeg("#viewSeg", ui.view); setSeg("#unitSeg", prefs.units);
  $("#addPanel").hidden = readOnly; $("#roNote").hidden = !readOnly;
  document.querySelectorAll(".needs-write").forEach(el => el.hidden = readOnly);
  $("#emptyAdd").hidden = readOnly;
  if (!has) { if (chart) { chart.destroy(); chart = null; } return; }
  renderCards(); renderPicker(); updatePos(); renderChart(); renderHistory();
}
function setSeg(sel, v){ document.querySelectorAll(sel + " button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === String(v)))); }

function latestWith(c, metric){ const es = entriesOf(c.id).filter(e => metricValue(c, e, metric) != null); return es[es.length - 1] || null; }
function renderCards(){
  const box = $("#kidCards"); box.innerHTML = "";
  const today = todayISO();
  for (const c of state.children) {
    const el = document.createElement("article");
    el.className = "kid" + (ui.hidden.has(c.id) ? " off" : "");
    el.style.setProperty("--kc", childColor(c));
    const age = c.dob ? fmtAge(ageDaysOf(c, today)) : "";
    const rows = [];
    for (const m of ["height", "weight"]) {
      const e = latestWith(c, m);
      const label = m === "height" ? "Height" : "Weight";
      if (!e) { rows.push(`<dt>${label}</dt><dd class="muted">No entries</dd>`); continue; }
      const z = zFor(c, e, m), p = pctText(z);
      let extra;
      if (p) extra = `${p} percentile`;
      else if (m === "weight" && ageDaysOf(c, e.date) / DAYS_PER_MONTH >= 121) {
        const zb = zFor(c, e, "bmi"); const pb = pctText(zb);
        extra = pb ? `BMI ${metricValue(c, e, "bmi").toFixed(1)}, ${pb} percentile` : "No WHO weight chart after 10 y — add height the same day for BMI";
      } else if (!(c.sex === 1 || c.sex === 2)) extra = "Set sex in Settings for percentiles";
      else extra = "Outside WHO age range";
      rows.push(`<dt>${label}</dt><dd><b class="num">${fmtVal(m, metricValue(c, e, m === "height" ? "height" : "weight"))}</b><br><span class="small muted">${esc(extra)}</span></dd>`);
    }
    const lastDate = entriesOf(c.id).slice(-1)[0]?.date;
    el.innerHTML = `<h3>${esc(c.name || "Unnamed")} <span>${esc(age)}</span></h3>
      <button class="vis" type="button" aria-pressed="${!ui.hidden.has(c.id)}">${ui.hidden.has(c.id) ? "Show on chart" : "Hide from chart"}</button>
      <dl>${rows.join("")}</dl>${lastDate ? `<div class="when">Last measured ${fmtDate(lastDate)}</div>` : ""}`;
    el.querySelector(".vis").addEventListener("click", () => { ui.hidden.has(c.id) ? ui.hidden.delete(c.id) : ui.hidden.add(c.id); renderCards(); renderChart(); });
    box.appendChild(el);
  }
}
function renderPicker(){
  const box = $("#whoPicker"); box.innerHTML = "";
  for (const c of state.children) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = c.name || "Unnamed";
    b.style.setProperty("--kc", childColor(c)); b.setAttribute("aria-pressed", String(c.id === ui.addKid));
    b.addEventListener("click", () => { ui.addKid = c.id; renderPicker(); updatePos(); });
    box.appendChild(b);
  }
}
function updatePos(){
  const c = state.children.find(x => x.id === ui.addKid);
  const t = parseDate($("#fDate").value);
  if (!c || !c.dob || isNaN(t)) { $("#posWrap").hidden = true; return; }
  const days = ageDaysOf(c, $("#fDate").value);
  const show = days >= 0 && days < 1096; // under 3 years: position matters
  const wrap = $("#posWrap");
  if (show && wrap.hidden) $("#fPos").value = defaultPos(days);
  if (show && wrap.dataset.kid !== c.id) { $("#fPos").value = defaultPos(days); wrap.dataset.kid = c.id; }
  wrap.hidden = !show;
}

// ---------- chart ----------
function rangeWindow(kids){
  if (ui.range === "custom") {
    const c = ui.custom; if (!c || !(c.to > c.from)) return null;
    const pad = (c.to - c.from) * 0.03;
    return { xmin: Math.max(0, c.from - pad), xmax: c.to + pad };
  }
  if (ui.range !== "last4" && ui.range !== "last12") return null;
  const months = ui.range === "last4" ? 4 : 12;
  const c = kids.find(k => k.id === ui.rangeKid) || kids[0];
  if (!c) return null;
  const now = ageDaysOf(c, todayISO()) / 365.25, start = Math.max(0, now - months / 12), pad = (months / 12) * 0.04;
  return { xmin: Math.max(0, start - pad), xmax: now + pad, child: c, months };
}
function ageTicks(min, max){
  const span = max - min, out = [];
  if (span >= 4) {
    const step = span > 12 ? 2 : 1;
    for (let y = Math.ceil(min / step) * step; y <= max + 1e-9; y += step) out.push(y);
    return out;
  }
  const months = span * 12;
  const step = [1, 2, 3, 6, 12].find(s => months / s <= 6) || 12;
  for (let m = Math.ceil(min * 12 / step - 1e-9) * step; m <= max * 12 + 1e-9; m += step) out.push(m / 12);
  return out;
}
function ageTickLabel(v, span){
  if (span >= 4) return String(Math.round(v));
  const tm = Math.round(v * 12), y = Math.floor(tm / 12), m = tm % 12;
  if (!y) return `${m}m`;
  return m ? `${y}y ${m}m` : `${y}y`;
}
function renderRangeControls(kids, win){
  setSeg("#rangeSeg", ui.range);
  const ks = $("#rangeKidSeg");
  const showKid = (ui.range === "last4" || ui.range === "last12") && kids.length > 1;
  ks.hidden = !showKid;
  if (showKid) {
    const cur = (win && win.child) ? win.child.id : kids[0].id;
    ks.innerHTML = kids.map(c => `<button type="button" data-v="${c.id}" aria-pressed="${c.id === cur}">${esc(c.name || "Unnamed")}</button>`).join("");
    ks.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { ui.rangeKid = b.dataset.v; renderChart(); }));
  }
  $("#customRange").hidden = ui.range !== "custom";
}

function renderChart(){
  const metric = ui.metric, view = ui.view;
  const kids = state.children.filter(c => !ui.hidden.has(c.id) && c.dob);
  const sexes = [...new Set(kids.map(c => c.sex).filter(s => s === 1 || s === 2))];
  // reference sex for value curves
  let refSex = null;
  if (sexes.length === 1) refSex = sexes[0];
  else if (sexes.length === 2) { if (ui.refSex !== 1 && ui.refSex !== 2) ui.refSex = kids.find(c => c.sex === 1 || c.sex === 2).sex; refSex = ui.refSex; }
  $("#refPick").hidden = !(view === "values" && sexes.length === 2);
  setSeg("#refSeg", refSex);

  // points
  const pointSets = kids.map(c => {
    const pts = [];
    for (const e of entriesOf(c.id)) {
      const v = metricValue(c, e, metric); if (v == null) continue;
      const days = ageDaysOf(c, e.date); if (days < 0) continue;
      const z = zFor(c, e, metric);
      if (view === "pct") { if (z == null) continue; pts.push({ x: days / 365.25, y: Math.max(-3.6, Math.min(3.6, z)), c, e, v, z, days }); }
      else pts.push({ x: days / 365.25, y: disp(metric, v), c, e, v, z, days });
    }
    return { c, pts };
  });
  const allPts = pointSets.flatMap(s => s.pts);
  let xmin, xmax;
  if (allPts.length) {
    const lo = Math.min(...allPts.map(p => p.x)), hi = Math.max(...allPts.map(p => p.x));
    const span = Math.max(hi - lo, 1);
    xmin = Math.max(0, lo - span * 0.08); xmax = hi + span * 0.08;
    if (xmin < 0.6) xmin = 0;
  } else {
    const ages = kids.map(c => ageDaysOf(c, todayISO()) / 365.25).filter(a => a >= 0);
    xmin = 0; xmax = Math.max(1, ...(ages.length ? ages : [2]));
  }
  // zoom window
  const win = rangeWindow(kids);
  if (win) {
    xmin = win.xmin; xmax = win.xmax;
    if (win.child && (win.child.sex === 1 || win.child.sex === 2)) { refSex = win.child.sex; $("#refPick").hidden = true; }
  }
  renderRangeControls(kids, win);
  const limitMonths = metric === "weight" ? 120 : 228;
  const curveMaxX = Math.min(xmax, limitMonths / 12);

  // curves
  const curveSets = Z_LINES.map(() => []);
  if (view === "values" && refSex && xmin < curveMaxX) {
    const d0 = Math.floor(xmin * 365.25), d1 = Math.ceil(curveMaxX * 365.25);
    const step = Math.max(1, Math.round((d1 - d0) / 160));
    for (let d = d0; d <= d1 + step; d += step) {
      const dd = Math.min(d, d1);
      const p = refLMS(W, metric, refSex, dd); if (!p) { if (d >= d1) break; continue; }
      Z_LINES.forEach((zl, i) => curveSets[i].push({ x: dd / 365.25, y: disp(metric, valAtZ(zl.z, p)) }));
      if (d >= d1) break;
    }
  } else if (view === "pct") {
    Z_LINES.forEach((zl, i) => { curveSets[i].push({ x: xmin, y: zl.z }, { x: xmax, y: zl.z }); });
  }
  // fit the value axis to what is inside the window
  let yRange = {};
  if (win && view === "values") {
    const ys = [];
    allPts.forEach(p => { if (p.x >= xmin && p.x <= xmax) ys.push(p.y); });
    curveSets.forEach(cs => cs.forEach(p => { if (p.x >= xmin && p.x <= xmax) ys.push(p.y); }));
    if (ys.length) { const lo = Math.min(...ys), hi = Math.max(...ys), pad = Math.max((hi - lo) * 0.08, 0.5); const st = hi - lo > 20 ? 5 : hi - lo > 8 ? 2 : hi - lo > 3 ? 1 : 0.5; yRange = { min: Math.floor((lo - pad) / st) * st, max: Math.ceil((hi + pad) / st) * st }; }
  }
  const inWin = allPts.filter(p => p.x >= xmin && p.x <= xmax).length;
  const span = xmax - xmin;
  const curveC = cssVar("--curve"), medC = cssVar("--median"), bo = cssVar("--band-outer"), bi = cssVar("--band-inner");
  const datasets = Z_LINES.map((zl, i) => ({
    label: zl.label, data: curveSets[i], isCurve: true, pointRadius: 0, pointHitRadius: 0, borderWidth: i === 2 ? 1.6 : 1,
    borderColor: i === 2 ? medC : curveC, borderDash: i === 2 ? [] : [4, 3], tension: 0.2,
    fill: i === 4 ? { target: 0 } : i === 3 ? { target: 1 } : false,
    backgroundColor: i === 4 ? bo : i === 3 ? bi : "transparent", order: 10
  }));
  for (const s of pointSets) {
    const col = childColor(s.c);
    datasets.push({ label: s.c.name || "Unnamed", data: s.pts, borderColor: col, backgroundColor: col, pointRadius: 4, pointHoverRadius: 6,
      pointHitRadius: 10, borderWidth: 2.2, tension: 0, fill: false, order: 1 });
  }

  const ink = cssVar("--ink"), muted = cssVar("--muted"), line = cssVar("--line"), surface = cssVar("--surface");
  const labelPlugin = {
    id: "curveLabels",
    afterDatasetsDraw(ch){
      const { ctx, chartArea } = ch; ctx.save(); ctx.font = "11px " + cssVar("--font-body"); ctx.fillStyle = muted; ctx.textBaseline = "middle";
      ch.data.datasets.forEach((ds, i) => {
        if (!ds.isCurve || !ds.data.length) return;
        const meta = ch.getDatasetMeta(i); const last = meta.data[meta.data.length - 1]; if (!last) return;
        if (last.y < chartArea.top - 2 || last.y > chartArea.bottom + 2) return;
        ctx.fillText(ds.label, Math.min(last.x + 4, chartArea.right + 4), last.y);
      });
      ctx.restore();
    }
  };
  const yTitle = view === "pct" ? "Percentile" : `${metric === "height" ? "Height" : metric === "weight" ? "Weight" : "BMI"} (${U()[metric]})`;
  const cfg = {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: true,
      layout: { padding: { right: 34 } },
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: { type: "linear", min: xmin, max: xmax, title: { display: true, text: span >= 4 ? "Age (years)" : "Age", color: muted },
          afterBuildTicks: ax => { ax.ticks = ageTicks(xmin, xmax).map(v => ({ value: v })); },
          ticks: { color: muted, autoSkip: false, maxRotation: 0, callback: v => ageTickLabel(v, span) }, grid: { color: line } },
        y: view === "pct"
          ? { min: -3.6, max: 3.6, title: { display: true, text: yTitle, color: muted }, grid: { color: line },
              afterBuildTicks: ax => { ax.ticks = Z_LINES.map(z => ({ value: z.z })).concat([{ value: -3.09 }, { value: 3.09 }]); },
              ticks: { color: muted, autoSkip: false, callback: v => v === -3.09 ? "0.1st" : v === 3.09 ? "99.9th" : (Z_LINES.find(z => z.z === v) || {}).label } }
          : { ...yRange, title: { display: true, text: yTitle, color: muted }, ticks: { color: muted }, grid: { color: line } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: it => !it.dataset.isCurve,
          backgroundColor: surface, titleColor: ink, bodyColor: ink, borderColor: line, borderWidth: 1, padding: 10,
          titleFont: { family: cssVar("--font-body"), weight: "700" }, bodyFont: { family: cssVar("--font-body") },
          callbacks: {
            title: items => { const r = items[0]?.raw; return r ? `${fmtDate(r.e.date)} · ${fmtAge(r.days)}` : ""; },
            label: it => { const r = it.raw; const p = pctText(r.z); return `${r.c.name}: ${fmtVal(metric, r.v)}${p ? ` — ${p} percentile` : ""}`; }
          }
        }
      }
    },
    plugins: [labelPlugin]
  };
  $("#legend").innerHTML = kids.map(c => `<span style="--kc:${childColor(c)}"><i></i>${esc(c.name || "Unnamed")}</span>`).join("");
  if (chart) chart.destroy();
  if (typeof Chart === "undefined") { $("#chartNote").textContent = "The chart library didn't load. Check your connection and reopen the page."; return; }
  chart = new Chart($("#chart"), cfg);

  // note
  const notes = [];
  if (win && allPts.length && !inWin) notes.push(win.child ? `No ${metric === "bmi" ? "BMI values" : metric + " measurements"} for ${win.child.name} in the last ${win.months === 12 ? "12 months" : win.months + " months"}.` : "No measurements in this age range.");
  if (!allPts.length) notes.push(view === "pct" ? "No measurements with a WHO percentile yet for this view." : "No measurements yet. Add one below or import history in Settings.");
  if (metric === "weight" && xmax * 12 > 120) notes.push("WHO weight-for-age stops at 10 years; use BMI after that.");
  if (metric === "bmi") notes.push("BMI uses entries where height and weight were measured on the same day.");
  if (view === "values" && sexes.length === 2 && !(win && win.child)) notes.push("Curves are sex-specific: read each child against their own sex's curves, or use the Percentiles view to compare both directly.");
  if (view === "values" && !refSex) notes.push("Set each child's sex in Settings to show WHO curves.");
  if (view === "values" && win && win.child && refSex) notes.push(`WHO curves for ${refSex === 1 ? "boys" : "girls"}.`);
  if (view === "values" && refSex) notes.push("Shaded: 3rd–97th and 15th–85th percentile; solid line is the median.");
  $("#chartNote").textContent = notes.join(" ");
}

// ---------- history ----------
function renderHistory(){
  const box = $("#history");
  const openIds = new Set([...box.querySelectorAll("details.hist[open]")].map(x => x.dataset.kid));
  box.innerHTML = "";
  for (const c of state.children) {
    const es = entriesOf(c.id).slice().reverse();
    const d = document.createElement("details"); d.className = "hist"; d.dataset.kid = c.id; d.open = openIds.has(c.id);
    d.innerHTML = `<summary><span style="color:${childColor(c)}">${esc(c.name || "Unnamed")}</span><span class="muted small" style="margin-left:auto;margin-right:10px;font-weight:400">${es.length} ${es.length === 1 ? "entry" : "entries"}</span></summary>`;
    if (!es.length) { d.insertAdjacentHTML("beforeend", `<p class="muted small">No measurements yet.</p>`); box.appendChild(d); continue; }
    const rows = es.map(e => {
      const days = ageDaysOf(c, e.date);
      const cell = m => {
        const raw = m === "height" ? (e.h > 0 ? e.h : null) : (e.w > 0 ? e.w : null);
        if (raw == null) return `<td class="muted">–</td>`;
        const p = pctText(zFor(c, e, m));
        const posNote = m === "height" && days < 1096 ? ` <span class="p">${(e.pos || defaultPos(days)) === "L" ? "lying" : "standing"}</span>` : "";
        return `<td>${disp(m, raw).toFixed(1)}${posNote}<br><span class="p">${p ? p : "–"}</span></td>`;
      };
      return `<tr><td>${fmtDate(e.date)}<br><span class="p">${fmtAge(days)}</span></td>${cell("height")}${cell("weight")}<td>${readOnly ? "" : `<button type="button" data-del="${e.id}">Delete</button>`}</td></tr>`;
    }).join("");
    d.insertAdjacentHTML("beforeend", `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Height (${U().height})</th><th>Weight (${U().weight})</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`);
    d.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm"; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = "Delete"; } }, 3000); return; }
      store.delEntry(b.dataset.del); renderAll();
    }));
    box.appendChild(d);
  }
}

// ---------- adding data ----------
function makePatch(childId, date, h, w, pos){
  const p = { id: entryId(childId, date), childId, date };
  if (h != null) { p.h = h; p.pos = pos; } if (w != null) p.w = w;
  return p;
}
function upsertEntry(childId, date, h, w, pos){
  const ex = state.entries.find(e => e.id === entryId(childId, date));
  store.putPatches([makePatch(childId, date, h, w, pos)]);
  return ex ? "updated" : "added";
}
function checkValues(c, date, hDisp, wDisp){
  const t = parseDate(date);
  if (isNaN(t)) return { err: "Enter a valid date." };
  if (!c.dob || isNaN(parseDate(c.dob))) return { err: `Set ${c.name || "this child"}'s date of birth in Settings first.` };
  if (t < parseDate(c.dob)) return { err: "That date is before the date of birth." };
  if (t > parseDate(todayISO()) + 864e5) return { err: "That date is in the future." };
  const h = hDisp === "" || hDisp == null ? null : U().hIn(parseFloat(String(hDisp).replace(",", ".")));
  const w = wDisp === "" || wDisp == null ? null : U().wIn(parseFloat(String(wDisp).replace(",", ".")));
  if (h == null && w == null) return { err: "Enter a height, a weight, or both." };
  if (h != null && !(h >= 30 && h <= 230)) return { err: `Height ${hDisp} ${U().height} looks wrong — check the units.` };
  if (w != null && !(w >= 0.5 && w <= 250)) return { err: `Weight ${wDisp} ${U().weight} looks wrong — check the units.` };
  return { h: h != null ? Math.round(h * 100) / 100 : null, w: w != null ? Math.round(w * 1000) / 1000 : null };
}
$("#addForm").addEventListener("submit", ev => {
  ev.preventDefault();
  const msg = $("#addMsg"); msg.className = "msg";
  const c = state.children.find(x => x.id === ui.addKid);
  if (!c) { msg.textContent = "Pick a child."; msg.classList.add("err"); return; }
  const date = $("#fDate").value;
  const r = checkValues(c, date, $("#fHeight").value.trim(), $("#fWeight").value.trim());
  if (r.err) { msg.textContent = r.err; msg.classList.add("err"); return; }
  const days = ageDaysOf(c, date);
  const pos = $("#posWrap").hidden ? defaultPos(days) : $("#fPos").value;
  const how = upsertEntry(c.id, date, r.h, r.w, pos);
  $("#fHeight").value = ""; $("#fWeight").value = "";
  msg.textContent = how === "updated" ? `Updated ${c.name}'s entry for ${fmtDate(date)}.` : `Saved for ${c.name}.`;
  renderAll();
});
$("#fDate").addEventListener("change", updatePos);

// ---------- settings ----------
function renderKidEdit(){
  const box = $("#kidEditList"); box.innerHTML = "";
  state.children.forEach(c => {
    const el = document.createElement("div"); el.className = "kid-edit"; el.style.setProperty("--kc", childColor(c));
    el.innerHTML = `<label class="f full">Name<input type="text" data-k="name" value="${esc(c.name || "")}" autocomplete="off"></label>
      <label class="f">Sex<select data-k="sex"><option value="">Choose…</option><option value="1"${c.sex === 1 ? " selected" : ""}>Boy</option><option value="2"${c.sex === 2 ? " selected" : ""}>Girl</option></select></label>
      <label class="f">Date of birth<input type="date" data-k="dob" value="${esc(c.dob || "")}"></label>
      <div class="full" style="display:flex;justify-content:flex-end"><button type="button" class="ghost danger" data-rm>Remove child and their data</button></div>`;
    if (readOnly) { el.querySelectorAll("input,select,button").forEach(x => x.disabled = true); el.querySelector("[data-rm]").hidden = true; }
    el.querySelectorAll("[data-k]").forEach(inp => inp.addEventListener("change", () => {
      const k = inp.dataset.k;
      const n = { ...c };
      if (k === "sex") n.sex = inp.value ? +inp.value : null;
      else if (k === "dob") { if (isNaN(parseDate(inp.value))) return; n.dob = inp.value; }
      else n.name = inp.value.trim();
      Object.assign(c, n); store.putKid(n); renderAll(); fillBulkKid();
    }));
    const rm = el.querySelector("[data-rm]");
    rm.addEventListener("click", () => {
      if (rm.dataset.armed !== "1") { rm.dataset.armed = "1"; rm.textContent = "Tap again to remove"; return; }
      store.delKid(c.id); renderKidEdit(); renderAll(); fillBulkKid();
    });
    box.appendChild(el);
  });
}
function fillBulkKid(){
  const s = $("#bulkKid"); const cur = s.value;
  s.innerHTML = state.children.map(c => `<option value="${c.id}">${esc(c.name || "Unnamed")}</option>`).join("");
  if (state.children.find(c => c.id === cur)) s.value = cur;
}
function openSettings(){ $("#byName").value = meta.by || ""; updateSyncUI(); renderKidEdit(); fillBulkKid(); setSeg("#unitSeg", prefs.units); $("#settings").showModal(); }
$("#openSettings").addEventListener("click", openSettings);
$("#emptyAdd").addEventListener("click", () => { if (!state.children.length) addChild(); openSettings(); });
$("#closeSettings").addEventListener("click", () => $("#settings").close());
function addChild(){
  const used = new Set(state.children.map(c => c.color));
  let color = 0; while (used.has(color) && color < 4) color++;
  store.putKid({ id: uid(), name: `Child ${state.children.length + 1}`, sex: null, dob: "", color: color % 4, created: Date.now() });
}
$("#addKid").addEventListener("click", () => { addChild(); renderKidEdit(); fillBulkKid(); renderAll(); });
document.querySelectorAll("#unitSeg button").forEach(b => b.addEventListener("click", () => { prefs.units = b.dataset.v; try { localStorage.setItem("growth-units", prefs.units); } catch (e) {} setSeg("#unitSeg", prefs.units); renderAll(); }));
document.querySelectorAll("#metricSeg button").forEach(b => b.addEventListener("click", () => { ui.metric = b.dataset.v; setSeg("#metricSeg", ui.metric); renderChart(); }));
document.querySelectorAll("#viewSeg button").forEach(b => b.addEventListener("click", () => { ui.view = b.dataset.v; setSeg("#viewSeg", ui.view); renderChart(); }));
document.querySelectorAll("#rangeSeg button").forEach(b => b.addEventListener("click", () => {
  ui.range = b.dataset.v;
  if (ui.range === "custom" && !ui.custom && chart) {
    const x = chart.scales.x; const toYM = v => [Math.floor(v), Math.round((v - Math.floor(v)) * 12) % 12];
    const [fy, fm] = toYM(Math.max(0, x.min)), [ty, tm] = toYM(x.max);
    $("#cFromY").value = fy; $("#cFromM").value = fm; $("#cToY").value = ty; $("#cToM").value = tm; readCustom();
  }
  renderChart();
}));
function readCustom(){
  const n = id => Math.max(0, parseFloat($(id).value) || 0);
  const from = n("#cFromY") + Math.min(11, n("#cFromM")) / 12, to = n("#cToY") + Math.min(11, n("#cToM")) / 12;
  ui.custom = { from, to };
  $("#customMsg").textContent = to > from ? "" : "The end age must be after the start age.";
}
["#cFromY", "#cFromM", "#cToY", "#cToM"].forEach(id => $(id).addEventListener("input", () => { readCustom(); renderChart(); }));
document.querySelectorAll("#refSeg button").forEach(b => b.addEventListener("click", () => { ui.refSex = +b.dataset.v; renderChart(); }));

$("#bulkGo").addEventListener("click", () => {
  const msg = $("#bulkMsg"); msg.className = "msg";
  const c = state.children.find(x => x.id === $("#bulkKid").value);
  if (!c) { msg.textContent = "Add a child first."; msg.classList.add("err"); return; }
  const lines = $("#bulkText").value.split(/\r?\n/);
  let ok = 0; const skipped = []; const patches = [];
  lines.forEach((ln, i) => {
    if (!ln.trim()) return;
    const parts = ln.split(/\s*[,;\t]\s*/);
    const date = (parts[0] || "").trim(); const iso = isNaN(parseDate(date)) ? null : isoFromUTC(parseDate(date));
    if (!iso) { skipped.push(`line ${i + 1}: date not recognised (use YYYY-MM-DD)`); return; }
    const r = checkValues(c, iso, (parts[1] || "").trim(), (parts[2] || "").trim());
    if (r.err) { skipped.push(`line ${i + 1}: ${r.err}`); return; }
    patches.push(makePatch(c.id, iso, r.h, r.w, defaultPos(ageDaysOf(c, iso)))); ok++;
  });
  if (patches.length) { store.putPatches(patches); renderAll(); }
  msg.textContent = `Imported ${ok} ${ok === 1 ? "line" : "lines"} for ${c.name}.` + (skipped.length ? ` Skipped ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? ` and ${skipped.length - 4} more` : ""}.` : "");
  if (skipped.length) msg.classList.add("err");
  if (ok && !skipped.length) $("#bulkText").value = "";
});

$("#exportBtn").addEventListener("click", () => {
  const data = JSON.stringify({ v: 2, units: prefs.units, children: state.children, entries: state.entries }, null, 1);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = `growth-backup-${todayISO()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("#backupMsg").textContent = "Backup saved to Downloads.";
});
$("#syncNow").addEventListener("click", () => { lastError = ""; sync(); });
$("#connectBtn").addEventListener("click", () => {
  const c = parseSetup($("#setupInput").value.trim());
  const msg = $("#connMsg"); msg.className = "msg";
  if (!c) { msg.textContent = "That doesn't look like a setup link. It should contain #setup="; msg.classList.add("err"); return; }
  $("#setupInput").value = ""; msg.textContent = ""; connect(c);
});
$("#disconnectBtn").addEventListener("click", () => {
  const b = $("#disconnectBtn");
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to disconnect"; return; }
  b.dataset.armed = ""; b.textContent = "Disconnect"; conf = null; try { localStorage.removeItem(CONF_KEY); } catch (e) {} updateSyncUI();
});
$("#byName").addEventListener("change", () => { meta.by = $("#byName").value.trim(); writeJSON(META_KEY, meta); });
$("#importFile").addEventListener("change", ev => {
  const f = ev.target.files[0]; const msg = $("#backupMsg"); msg.className = "msg"; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const p = JSON.parse(rd.result);
      if (!validState(p)) throw new Error("bad");
      store.replaceAll(normalise(p)); renderKidEdit(); fillBulkKid(); renderAll();
      msg.textContent = `Restored ${state.children.length} children and ${state.entries.length} entries.`;
    } catch (e) { msg.textContent = "That file isn't a growth tracker backup."; msg.classList.add("err"); }
    ev.target.value = "";
  };
  rd.readAsText(f);
});

// theme changes: redraw chart colours
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll()); } catch (e) {}

// ---------- boot ----------
$("#fDate").value = todayISO();
$("#fDate").max = todayISO();
loadLocal();
setStatus("loading");
renderAll();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (chart) renderChart(); });
initRemote();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
