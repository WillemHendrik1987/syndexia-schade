// LOKALE TESTSERVER (wordt niet gedeployed).
// Bootst Vercel (static + /api) én een minimale Supabase (PostgREST + Storage) in het geheugen na,
// zodat de volledige flow end-to-end getest kan worden zonder echte sleutels.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4321);
process.env.SUPABASE_URL = `http://localhost:${PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dev';
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'test123';
process.env.SESSION_SECRET = 'dev-secret';
process.env.CRON_SECRET = 'cron-dev';
process.env.SITE_URL = `http://localhost:${PORT}`;

// ---------- in-memory database ----------
const uuid = () => crypto.randomUUID();
let nr = 0;
const DB = { sm_gebouwen: [], sm_aannemers: [], sm_toewijzingen: [], sm_concepten: [], sm_meldingen: [], sm_events: [], sm_instellingen: [] };
const now = () => new Date().toISOString();
const DEFAULTS = {
  sm_gebouwen: () => ({ id: uuid(), qr_token: crypto.randomBytes(6).toString('hex'), toegang_info: null, bron_gebouw_id: null, actief: true, created_at: now() }),
  sm_aannemers: () => ({ id: uuid(), contactpersoon: null, telefoon: null, vakgebied: 'algemeen', actief: true, created_at: now() }),
  sm_toewijzingen: () => ({ id: uuid(), prioriteit: 1 }),
  sm_concepten: () => ({ id: uuid(), fotos: [], ai: null, ronde: 1, created_at: now() }),
  sm_meldingen: () => ({
    id: uuid(), nummer: `SM-2026-${String(++nr).padStart(4, '0')}`, status: 'nieuw', fotos: [], privatief_vermoeden: false,
    melder_contact_aannemer: false, track_token: crypto.randomBytes(16).toString('hex'), aannemer_id: null, aannemer_token: null,
    verstuurd_op: null, aanvaard_op: null, gepland_op: null, uitgevoerd_op: null, afgesloten_op: null, herinneringen: 0,
    laatste_opvolging: null, escalatie: false, geweigerd_door: [], bevestigingen: 0, opgelost_feedback: null, created_at: now(), updated_at: now(),
  }),
  sm_events: () => ({ id: ++nr, data: null, created_at: now() }),
  sm_instellingen: () => ({ id: 1 }),
};
DB.sm_instellingen.push({ id: 1, syndicus_naam: 'Syndexia', syndicus_email: 'beheer@syndexia.be', auto_doorsturen_niet_dringend: true, escalatie_dringend_min: 120, herinnering_normaal_uren: 48, dagrapport: true, laatste_dagrapport: null });
for (const [naam, adres] of [['EOS', 'Gistelse Steenweg 261, 8200 Sint-Andries'], ['Puerto 10', 'Koningin Elisabethlaan 10, 8000 Brugge'], ['Daembaert', 'Oude Burg 4, 8000 Brugge']]) {
  DB.sm_gebouwen.push({ ...DEFAULTS.sm_gebouwen(), naam, adres });
}
DB.sm_gebouwen[0].qr_token = 'testeos12345';
const FK = { sm_gebouwen: 'gebouw_id', sm_aannemers: 'aannemer_id' };

function splitTop(s) { // splitst op komma's buiten haakjes
  const out = []; let d = 0, cur = '';
  for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && !d) { out.push(cur); cur = ''; } else cur += c; }
  if (cur) out.push(cur); return out;
}
function project(row, select) {
  if (!select || select === '*') return { ...row };
  const out = {};
  for (const part of splitTop(select)) {
    const m = /^(?:(\w+):)?(\w+)\((.*)\)$/.exec(part);
    if (m) {
      const [, alias, table, sub] = m;
      const fk = FK[table]; const rel = DB[table].find((r) => r.id === row[fk]);
      out[alias || table] = rel ? project(rel, sub) : null;
    } else if (part === '*') Object.assign(out, row); else out[part] = row[part];
  }
  return out;
}
function parseVal(v) { if (v === 'true') return true; if (v === 'false') return false; if (v === 'null') return null; return decodeURIComponent(v); }
function matches(row, filters) {
  return filters.every(([col, expr]) => {
    const i = expr.indexOf('.'); const op = expr.slice(0, i); const raw = expr.slice(i + 1); const v = row[col];
    if (op === 'eq') return String(v) === String(parseVal(raw));
    if (op === 'in') return raw.slice(1, -1).split(',').map(decodeURIComponent).includes(String(v));
    if (op === 'gte') return v != null && v >= decodeURIComponent(raw);
    if (op === 'lt') return v != null && v < decodeURIComponent(raw);
    if (op === 'is') return v === parseVal(raw);
    throw new Error('op ' + op);
  });
}
function applyDefaults(table, row) {
  const r = { ...DEFAULTS[table](), ...row };
  if (table === 'sm_gebouwen' && !r.naam) throw new Error('naam verplicht');
  return r;
}
async function rest(req, res, table, qs, bodyTxt) {
  const params = [...new URLSearchParams(qs)];
  const reserved = ['select', 'order', 'limit', 'on_conflict'];
  const filters = params.filter(([k]) => !reserved.includes(k));
  const get = (k) => params.find(([x]) => x === k)?.[1];
  const t = DB[table]; if (!t) { res.writeHead(404); return res.end(JSON.stringify({ message: 'no table ' + table })); }
  const send = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(d === undefined ? '' : JSON.stringify(d)); };
  if (req.method === 'GET') {
    let rows = t.filter((r) => matches(r, filters));
    const order = get('order');
    if (order) for (const o of order.split(',').reverse()) { const [c, dir] = o.split('.'); rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
    if (get('limit')) rows = rows.slice(0, Number(get('limit')));
    return send(200, rows.map((r) => project(r, get('select'))));
  }
  if (req.method === 'POST') {
    const body = JSON.parse(bodyTxt); const arr = Array.isArray(body) ? body : [body];
    const out = arr.map((b) => { const r = applyDefaults(table, b); t.push(r); return r; });
    return send(201, out);
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(bodyTxt); const rows = t.filter((r) => matches(r, filters));
    rows.forEach((r) => Object.assign(r, patch, table === 'sm_meldingen' ? { updated_at: now() } : {}));
    return send(200, rows);
  }
  if (req.method === 'DELETE') { DB[table] = t.filter((r) => !matches(r, filters)); return send(204); }
}
const STORE = new Map();
async function storage(req, res, p, bodyBuf) {
  if (p.startsWith('/storage/v1/object/sign/')) {
    const { paths } = JSON.parse(bodyBuf.toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(paths.map((x) => ({ path: x, signedURL: `/object/public/schademeldingen/${x}` }))));
  }
  if (p.startsWith('/storage/v1/object/public/schademeldingen/') || (req.method === 'GET' && p.startsWith('/storage/v1/object/schademeldingen/'))) {
    const key = p.split('/schademeldingen/')[1]; const f = STORE.get(key);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.buf);
  }
  if (req.method === 'POST' && p.startsWith('/storage/v1/object/schademeldingen/')) {
    STORE.set(p.split('/schademeldingen/')[1], { buf: bodyBuf, type: req.headers['content-type'] });
    res.writeHead(200); return res.end('{}');
  }
  if (req.method === 'DELETE') { const { prefixes } = JSON.parse(bodyBuf.toString()); prefixes.forEach((x) => STORE.delete(x)); res.writeHead(200); return res.end('[]'); }
  res.writeHead(404); res.end();
}

// ---------- vercel-achtige afhandeling ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const handlers = {};
async function handler(name) { return (handlers[name] ||= (await import(path.join(ROOT, 'api', `${name}.js`))).default); }
globalThis.__MAILS = [];

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/rest/v1/')) return await rest(req, res, p.slice(9), url.search.slice(1), buf.toString());
    if (p.startsWith('/storage/v1/')) return await storage(req, res, p, buf);
    if (p === '/__db') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(DB)); }
    if (p === '/__mails') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(globalThis.__MAILS || [])); }
    if (p === '/__tijd') { // tijdreizen: verschuif tijdstempels om opvolging te testen
      const min = Number(url.searchParams.get('min') || 0);
      for (const m of DB.sm_meldingen) for (const k of ['verstuurd_op', 'aanvaard_op', 'gepland_op', 'uitgevoerd_op', 'created_at', 'laatste_opvolging']) if (m[k]) m[k] = new Date(new Date(m[k]).getTime() - min * 60000).toISOString();
      res.writeHead(200); return res.end('ok');
    }
    if (p.startsWith('/api/')) {
      const h = await handler(p.slice(5).replace(/\.js$/, ''));
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = buf.length ? JSON.parse(buf.toString()) : {}; } catch { req.body = {}; }
      return await h(req, res);
    }
    let file = p === '/' ? '/index.html' : p;
    if (/^\/m\//.test(p)) file = '/melden.html';
    if (/^\/t\//.test(p)) file = '/volg.html';
    if (/^\/a\//.test(p)) file = '/opdracht.html';
    const fp = path.join(ROOT, 'public', file);
    if (!fp.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('niet gevonden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(fs.readFileSync(fp));
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, () => console.log(`dev op http://localhost:${PORT}`));
