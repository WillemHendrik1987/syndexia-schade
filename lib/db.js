// Kleine Supabase-client op basis van fetch (geen npm-pakket nodig).
// Werkt met de service-role sleutel: die mag NOOIT in de browser terechtkomen,
// daarom gebeurt alle databasetoegang hier op de server.

const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const BUCKET = 'schademeldingen';

// Nieuwe Supabase-sleutels (sb_secret_...) zijn geen JWT: die horen enkel in de "apikey"-header.
// Oude service_role-sleutels (JWT) sturen we ook als Bearer-token mee.
const auth = () => (KEY.startsWith('sb_') ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` });
function headers(extra = {}) {
  return { ...auth(), 'Content-Type': 'application/json', ...extra };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  if (!BASE || !KEY) throw new Error('Supabase is niet geconfigureerd (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Hulpfunctie om waarden veilig in een PostgREST-filter te zetten
export const enc = (v) => encodeURIComponent(v);

export const db = {
  select: (table, query = '') => rest(`${table}?${query}`),
  one: async (table, query) => (await rest(`${table}?${query}&limit=1`))?.[0] || null,
  insert: async (table, row) => (await rest(table, { method: 'POST', body: row, prefer: 'return=representation' }))?.[0],
  insertMany: (table, rows) => rest(table, { method: 'POST', body: rows, prefer: 'return=representation' }),
  update: (table, filter, patch) => rest(`${table}?${filter}`, { method: 'PATCH', body: patch, prefer: 'return=representation' }),
  upsert: (table, rows, onConflict) =>
    rest(`${table}?on_conflict=${onConflict}`, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation' }),
  remove: (table, filter) => rest(`${table}?${filter}`, { method: 'DELETE', prefer: 'return=minimal' }),
};

// ---------- opslag (foto's) ----------
export async function uploadFoto(path, buffer, contentType = 'image/jpeg') {
  const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Upload mislukt: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return path;
}

// Tijdelijke links (standaard 7 dagen) zodat foto's privé blijven maar wel in mails/schermen te zien zijn
export async function signedUrls(paths, seconden = 60 * 60 * 24 * 7) {
  if (!paths?.length) return [];
  const res = await fetch(`${BASE}/storage/v1/object/sign/${BUCKET}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ expiresIn: seconden, paths }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((d) => (d.signedURL ? `${BASE}/storage/v1${d.signedURL}` : null)).filter(Boolean);
}

export async function verwijderFotos(paths) {
  if (!paths?.length) return;
  await fetch(`${BASE}/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ prefixes: paths }) });
}

export async function downloadFoto(path) {
  const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`, { headers: auth() });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
