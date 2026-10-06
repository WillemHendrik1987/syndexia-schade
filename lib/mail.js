// Mails versturen + één huisstijl-sjabloon voor alle mails.
//
// Twee manieren, automatisch gekozen op basis van de ingestelde omgevingsvariabelen:
//   1. Gmail/Google Workspace SMTP (GMAIL_USER + GMAIL_APP_PASSWORD) → mails vertrekken écht van beheer@syndexia.be
//   2. Resend (RESEND_API_KEY + MAIL_FROM) → handig zolang er geen app-wachtwoord is
// Is geen van beide ingesteld, dan wordt de mail enkel gelogd (de tool blijft werken).

import nodemailer from 'nodemailer';
import { BRAND } from './constants.js';
import { esc } from './http.js';

let transport = null;
function smtp() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transport;
}

export async function verstuur({ to, cc, subject, html, replyTo }) {
  const ontvangers = [].concat(to || []).filter(Boolean);
  if (!ontvangers.length) return { overgeslagen: true };
  const van = process.env.MAIL_FROM || (process.env.GMAIL_USER ? `Syndexia Schademelding <${process.env.GMAIL_USER}>` : 'Syndexia <schade@syndexia.be>');
  try {
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      await smtp().sendMail({ from: van, to: ontvangers.join(','), cc, subject, html, replyTo });
      return { ok: true, via: 'smtp' };
    }
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: van, to: ontvangers, cc: cc ? [].concat(cc) : undefined, subject, html, reply_to: replyTo || process.env.REPLY_TO || 'beheer@syndexia.be' }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { ok: true, via: 'resend' };
    }
    console.log('[mail niet verstuurd – geen mailinstellingen]', subject, '→', ontvangers.join(','));
    globalThis.__MAILS?.push({ to: ontvangers, cc, subject, html }); // enkel voor de lokale testserver
    return { overgeslagen: true };
  } catch (e) {
    // Een mislukte mail mag nooit een melding doen mislukken; we loggen en gaan door.
    console.error('Mailfout:', e.message);
    return { fout: e.message };
  }
}

// ---------- sjabloon ----------
// E-mailclients (Outlook!) begrijpen weinig moderne CSS, daarom tabellen en inline stijlen.
export function sjabloon({ kop, intro, blokken = [], knop, knop2, voet, urgent = false }) {
  const band = urgent
    ? `<tr><td style="background:#C2410C;color:#fff;font:600 13px/1.4 Arial,sans-serif;padding:10px 28px;letter-spacing:.04em;text-transform:uppercase">● Dringende melding</td></tr>`
    : '';
  const rij = (b) => b.html
    ? `<tr><td style="padding:0 28px 16px">${b.html}</td></tr>`
    : `<tr><td style="padding:0 28px 14px"><div style="font:600 11px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#8A6A75;margin-bottom:4px">${esc(b.label)}</div><div style="font:15px/1.5 Arial,sans-serif;color:#2A1A20">${b.raw ? b.waarde : esc(b.waarde).replace(/\n/g, '<br>')}</div></td></tr>`;
  const btn = (k, secundair) => k
    ? `<a href="${k.url}" style="display:inline-block;background:${secundair ? '#ffffff' : BRAND.bordeaux};color:${secundair ? BRAND.bordeaux : '#ffffff'};border:2px solid ${BRAND.bordeaux};font:700 15px/1 Arial,sans-serif;text-decoration:none;padding:15px 26px;border-radius:10px;margin:0 8px 8px 0">${esc(k.tekst)}</a>`
    : '';
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#F4EEF0;padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${BRAND.bordeaux};padding:18px 28px"><img src="${BRAND.logo}" alt="Syndexia" width="126" style="display:block;width:126px;height:auto;border:0"></td></tr>
${band}
<tr><td style="padding:26px 28px 6px"><h1 style="margin:0 0 10px;font:700 22px/1.25 Georgia,serif;color:#2A1A20">${esc(kop)}</h1>
${intro ? `<p style="margin:0 0 18px;font:15px/1.55 Arial,sans-serif;color:#4A3540">${intro}</p>` : ''}</td></tr>
${blokken.map(rij).join('')}
${knop || knop2 ? `<tr><td style="padding:8px 28px 22px">${btn(knop)}${btn(knop2, true)}</td></tr>` : ''}
${voet ? `<tr><td style="padding:0 28px 22px;font:13px/1.5 Arial,sans-serif;color:#8A6A75">${voet}</td></tr>` : ''}
<tr><td style="background:#FAF5F7;padding:16px 28px;font:12px/1.5 Arial,sans-serif;color:#8A6A75;border-top:1px solid #EFE3E8">
Syndexia · ${BRAND.adres} · ${BRAND.tel}<br>Automatisch bericht van het schademeldingsplatform.</td></tr>
</table></td></tr></table></body></html>`;
}

export function fotoStrip(urls = []) {
  if (!urls.length) return '';
  return `<div>${urls.slice(0, 4).map((u) => `<a href="${u}"><img src="${u}" width="120" height="120" style="width:120px;height:120px;object-fit:cover;border-radius:8px;margin:0 6px 6px 0;border:1px solid #EFE3E8" alt="foto"></a>`).join('')}</div>`;
}
