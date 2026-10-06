// Gedeelde HTTP-hulpjes: antwoorden, inloggen voor het dashboard, IP-hash voor misbruikbeperking.
import crypto from 'node:crypto';

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}
export const ok = (res, data = { ok: true }) => send(res, 200, data);
export const fout = (res, status, boodschap) => send(res, status, { error: boodschap });

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

export function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  return crypto.createHash('sha256').update(ip + (process.env.SESSION_SECRET || 'sm')).digest('hex').slice(0, 24);
}

export const token = (n = 24) => crypto.randomBytes(n).toString('base64url');

// ---------- dashboard-sessie ----------
// Een eenvoudig, ondertekend cookie: "vervaldatum.handtekening".
// Zonder geldig cookie geeft de admin-API niets terug.
const SECRET = () => process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'dev-secret';

function sign(value) {
  return crypto.createHmac('sha256', SECRET()).update(value).digest('base64url');
}

export function maakSessie(res) {
  const exp = String(Date.now() + 1000 * 60 * 60 * 24 * 14); // 14 dagen
  const val = `${exp}.${sign(exp)}`;
  res.setHeader('Set-Cookie', `sm_sessie=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`);
}
export function wisSessie(res) {
  res.setHeader('Set-Cookie', 'sm_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
export function heeftSessie(req) {
  const m = /(?:^|;\s*)sm_sessie=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const verwacht = sign(exp);
  return verwacht.length === sig.length && crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(sig));
}
export function wachtwoordKlopt(invoer) {
  const juist = process.env.DASHBOARD_PASSWORD || '';
  if (!juist) return false;
  const a = crypto.createHash('sha256').update(String(invoer || '')).digest();
  const b = crypto.createHash('sha256').update(juist).digest();
  return crypto.timingSafeEqual(a, b);
}

// Datums altijd in Belgische tijd tonen
export function fmt(d, metUur = true) {
  if (!d) return '';
  return new Intl.DateTimeFormat('nl-BE', {
    timeZone: 'Europe/Brussels', day: 'numeric', month: 'long', year: 'numeric',
    ...(metUur ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(d));
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
