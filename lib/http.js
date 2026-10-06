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
//
// De handtekening hangt af van SESSION_SECRET én van de huidige wachtwoord-hash.
// Wijzigt het wachtwoord, dan klopt de handtekening van alle oude cookies niet meer
// en zijn alle andere toestellen automatisch uitgelogd.
const SECRET = () => process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'dev-secret';

function sign(value, hash) {
  return crypto.createHmac('sha256', SECRET() + (hash || '')).update(value).digest('base64url');
}

export function maakSessie(res, hash) {
  const exp = String(Date.now() + 1000 * 60 * 60 * 24 * 14); // 14 dagen
  const val = `${exp}.${sign(exp, hash)}`;
  res.setHeader('Set-Cookie', `sm_sessie=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`);
}
export function wisSessie(res) {
  res.setHeader('Set-Cookie', 'sm_sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
export function heeftSessie(req, hash) {
  const m = /(?:^|;\s*)sm_sessie=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const verwacht = sign(exp, hash);
  return verwacht.length === sig.length && crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(sig));
}

// ---------- wachtwoord ----------
// scrypt = bewust trage hashfunctie: raden kost een aanvaller veel rekenkracht.
// Opslag: "scrypt$<salt>$<hash>" — het wachtwoord zelf wordt nergens bewaard.
export function hashWachtwoord(wachtwoord) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const h = crypto.scryptSync(String(wachtwoord), salt, 64).toString('base64url');
  return `scrypt$${salt}$${h}`;
}
// Zolang er nog geen wachtwoord in de database staat, geldt DASHBOARD_PASSWORD uit Vercel.
export function wachtwoordKlopt(invoer, hash) {
  if (hash) {
    const [, salt, h] = hash.split('$');
    const test = crypto.scryptSync(String(invoer || ''), salt, 64);
    const juist = Buffer.from(h, 'base64url');
    return test.length === juist.length && crypto.timingSafeEqual(test, juist);
  }
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
