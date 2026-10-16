/**
 * Growth tracker — Google Sheets backend.
 * Paste your spreadsheet's ID below (the long code in its URL between /d/ and /edit).
 */
const SHEET_ID = 'PASTE_SPREADSHEET_ID_HERE';

const KIDS = 'Children';
const MEAS = 'Measurements';
const KID_COLS = ['id', 'name', 'sex', 'date_of_birth', 'color', 'created'];
const MEAS_COLS = ['id', 'child_id', 'child_name', 'date', 'height_cm', 'weight_kg', 'height_position', 'updated_by', 'updated_at'];
const TEXT_COLS = ['id', 'child_id', 'date', 'date_of_birth'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Growth tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

function sheet_(name, cols) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(sh, cols) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = ss_().getSpreadsheetTimeZone();
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (r) {
    const o = {};
    cols.forEach(function (c, j) {
      let v = r[j];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      o[c] = v === '' ? null : v;
    });
    return o;
  }).filter(function (o) { return o.id; });
}

function num_(v) {
  if (v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return n > 0 ? n : null;
}

function getData() {
  const kids = readRows_(sheet_(KIDS, KID_COLS), KID_COLS).map(function (k) {
    const s = String(k.sex || '').toLowerCase();
    return {
      id: String(k.id), name: String(k.name || ''),
      sex: s === 'boy' || s === '1' ? 1 : s === 'girl' || s === '2' ? 2 : null,
      dob: k.date_of_birth ? String(k.date_of_birth) : '',
      color: Number(k.color) || 0, created: Number(k.created) || 0
    };
  });
  const entries = readRows_(sheet_(MEAS, MEAS_COLS), MEAS_COLS).map(function (e) {
    const p = String(e.height_position || '').toLowerCase();
    return {
      id: String(e.id), childId: String(e.child_id || ''), date: String(e.date || ''),
      h: num_(e.height_cm), w: num_(e.weight_kg),
      pos: p === 'lying' || p === 'l' ? 'L' : p === 'standing' || p === 'h' ? 'H' : null
    };
  }).filter(function (e) { return e.childId && /^\d{4}-\d{2}-\d{2}$/.test(e.date); });
  return { children: kids, entries: entries, url: ss_().getUrl() };
}

function kidRow_(c) {
  return { id: String(c.id), name: String(c.name || ''), sex: c.sex === 1 ? 'boy' : c.sex === 2 ? 'girl' : '',
    date_of_birth: c.dob || '', color: Number(c.color) || 0, created: Number(c.created) || Date.now() };
}

function entryRow_(e, names) {
  return { id: String(e.id), child_id: String(e.childId), child_name: names[e.childId] || '', date: String(e.date),
    height_cm: e.h > 0 ? e.h : '', weight_kg: e.w > 0 ? e.w : '',
    height_position: e.h > 0 ? (e.pos === 'L' ? 'lying' : e.pos === 'H' ? 'standing' : '') : '',
    updated_by: Session.getActiveUser().getEmail() || '', updated_at: new Date() };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// Insert or replace rows by id (column A)
function upsert_(sh, cols, objs) {
  const last = sh.getLastRow();
  const index = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(function (r, i) { if (r[0]) index[r[0]] = i + 2; });
  const formats = [cols.map(function (c) { return TEXT_COLS.indexOf(c) >= 0 ? '@' : 'General'; })];
  const fresh = [];
  objs.forEach(function (o) {
    const vals = [cols.map(function (c) { return o[c] === null || o[c] === undefined ? '' : o[c]; })];
    const row = index[o.id];
    if (row) { const r = sh.getRange(row, 1, 1, cols.length); r.setNumberFormats(formats); r.setValues(vals); }
    else fresh.push(vals[0]);
  });
  if (fresh.length) {
    const r = sh.getRange(sh.getLastRow() + 1, 1, fresh.length, cols.length);
    r.setNumberFormats(fresh.map(function () { return formats[0]; }));
    r.setValues(fresh);
  }
}

// Delete rows whose column `colIdx` (1-based) matches
function spareRow_(sh) { // Sheets refuses to delete every non-frozen row, so keep one blank row
  if (sh.getMaxRows() <= sh.getLastRow()) sh.insertRowAfter(sh.getLastRow());
}

function deleteWhere_(sh, colIdx, test) {
  const last = sh.getLastRow();
  if (last < 2) return;
  spareRow_(sh);
  const vals = sh.getRange(2, colIdx, last - 1, 1).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) if (test(vals[i][0])) sh.deleteRow(i + 2);
}

function names_() {
  const m = {};
  readRows_(sheet_(KIDS, KID_COLS), KID_COLS).forEach(function (k) { m[String(k.id)] = String(k.name || ''); });
  return m;
}

function putKid(c) {
  return withLock_(function () {
    upsert_(sheet_(KIDS, KID_COLS), KID_COLS, [kidRow_(c)]);
    // keep child_name column readable in the Measurements sheet
    const sh = sheet_(MEAS, MEAS_COLS), last = sh.getLastRow();
    if (last >= 2) {
      const ids = sh.getRange(2, 2, last - 1, 1).getDisplayValues();
      const names = sh.getRange(2, 3, last - 1, 1).getValues();
      let changed = false;
      ids.forEach(function (r, i) { if (r[0] === String(c.id) && names[i][0] !== (c.name || '')) { names[i][0] = c.name || ''; changed = true; } });
      if (changed) sh.getRange(2, 3, last - 1, 1).setValues(names);
    }
    return true;
  });
}

function delKid(id) {
  return withLock_(function () {
    deleteWhere_(sheet_(MEAS, MEAS_COLS), 2, function (v) { return v === String(id); });
    deleteWhere_(sheet_(KIDS, KID_COLS), 1, function (v) { return v === String(id); });
    return true;
  });
}

function putEntries(list) {
  return withLock_(function () {
    const names = names_();
    upsert_(sheet_(MEAS, MEAS_COLS), MEAS_COLS, list.map(function (e) { return entryRow_(e, names); }));
    return true;
  });
}

function delEntry(id) {
  return withLock_(function () {
    deleteWhere_(sheet_(MEAS, MEAS_COLS), 1, function (v) { return v === String(id); });
    return true;
  });
}

function replaceAll(data) {
  return withLock_(function () {
    const k = sheet_(KIDS, KID_COLS), m = sheet_(MEAS, MEAS_COLS);
    [k, m].forEach(function (sh) { if (sh.getLastRow() >= 2) { spareRow_(sh); sh.deleteRows(2, sh.getLastRow() - 1); } });
    upsert_(k, KID_COLS, data.children.map(kidRow_));
    const names = {};
    data.children.forEach(function (c) { names[c.id] = c.name || ''; });
    upsert_(m, MEAS_COLS, data.entries.map(function (e) { return entryRow_(e, names); }));
    return true;
  });
}
