// Stock rules, kept apart from the page so they can be tested in Node.
// The whole stock list is one JSON document: { boxes, items, kits, recent }.
// A kit is an install's standard parts list: { id, name, lines: [{ item, qty }] }.
// Every change is an op applied to it; `recent` holds the request ids
// already applied, so an op resent after lost signal counts once.
(function (root) {
  const RECENT = 300;

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  function text(v, what, max) {
    const s = String(v == null ? '' : v).trim();
    if (!s) throw new Error(what + ' is empty');
    if (s.length > max) throw new Error(what + ' is longer than ' + max + ' characters');
    return s;
  }

  function whole(v, what) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(what + ' ' + v + ' is not a whole number from 0 to 100000');
    return n;
  }

  function findItem(state, id) {
    const it = state.items.find(i => i.id === id);
    if (!it) throw new Error('no item with id "' + id + '": it may have been deleted');
    return it;
  }

  function findBox(state, id) {
    const b = state.boxes.find(x => x.id === id);
    if (!b) throw new Error('no box with id "' + id + '": it may have been deleted');
    return b;
  }

  function empty() {
    return { boxes: [], items: [], kits: [], recent: [] };
  }

  function findKit(state, id) {
    const k = state.kits.find(x => x.id === id);
    if (!k) throw new Error('no kit with id "' + id + '": it may have been deleted');
    return k;
  }

  const newIdOk = (id, prefix) => new RegExp('^' + prefix + '[0-9a-z]{6,16}$').test(String(id));

  function normalise(state) {
    const s = state && typeof state === 'object' ? state : {};
    return {
      boxes: Array.isArray(s.boxes) ? s.boxes : [],
      items: Array.isArray(s.items) ? s.items : [],
      kits: Array.isArray(s.kits) ? s.kits : [],
      recent: Array.isArray(s.recent) ? s.recent : [],
    };
  }

  // Applies one op to `state` in place and returns a line for the commit
  // message. Throws with a message a person can act on.
  const OPS = {
    bump(s, op) {
      const d = Math.trunc(Number(op.delta));
      if (!d || Math.abs(d) > 1000) throw new Error('delta ' + op.delta + ' is not a whole number from -1000 to 1000');
      const it = findItem(s, op.id);
      const before = num(it.qty);
      it.qty = Math.max(0, before + d);
      it.updated = op.at;
      const change = it.qty - before;
      return it.name + ' ' + (change >= 0 ? '+' : '') + change + ' = ' + it.qty;
    },

    addBox(s, op) {
      const name = text(op.name, 'box name', 60);
      const ids = new Set(s.boxes.map(b => b.id));
      const base = slug(name) || 'box';
      let id = base;
      for (let n = 2; ids.has(id); n++) id = base + '-' + n;
      const order = s.boxes.reduce((m, b) => Math.max(m, num(b.order)), 0) + 1;
      s.boxes.push({ id, name, order });
      op.result = id;
      return 'add box ' + name;
    },

    addItem(s, op) {
      findBox(s, op.box);
      const name = text(op.name, 'item name', 80);
      const qty = op.qty === '' || op.qty == null ? 0 : whole(op.qty, 'count');
      const min = op.min === '' || op.min == null ? null : whole(op.min, 'low level');
      const id = op.newId;
      if (!/^i[0-9a-z]{6,16}$/.test(String(id)) || s.items.some(i => i.id === id)) throw new Error('item id "' + id + '" is not usable');
      s.items.push({ id, box: op.box, name, unit: String(op.unit || '').trim().slice(0, 20), qty, min, updated: op.at });
      return 'add ' + name + ' = ' + qty;
    },

    editItem(s, op) {
      const it = findItem(s, op.id);
      if ('name' in op) it.name = text(op.name, 'item name', 80);
      if ('min' in op) it.min = op.min === '' || op.min == null ? null : whole(op.min, 'low level');
      return 'edit ' + it.name;
    },

    deleteItem(s, op) {
      const it = findItem(s, op.id);
      s.items = s.items.filter(i => i.id !== op.id);
      for (const k of s.kits) k.lines = k.lines.filter(l => l.item !== op.id);
      return 'delete ' + it.name;
    },

    // photo is the sha GitHub gave the image file, or null to clear it.
    setPhoto(s, op) {
      const it = findItem(s, op.id);
      if (op.photo !== null && !/^[0-9a-f]{40}$/.test(String(op.photo))) throw new Error('photo version "' + op.photo + '" is not a file sha');
      it.photo = op.photo;
      return (op.photo ? 'photo of ' : 'remove photo of ') + it.name;
    },

    // Sets each listed item to the counted number and stamps the box as checked.
    stocktake(s, op) {
      const b = findBox(s, op.box);
      const counts = op.counts && typeof op.counts === 'object' ? op.counts : {};
      const plan = Object.keys(counts).map(id => {
        const it = findItem(s, id);
        if (it.box !== op.box) throw new Error(it.name + ' is not in box "' + b.name + '"');
        return [it, whole(counts[id], it.name + ' count')];
      });
      const changes = [];
      for (const [it, n] of plan) {
        if (num(it.qty) !== n) changes.push(it.name + ' ' + num(it.qty) + ' to ' + n);
        it.qty = n;
        it.updated = op.at;
      }
      b.checked = op.at;
      return 'stocktake ' + b.name + (changes.length ? ': ' + changes.join(', ') : ': all counts right');
    },

    addKit(s, op) {
      const name = text(op.name, 'kit name', 60);
      if (!newIdOk(op.newId, 'k') || s.kits.some(k => k.id === op.newId)) throw new Error('kit id "' + op.newId + '" is not usable');
      s.kits.push({ id: op.newId, name, lines: [] });
      return 'add kit ' + name;
    },

    // qty 0 takes the item out of the kit.
    setKitLine(s, op) {
      const k = findKit(s, op.kit);
      const it = findItem(s, op.item);
      const qty = whole(op.qty, 'kit quantity');
      const line = k.lines.find(l => l.item === op.item);
      if (!qty) k.lines = k.lines.filter(l => l.item !== op.item);
      else if (line) line.qty = qty;
      else k.lines.push({ item: op.item, qty });
      return 'kit ' + k.name + ': ' + it.name + ' x' + qty;
    },

    deleteKit(s, op) {
      const k = findKit(s, op.id);
      s.kits = s.kits.filter(x => x.id !== op.id);
      return 'delete kit ' + k.name;
    },

    // Takes every line of the kit out of stock. A line short of stock takes
    // what is there. op.result records what was taken and what was short,
    // which is exactly what putBack needs to undo it.
    takeKit(s, op) {
      const k = findKit(s, op.kit);
      if (!k.lines.length) throw new Error('kit "' + k.name + '" has no parts listed');
      const taken = {}, short = {}, parts = [];
      for (const l of k.lines) {
        const it = s.items.find(i => i.id === l.item);
        if (!it) continue;
        const have = num(it.qty);
        const take = Math.min(have, l.qty);
        it.qty = have - take;
        it.updated = op.at;
        if (take) taken[it.id] = take;
        if (take < l.qty) short[it.id] = l.qty - take;
        parts.push(it.name + ' -' + take + ' = ' + it.qty + (take < l.qty ? ' (short ' + (l.qty - take) + ')' : ''));
      }
      op.result = { taken, short };
      return 'take kit ' + k.name + ': ' + parts.join(', ');
    },

    // Undoes a takeKit by adding back exactly what it took.
    putBack(s, op) {
      const k = findKit(s, op.kit);
      const taken = op.taken && typeof op.taken === 'object' ? op.taken : {};
      const plan = Object.keys(taken).map(id => [s.items.find(i => i.id === id), whole(taken[id], 'put back count')]).filter(([it]) => it);
      const parts = [];
      for (const [it, n] of plan) {
        it.qty = num(it.qty) + n;
        it.updated = op.at;
        parts.push(it.name + ' +' + n + ' = ' + it.qty);
      }
      return 'put back kit ' + k.name + ': ' + (parts.join(', ') || 'nothing');
    },

    deleteBox(s, op) {
      const b = findBox(s, op.id);
      const n = s.items.filter(i => i.box === op.id).length;
      if (n) throw new Error('box "' + b.name + '" still lists ' + n + ' items: delete them first');
      s.boxes = s.boxes.filter(x => x.id !== op.id);
      return 'delete box ' + b.name;
    },
  };

  // Applies ops in order to a copy of `state`. An op whose rid is already in
  // `recent` is skipped; an op that throws is reported and skipped.
  function apply(state, ops) {
    const s = normalise(JSON.parse(JSON.stringify(state)));
    const lines = [], errors = [];
    for (const op of ops) {
      if (op.rid && s.recent.includes(op.rid)) continue;
      const fn = OPS[op.op];
      try {
        if (!fn) throw new Error('unknown op "' + op.op + '"');
        lines.push(fn(s, op));
        if (op.rid) s.recent.unshift(op.rid);
      } catch (e) {
        errors.push({ op, message: e.message });
      }
    }
    s.recent = s.recent.slice(0, RECENT);
    return { state: s, lines, errors };
  }

  // Reads the stock file, applies the ops and writes it back. The write names
  // the version it read; if another phone saved in between, the write is
  // refused and the ops are applied again on the newer copy, so both phones'
  // changes count. `io.read()` resolves {state, sha}; `io.write(state, sha,
  // message)` resolves the new sha or rejects with {conflict: true}.
  async function commit(io, ops, tries = 5) {
    for (let t = 1; ; t++) {
      const { state, sha } = await io.read();
      const res = apply(state, ops);
      if (!res.lines.length) return { state: res.state, errors: res.errors };
      const message = res.lines.length === 1 ? res.lines[0] : res.lines.length + ' changes\n\n' + res.lines.join('\n');
      try {
        await io.write(res.state, sha, message);
        return { state: res.state, errors: res.errors };
      } catch (e) {
        if (!e || !e.conflict || t >= tries) throw e;
        // GitHub can serve the old version briefly after a save; give it a moment.
        await new Promise(r => setTimeout(r, io.retryDelay === undefined ? 400 * t : io.retryDelay));
      }
    }
  }

  const api = { apply, commit, empty, normalise, slug, num };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoxStore = api;
})(this);
