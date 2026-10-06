// Webhooks voor Twilio tijdens het telefonisch noodalarm.
//   a=twiml  -> aannemer neemt op: wat zegt de stem?
//   a=toets  -> aannemer drukte een toets (1 = aanvaarden, 2 = herhalen)
//   a=status -> gesprek afgelopen: opgenomen, niet opgenomen, bezet, ...
//   a=test   -> testoproep vanuit de instellingen
// Elke aanroep moet een geldige Twilio-handtekening hebben (anders 403).
import { db, enc } from '../lib/db.js';
import { aannemerActie, instellingen, event, waSyndicus } from '../lib/flow.js';
import { geldigeTwilioHandtekening, twiml, zeg, uitspreken } from '../lib/telefoon.js';
import { siteUrl } from '../lib/http.js';

const MAX_POGINGEN = 3;

function antwoord(res, inhoud) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.end(twiml(inhoud));
}

async function opdracht(k) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(k || '')) return null;
  return db.one('sm_meldingen', `aannemer_token=eq.${enc(k)}&select=*,gebouw:sm_gebouwen(*),aannemer:sm_aannemers(*)`);
}

// De tekst die de aannemer te horen krijgt
function bericht(m, inst) {
  const contact = m.melder_contact_aannemer && m.melder_tel
    ? `Neem telefonisch contact op met de melder${m.melder_naam ? `, ${m.melder_naam}` : ''}${m.melder_appartement ? `, appartement ${m.melder_appartement}` : ''}, op het nummer ${uitspreken(m.melder_tel)}. Ik herhaal: ${uitspreken(m.melder_tel)}.`
    : m.melder_contact_aannemer && m.melder_email
      ? 'Het e-mailadres van de melder staat in uw mailbox.'
      : `Neem voor toegang contact op met Syndexia op het nummer ${uitspreken(inst.syndicus_tel || '')}.`;
  return [
    'Goedendag. Dit is een automatische noodoproep van syndicus Syndexia.',
    `Er is een dringende melding voor ${m.gebouw.naam}, ${m.gebouw.adres || ''}.`,
    `Het probleem: ${m.titel}.${m.locatie ? ` Plaats: ${m.locatie}.` : ''}`,
    contact,
    'Alle details en foto\'s staan in uw mailbox.',
  ].join(' ');
}

export default async function handler(req, res) {
  const a = req.query.a;
  const url = siteUrl(req) + req.url; // exact de URL die Twilio aanriep (nodig voor de handtekening)
  if (!geldigeTwilioHandtekening(req, url)) { res.statusCode = 403; return res.end('Ongeldige handtekening'); }
  const b = req.body || {};
  const k = req.query.k;
  try {
    if (a === 'test') {
      return antwoord(res, zeg('Dit is een testoproep van het Syndexia schademeldingsplatform. Het telefonisch noodalarm werkt. Tot horens.'));
    }

    if (a === 'status') {
      // gesprek afgelopen: status bewaren; bij niet opnemen meteen een seintje aan Syndexia
      const status = String(b.CallStatus || 'onbekend');
      const [o] = await db.update('sm_oproepen', `call_sid=eq.${enc(b.CallSid || '')}`, { status, updated_at: new Date().toISOString() });
      if (o && ['no-answer', 'busy', 'failed', 'canceled'].includes(status)) {
        const m = await opdracht(k);
        if (m && m.status === 'wacht_aanvaarding') {
          const uitleg = { 'no-answer': 'nam niet op', busy: 'was in gesprek', failed: 'was onbereikbaar', canceled: 'gesprek geannuleerd' }[status];
          await event(m.id, 'systeem', 'alarm', `${m.aannemer?.firma || 'Aannemer'} ${uitleg} (poging ${o.poging}/${MAX_POGINGEN}).`);
          await waSyndicus(await instellingen(), `☎️ ${m.nummer}: ${m.aannemer?.firma || 'aannemer'} ${uitleg} (poging ${o.poging}/${MAX_POGINGEN}).${o.poging < MAX_POGINGEN ? ' We bellen binnen ±10 min opnieuw.' : ''}`);
        }
      }
      return antwoord(res, '');
    }

    const m = await opdracht(k);
    if (!m) return antwoord(res, zeg('Deze opdracht is niet meer actief. Bedankt en tot horens.'));
    const inst = await instellingen();

    if (a === 'twiml') {
      if (m.status !== 'wacht_aanvaarding') return antwoord(res, zeg(`Melding voor ${m.gebouw.naam} werd intussen al behandeld. Bedankt en tot horens.`));
      const tekst = bericht(m, inst);
      const herhaal = req.query.h === '1';
      // <Gather>: luistert naar één toets terwijl het bericht wordt voorgelezen
      return antwoord(res,
        `<Gather numDigits="1" timeout="8" action="/api/telefoon?a=toets&amp;k=${k}" method="POST">`
        + zeg(tekst)
        + zeg('Druk op 1 om de opdracht te aanvaarden. Druk op 2 om dit bericht te herhalen.')
        + `</Gather>`
        + (herhaal
          ? zeg('Geen keuze ontvangen. De details staan in uw mailbox. Tot horens.')
          : `<Redirect method="POST">/api/telefoon?a=twiml&amp;k=${k}&amp;h=1</Redirect>`));
    }

    if (a === 'toets') {
      const digit = String(b.Digits || '');
      if (b.CallSid) await db.update('sm_oproepen', `call_sid=eq.${enc(b.CallSid)}`, { toets: digit, updated_at: new Date().toISOString() });
      if (digit === '1') {
        const r = await aannemerActie(m, 'aanvaard', { via: 'telefonisch, toets 1' }, siteUrl(req));
        return antwoord(res, zeg(r.error
          ? 'Deze opdracht werd intussen al behandeld. Bedankt.'
          : 'Bedankt. De opdracht is aanvaard en Syndexia is verwittigd. Alle details en de contactgegevens staan in uw mailbox. Tot horens.'));
      }
      return antwoord(res, `<Redirect method="POST">/api/telefoon?a=twiml&amp;k=${k}</Redirect>`);
    }

    return antwoord(res, '');
  } catch (e) {
    console.error('telefoon', a, e);
    return antwoord(res, zeg('Er liep iets mis. De details staan in uw mailbox.'));
  }
}
