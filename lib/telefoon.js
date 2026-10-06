// Telefonisch noodalarm + WhatsApp via Twilio (plain fetch, geen npm-pakket nodig).
//
// Staat volledig UIT zolang TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM niet ingesteld zijn,
// en zolang het noodalarm in de dashboard-instellingen niet is aangezet.
import crypto from 'node:crypto';

const SID = () => process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN || '';
const API = () => (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, ''); // aanpasbaar voor de lokale test

export const twilioKlaar = () => !!(SID() && TOKEN() && process.env.TWILIO_FROM);
export const whatsappKlaar = () => !!(SID() && TOKEN() && process.env.TWILIO_WHATSAPP_FROM);

// ---------- nummers ----------
// "0477 11 22 33", "+32 477/11.22.33", "0032477112233" -> "+32477112233"
export function naarE164(nr) {
  if (!nr) return null;
  let s = String(nr).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('0')) s = `+32${s.slice(1)}`;
  if (!s.startsWith('+')) s = `+${s}`;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
// Voor de computerstem: "+32477112233" -> "0 4 7 7, 1 1, 2 2, 3 3" (cijfer per cijfer, met pauzes)
export function uitspreken(nr) {
  const e = naarE164(nr);
  if (!e) return String(nr || '');
  const nat = e.startsWith('+32') ? `0${e.slice(3)}` : e.replace('+', 'plus ');
  const cijfers = nat.replace(/\D/g, '').split('');
  const groepen = [cijfers.slice(0, 4), cijfers.slice(4, 6), cijfers.slice(6, 8), cijfers.slice(8)].filter((g) => g.length);
  return groepen.map((g) => g.join(' ')).join(', ');
}

// ---------- kantooruren en Belgische feestdagen ----------
function pasen(jaar) { // algoritme van Meeus/Jones/Butcher
  const a = jaar % 19, b = Math.floor(jaar / 100), c = jaar % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maand = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(jaar, maand - 1, dag));
}
export function feestdagen(jaar) {
  const p = pasen(jaar).getTime(), dag = 864e5;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return new Set([
    `${jaar}-01-01`, iso(p + dag), `${jaar}-05-01`, iso(p + 39 * dag), iso(p + 50 * dag),
    `${jaar}-07-21`, `${jaar}-08-15`, `${jaar}-11-01`, `${jaar}-11-11`, `${jaar}-12-25`,
  ]); // Nieuwjaar, Paasmaandag, Dag v.d. Arbeid, O.L.H.-Hemelvaart, Pinkstermaandag, Nationale feestdag, O.L.V.-Hemelvaart, Allerheiligen, Wapenstilstand, Kerstmis
}
// Tijdstip omzetten naar Belgische kalenderdag, weekdag en uur
function belgisch(d) {
  const deel = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { datum: `${deel.year}-${deel.month}-${deel.day}`, uur: Number(deel.hour), weekend: ['Sat', 'Sun'].includes(deel.weekday), jaar: Number(deel.year) };
}
export function buitenKantooruren(inst, d = new Date()) {
  const b = belgisch(d);
  if (b.weekend || feestdagen(b.jaar).has(b.datum)) return true;
  return b.uur < (inst.kantoor_van ?? 8) || b.uur >= (inst.kantoor_tot ?? 18);
}

// Moet deze melding NU telefonisch gealarmeerd worden?
export function alarmNodig(m, inst, d = new Date()) {
  if (!twilioKlaar() || !inst.noodalarm_actief) return false;
  if (m.urgentie !== 'dringend') return false;
  if (!(inst.noodalarm_categorieen || []).includes(m.categorie)) return false;
  return inst.noodalarm_wanneer === 'altijd' || buitenKantooruren(inst, d);
}

// ---------- Twilio REST ----------
async function twilio(pad, velden) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(velden)) if (v !== undefined && v !== null) body.append(k, String(v));
  const r = await fetch(`${API()}/2010-04-01/Accounts/${SID()}/${pad}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${SID()}:${TOKEN()}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || 'onbekende fout'}`);
  return j;
}

// Start een telefoongesprek. Twilio haalt het gesprek (TwiML) op bij `twimlUrl` zodra er wordt opgenomen.
export async function bel({ naar, twimlUrl, statusUrl }) {
  const to = naarE164(naar);
  if (!to) throw new Error(`Ongeldig telefoonnummer: ${naar}`);
  const r = await twilio('Calls.json', {
    To: to, From: process.env.TWILIO_FROM, Url: twimlUrl, Method: 'POST',
    StatusCallback: statusUrl, StatusCallbackMethod: 'POST', StatusCallbackEvent: 'completed',
    Timeout: 30, // ±6 keer overgaan
  });
  return { sid: r.sid, to };
}

// WhatsApp: met goedgekeurd sjabloon (ContentSid) als dat ingesteld is, anders vrije tekst
// (vrije tekst werkt enkel in de Twilio-sandbox of binnen 24u na een bericht van de ontvanger).
export async function whatsapp({ naar, tekst, sjabloon, variabelen }) {
  if (!whatsappKlaar()) return { overgeslagen: true };
  const to = naarE164(naar);
  if (!to) return { overgeslagen: true };
  try {
    const r = await twilio('Messages.json', {
      From: `whatsapp:${naarE164(process.env.TWILIO_WHATSAPP_FROM) || process.env.TWILIO_WHATSAPP_FROM}`,
      To: `whatsapp:${to}`,
      ...(sjabloon ? { ContentSid: sjabloon, ContentVariables: JSON.stringify(variabelen || {}) } : { Body: tekst }),
    });
    return { ok: true, sid: r.sid };
  } catch (e) {
    console.error('WhatsApp-fout:', e.message);
    return { fout: e.message };
  }
}

// ---------- beveiliging van Twilio-webhooks ----------
// Twilio ondertekent elke aanroep: HMAC-SHA1(authToken, volledige URL + alle POST-velden alfabetisch).
// Zonder deze controle zou iedereen een "toets 1" (= aanvaarden) kunnen vervalsen.
export function geldigeTwilioHandtekening(req, url) {
  const sig = req.headers['x-twilio-signature'];
  if (!sig || !TOKEN()) return false;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const verwacht = crypto.createHmac('sha1', TOKEN()).update(Buffer.from(data, 'utf-8')).digest('base64');
  return verwacht.length === sig.length && crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(sig));
}

// ---------- TwiML (het gesprek zelf) ----------
const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const STEM = () => process.env.TWILIO_VOICE || 'Polly.Lisa-Neural';
const TAAL = () => process.env.TWILIO_LANGUAGE || 'nl-BE';
export const zeg = (tekst) => `<Say voice="${STEM()}" language="${TAAL()}">${xml(tekst)}</Say>`;
export const twiml = (inhoud) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inhoud}</Response>`;
