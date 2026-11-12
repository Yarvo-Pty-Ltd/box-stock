// Stock rules, kept apart from the page so they can be tested in Node.
// The whole stock list is one JSON document: { boxes, items, recent }.
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
    return { boxes: [], items: [], recent: [] };
  }

  function normalise(state) {
    const s = state && typeof state === 'object' ? state : {};
    return {
      boxes: Array.isArray(s.boxes) ? s.boxes : [],
      items: Array.isArray(s.items) ? s.items : [],
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
      return 'delete ' + it.name;
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
