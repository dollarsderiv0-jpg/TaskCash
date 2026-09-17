/**
 * WATCHREWARDS — database layer.
 *
 * Two interchangeable modes behind one async interface:
 *  - "pg":   PostgreSQL / Supabase (schema.sql auto-applied at boot, see server.js)
 *  - "json": file-backed fallback (data/db.json, or DB_DIR) so the app still
 *            runs with zero infrastructure — great for local demo and the test
 *            suites; set DATABASE_URL to a real Postgres for production.
 *
 * Route code only uses the Table helpers + aggregate helpers, so it never
 * branches on the mode.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

// DB_DIR lets tests and demos run against an isolated file store.
const DATA_DIR = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, '..', '..', 'data');
const JSON_FILE = path.join(DATA_DIR, 'db.json');

// ─────────────────────────── JSON mode ───────────────────────────
const JsonMode = (() => {
  let cache = null;
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch {
      cache = {};
    }
    return cache;
  }
  function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JSON_FILE, JSON.stringify(cache));
  }
  function table(name) {
    const db = load();
    if (!db[name]) db[name] = [];
    return db[name];
  }
  function nextId(name) {
    const db = load();
    db._seq = db._seq || {};
    db._seq[name] = (db._seq[name] || 0) + 1;
    return db._seq[name];
  }
  const q = (p) => Promise.resolve(p);

  // Type-tolerant equality: JWT ids are strings, stored ids are numbers,
  // and loose == also treats null == undefined as equal (safe here).
  const eq = (a, b) =>
    a === null || b === null ? a == null && b == null : a == b;
  const matches = (r, where) => Object.entries(where).every(([k, v]) =>
    Array.isArray(v) ? v.some((x) => eq(r[k], x)) : eq(r[k], v));

  return {
    mode: 'json',
    async init() { load(); return this; },
    async close() { save(); },
    isUniqueViolation() { return false; },

    async all(name, opts = {}) {
      const { where = {}, orderBy = 'id DESC', limit = 500, offset = 0 } = opts;
      let rows = table(name).filter((r) => matches(r, where));
      const [col, dir] = String(orderBy).split(' ');
      rows = rows.slice().sort((a, b) => {
        const av = a[col]; const bv = b[col];
        const cmp = av === bv ? 0 : av > bv ? 1 : -1;
        return /desc/i.test(dir || '') ? -cmp : cmp;
      });
      return rows.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 500)).map(clone);
    },

    async get(name, where = {}) {
      return table(name).find((r) => matches(r, where)) || null;
    },

    async byId(name, id) { return this.get(name, { id: Number(id) }); },

    async create(name, obj) {
      const rows = table(name);
      const row = { id: nextId(name), ...obj };
      rows.push(row);
      save();
      return row;
    },

    async update(name, id, patch) {
      const row = await this.byId(name, id);
      if (!row) return null;
      Object.assign(row, patch);
      save();
      return row;
    },

    async adjust(name, id, field, delta) {
      const row = await this.byId(name, id);
      if (!row) return null;
      row[field] = Math.round((Number(row[field] || 0) + Number(delta)) * 100) / 100;
      save();
      return row;
    },

    async delete(name, id) {
      const db = load();
      db[name] = (db[name] || []).filter((r) => r.id !== Number(id));
      save();
    },

    async count(name, where = {}) {
      return table(name).filter((r) => matches(r, where)).length;
    },

    async sum(name, field, where = {}) {
      const hit = table(name).filter((r) => matches(r, where));
      return hit.reduce((s, r) => s + Number(r[field] || 0), 0);
    },

    // timeSeries(name, dateField, days, { field, where }) — aggregates per day
    async timeSeries(name, dateField, days, opts = {}) {
      const { field = null, where = {} } = typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const rows = table(name).filter((r) => matches(r, where));
      const out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const total = rows
          .filter((r) => String(r[dateField] || '').slice(0, 10) === key)
          .reduce((s, r) => s + (field ? Number(r[field] || 0) : 1), 0);
        out.push({ day: key, total });
      }
      return out;
    },

    async dailyCounts(name, dateField, days, where = {}) {
      return this.timeSeries(name, dateField, days, { where });
    },
  };
})();

// ─────────────────────────── PG mode ───────────────────────────
const PgMode = (() => {
  let pool = null;
  let ready = null;
  let schemaApplied = false;

  function ident(name) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('bad identifier');
    return `"${name}"`;
  }
  function failSoft(err) {
    const code = err.code || '';
    return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '08006'].includes(code) ||
      /connect|timeout|terminat/i.test(err.message || '');
  }

  // Builds WHERE clauses; null values use IS NULL (SQL-safe)
  function whereSql(where) {
    const clauses = []; const params = [];
    for (const [k, v] of Object.entries(where)) {
      if (v === null) { clauses.push(`${ident(k)} IS NULL`); continue; }
      params.push(v); clauses.push(`${ident(k)} = $${params.length}`);
    }
    return { clauses, params };
  }

  return {
    mode: 'pg',
    async init() {
      if (!ready) {
        pool = new Pool({
          connectionString: config.db.connectionString,
          ssl: config.db.ssl,
          max: 10,
          idleTimeoutMillis: 30000,
        });
        pool.on('error', () => {});
        ready = pool.query('SELECT 1').then(() => true);
      }
      return ready;
    },
    async close() { if (pool) await pool.end().catch(() => {}); },
    isUniqueViolation(err) { return err && err.code === '23505'; },

    async applySchema() {
      if (schemaApplied) return;
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await pool.query(sql);
      schemaApplied = true;
    },

    async all(name, { where = {}, orderBy = 'id DESC', limit = 500, offset = 0 } = {}) {
      const { clauses, params } = whereSql(where);
      const sql = `SELECT * FROM ${ident(name)}` +
        (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '') +
        ` ORDER BY ${orderBy} LIMIT ${Number(limit) || 500} OFFSET ${Number(offset) || 0}`;
      const r = await pool.query(sql, params);
      return r.rows;
    },

    async get(name, where = {}) {
      const { clauses, params } = whereSql(where);
      const sql = `SELECT * FROM ${ident(name)}` +
        (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '') + ' LIMIT 1';
      const r = await pool.query(sql, params);
      return r.rows[0] || null;
    },

    async byId(name, id) { return this.get(name, { id: Number(id) }); },

    async create(name, obj) {
      const keys = Object.keys(obj);
      const vals = Object.values(obj);
      const ph = keys.map((_, i) => `$${i + 1}`);
      const sql = `INSERT INTO ${ident(name)} (${keys.map(ident).join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`;
      try {
        const r = await pool.query(sql, vals);
        return r.rows[0];
      } catch (err) {
        if (err.code === '23505' && /users/.test(name)) {
          // friendlier unique violation bubbling
          err.friendly = /email/i.test(err.detail || '') ? 'email' : /username/i.test(err.detail || '') ? 'username' : 'unique';
        }
        throw err;
      }
    },

    async update(name, id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.byId(name, id);
      const set = keys.map((k, i) => `${ident(k)} = $${i + 1}`);
      const sql = `UPDATE ${ident(name)} SET ${set.join(', ')} WHERE id = $${keys.length + 1} RETURNING *`;
      const r = await pool.query(sql, [...Object.values(patch), Number(id)]);
      return r.rows[0] || null;
    },

    async adjust(name, id, field, delta) {
      const sql = `UPDATE ${ident(name)} SET ${ident(field)} = COALESCE(${ident(field)},0) + $1 WHERE id = $2 RETURNING *`;
      const r = await pool.query(sql, [Number(delta), Number(id)]);
      return r.rows[0] || null;
    },

    async delete(name, id) {
      await pool.query(`DELETE FROM ${ident(name)} WHERE id = $1`, [Number(id)]);
    },

    async count(name, where = {}) {
      const { clauses, params } = whereSql(where);
      const sql = `SELECT COUNT(*)::int AS n FROM ${ident(name)}` +
        (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '');
      const r = await pool.query(sql, params);
      return r.rows[0].n;
    },

    async sum(name, field, where = {}) {
      const { clauses, params } = whereSql(where);
      const sql = `SELECT COALESCE(SUM(${ident(field)}),0)::float AS s FROM ${ident(name)}` +
        (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '');
      const r = await pool.query(sql, params);
      return r.rows[0].s;
    },

    async timeSeries(name, dateField, days, { field = null, where = {} } = {}) {
      const { clauses, params } = whereSql(where);
      const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      params.push(since);
      const idx = params.length;
      const agg = field ? `SUM(${ident(field)})::float` : 'COUNT(*)::int';
      const sql =
        `WITH days AS (SELECT generate_series($${idx}::date, CURRENT_DATE, '1 day')::date AS day) ` +
        `SELECT d.day::text AS day, COALESCE(${agg},0) AS total FROM days d ` +
        `LEFT JOIN ${ident(name)} t ON t.${ident(dateField)}::date = d.day` +
        (clauses.length ? ` AND ${clauses.join(' AND ')}` : '') +
        ' GROUP BY d.day ORDER BY d.day';
      const r = await pool.query(sql, params);
      return r.rows.map((row) => ({ day: row.day, total: Number(row.total) }));
    },

    async dailyCounts(name, dateField, days, where = {}) {
      return this.timeSeries(name, dateField, days, { where });
    },

    async raw(text, params = []) {
      return pool.query(text, params);
    },
  };
})();

let mode = null;

function failSoft(err) {
  const code = err.code || '';
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '08006'].includes(code) ||
    /connect|timeout|terminat/i.test(err.message || '');
}

async function init() {
  if (mode) return mode;
  // DB_MODE=json forces the file store (used by the smoke test and demos).
  if (String(process.env.DB_MODE || '').toLowerCase() === 'json') {
    mode = JsonMode;
    await JsonMode.init();
    console.log('[db] JSON mode forced (DB_MODE=json)');
    return mode;
  }
  try {
    await PgMode.init();
    try {
      await PgMode.applySchema();
      console.log('[db] PostgreSQL connected — schema ensured');
    } catch (e) {
      if (!failSoft(e)) throw e;
      console.warn('[db] connected but could not apply schema:', e.message);
    }
    mode = PgMode;
  } catch (e) {
    if (!failSoft(e)) {
      console.warn('[db] PostgreSQL init failed, using JSON fallback:', e.message);
    }
    mode = JsonMode;
    await JsonMode.init();
    console.log('[db] JSON fallback mode active (data/db.json)');
  }
  return mode;
}

function getDb() {
  if (!mode) throw new Error('db not initialised — call init() first');
  return mode;
}

// Generic async table facade.
class Table {
  constructor(name) { this.name = name; }
  all(opts) { return getDb().all(this.name, opts); }
  get(where) { return getDb().get(this.name, where); }
  byId(id) { return getDb().byId(this.name, id); }
  create(obj) { return getDb().create(this.name, obj); }
  update(id, patch) { return getDb().update(this.name, id, patch); }
  adjust(id, field, delta) { return getDb().adjust(this.name, id, field, delta); }
  delete(id) { return getDb().delete(this.name, id); }
  count(where) { return getDb().count(this.name, where); }
  sum(field, where) { return getDb().sum(this.name, field, where); }
}

module.exports = { init, getDb, Table, get mode() { return mode ? mode.mode : null; } };
