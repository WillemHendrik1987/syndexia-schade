// API voor aannemers. Geen account nodig: elke opdracht heeft een eigen, onraadbare link (aannemer_token).
// Wordt de opdracht doorgeschoven naar iemand anders, dan krijgt die een nieuwe token en werkt de oude link niet meer.
import { db, enc, signedUrls, uploadFoto } from '../lib/db.js';
import { aannemerActie } from '../lib/flow.js';
import { ok, fout, body, siteUrl } from '../lib/http.js';
import { CATEGORIEEN, STATUS } from '../lib/constants.js';

async function opdracht(k) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(k || '')) return null;
  return db.one('sm_meldingen', `aannemer_token=eq.${enc(k)}&select=*,gebouw:sm_gebouwen(*),aannemer:sm_aannemers(*)`);
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const m = await opdracht(req.query.k);
      if (!m) return fout(res, 404, 'Deze opdrachtlink is niet (meer) geldig.');
      const ev = await db.select('sm_events', `melding_id=eq.${m.id}&type=in.(aangemaakt,doorgestuurd,aanvaard,ingepland,uitgevoerd,heropend,bevestiging)&select=tekst,created_at&order=created_at.asc`);
      return ok(res, {
        nummer: m.nummer, status: m.status, status_label: STATUS[m.status]?.label,
        dringend: m.urgentie === 'dringend', titel: m.titel, samenvatting: m.samenvatting,
        categorie: CATEGORIEEN[m.categorie]?.label, locatie: m.locatie, advies: m.ai?.advies_aannemer || '',
        gebouw: { naam: m.gebouw.naam, adres: m.gebouw.adres, toegang: m.gebouw.toegang_info },
        firma: m.aannemer?.firma, gepland_op: m.gepland_op, created_at: m.created_at, bevestigingen: m.bevestigingen,
        // contactgegevens van de bewoner enkel als die daar toestemming voor gaf
        melder: m.melder_contact_aannemer ? { naam: m.melder_naam, appartement: m.melder_appartement, tel: m.melder_tel } : null,
        fotos: await signedUrls(m.fotos, 3600 * 24),
        tijdlijn: ev,
      });
    }
    if (req.method !== 'POST') return fout(res, 405, 'Methode niet toegelaten');
    const b = body(req);
    const m = await opdracht(b.k);
    if (!m) return fout(res, 404, 'Deze opdrachtlink is niet (meer) geldig.');

    // optionele foto's na de herstelling
    const fotos = [];
    if (b.actie === 'uitgevoerd' && Array.isArray(b.fotos)) {
      for (const [i, d] of b.fotos.slice(0, 3).entries()) {
        const mm = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(d));
        if (!mm) continue;
        const buf = Buffer.from(mm[2], 'base64');
        if (buf.length > 3.5 * 1024 * 1024) continue;
        fotos.push(await uploadFoto(`melding/${m.id}/na-${Date.now()}-${i + 1}.jpg`, buf, mm[1]));
      }
    }
    const r = await aannemerActie(m, b.actie, { reden: b.reden, datum: b.datum, notitie: b.notitie, fotos }, siteUrl(req));
    if (r.error) return fout(res, 400, r.error);
    return ok(res, r);
  } catch (e) {
    console.error('aannemer', e);
    return fout(res, 500, 'Er liep iets mis. Probeer opnieuw of contacteer Syndexia.');
  }
}
