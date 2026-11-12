// Box Stock API: the Google Sheet this script is bound to holds the counts.
// Deploy as a web app, Execute as: Me, Who has access: Anyone. The key in
// Script Properties is what stops a stranger with the URL from writing.

const TABS = {
  Boxes: ['id', 'name', 'order'],
  Items: ['id', 'box', 'name', 'unit', 'qty', 'min', 'updated'],
  Log: ['time', 'box', 'item', 'change', 'qty after'],
};

// Run once from the editor. Safe to run again: it only adds what is missing.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of Object.keys(TABS)) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(TABS[name]);
      sh.setFrozenRows(1);
    }
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  Logger.log('Key: ' + props.getProperty('KEY'));
}

// Run to cut off every old tag link. Write the new links to the tags after.
function newKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  setup();
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: 'request body is not JSON' });
  }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) return json({ error: 'not set up: run setup() in the script editor', code: 'not_setup' });
  if (body.k !== key) return json({ error: 'tag code does not match', code: 'bad_key' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return json({ error: 'sheet busy, retrying', code: 'busy' });
  try {
    // A retry after lost signal carries the same rid, so it is applied once.
    const cache = CacheService.getScriptCache();
    if (body.rid && cache.get('rid:' + body.rid)) return json(state());
    const op = OPS[body.op];
    if (!op) throw new Error('unknown op "' + body.op + '"');
    op(body);
    if (body.rid) cache.put('rid:' + body.rid, '1', 21600);
    return json(state());
  } catch (err) {
    return json({ error: err.message });
  } finally {
    lock.releaseLock();
  }
}

const OPS = {
  read() {},

  bump(b) {
    const d = Math.trunc(Number(b.delta));
    if (!d || Math.abs(d) > 1000) throw new Error('delta ' + b.delta + ' is not a whole number from -1000 to 1000');
    const t = table('Items');
    const r = find(t, b.id, 'item');
    const qty = Math.max(0, num(r.obj.qty) + d);
    write(t, r, { qty: qty, updated: new Date() });
    log(r.obj.box, r.obj.name, qty - num(r.obj.qty), qty);
  },

  addBox(b) {
    const name = text(b.name, 'box name', 60);
    const t = table('Boxes');
    const ids = new Set(t.rows.map(r => String(r.obj.id)));
    const base = slug(name) || 'box';
    let id = base;
    for (let n = 2; ids.has(id); n++) id = base + '-' + n;
    const order = t.rows.reduce((m, r) => Math.max(m, num(r.obj.order)), 0) + 1;
    append(t, { id: id, name: name, order: order });
  },

  addItem(b) {
    find(table('Boxes'), b.box, 'box');
    const name = text(b.name, 'item name', 80);
    const qty = whole(b.qty, 'count') || 0;
    const min = b.min === '' || b.min == null ? '' : whole(b.min, 'low level');
    const id = 'i' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    append(table('Items'), { id: id, box: b.box, name: name, unit: String(b.unit || '').trim().slice(0, 20), qty: qty, min: min, updated: new Date() });
    log(b.box, name, qty, qty);
  },

  editItem(b) {
    const t = table('Items');
    const r = find(t, b.id, 'item');
    const f = {};
    if ('name' in b) f.name = text(b.name, 'item name', 80);
    if ('min' in b) f.min = b.min === '' || b.min == null ? '' : whole(b.min, 'low level');
    write(t, r, f);
  },

  deleteItem(b) {
    const t = table('Items');
    const r = find(t, b.id, 'item');
    t.sh.deleteRow(r.row);
    log(r.obj.box, r.obj.name, -num(r.obj.qty), 0);
  },

  deleteBox(b) {
    const t = table('Boxes');
    const r = find(t, b.id, 'box');
    const n = table('Items').rows.filter(i => String(i.obj.box) === String(b.id)).length;
    if (n) throw new Error('box "' + r.obj.name + '" still lists ' + n + ' items: delete them first');
    t.sh.deleteRow(r.row);
  },
};

function state() {
  const iso = v => (v instanceof Date ? v.toISOString() : String(v || ''));
  return {
    boxes: table('Boxes').rows.map(r => ({ id: String(r.obj.id), name: String(r.obj.name), order: num(r.obj.order) })),
    items: table('Items').rows.map(r => ({
      id: String(r.obj.id), box: String(r.obj.box), name: String(r.obj.name), unit: String(r.obj.unit || ''),
      qty: num(r.obj.qty), min: r.obj.min === '' || r.obj.min == null ? null : num(r.obj.min), updated: iso(r.obj.updated),
    })),
    sheet: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  };
}

function table(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('tab "' + name + '" is missing: run setup() in the script editor');
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  const rows = values
    .map((v, i) => ({ row: i + 2, obj: Object.fromEntries(head.map((h, j) => [h, v[j]])) }))
    .filter(r => String(r.obj.id || '') !== '');
  return { sh: sh, head: head, rows: rows };
}

function find(t, id, what) {
  const r = t.rows.find(x => String(x.obj.id) === String(id));
  if (!r) throw new Error('no ' + what + ' with id "' + id + '": it may have been deleted');
  return r;
}

function write(t, r, fields) {
  for (const k of Object.keys(fields)) {
    const col = t.head.indexOf(k);
    if (col < 0) throw new Error('tab is missing the "' + k + '" column');
    t.sh.getRange(r.row, col + 1).setValue(fields[k]);
  }
}

function append(t, obj) {
  t.sh.appendRow(t.head.map(h => (h in obj ? obj[h] : '')));
}

function log(box, item, change, after) {
  append(table('Log'), { time: new Date(), box: box, item: item, change: change, 'qty after': after });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function whole(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(what + ' ' + v + ' is not a whole number from 0 to 100000');
  return n;
}

function text(v, what, max) {
  const s = String(v || '').trim();
  if (!s) throw new Error(what + ' is empty');
  if (s.length > max) throw new Error(what + ' is longer than ' + max + ' characters');
  return s;
}

function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
