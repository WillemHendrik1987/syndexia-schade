// Dashboard-API voor de syndicus. Alles behalve "login" vereist een geldig sessiecookie.
import { db, enc, signedUrls } from '../lib/db.js';
import { doorsturen, event, instellingen, mailBewoner, zelfAfhandelen, manueelPlannen } from '../lib/flow.js';
import { verstuur, sjabloon } from '../lib/mail.js';
import { twilioKlaar, whatsappKlaar, bel, whatsapp, naarE164, buitenKantooruren } from '../lib/telefoon.js';
import { ok, fout, body, siteUrl, maakSessie, wisSessie, heeftSessie, wachtwoordKlopt, hashWachtwoord, token } from '../lib/http.js';
import { CATEGORIEEN, CATEGORIE_KEYS, STATUS, OPEN_STATUSSEN } from '../lib/constants.js';

const uuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const tekst = (v, n = 300) => (v == null ? null : String(v).trim().slice(0, n) || null);

export default async function handler(req, res) {
  const a = req.query.a;
  try {
    // huidige wachtwoord-hash (null zolang het wachtwoord nooit in het dashboard gewijzigd werd)
    const hash = (await db.one('sm_instellingen', 'id=eq.1&select=wachtwoord_hash'))?.wachtwoord_hash || null;
    if (a === 'login' && req.method === 'POST') {
      await new Promise((r) => setTimeout(r, 400)); // vertraagt het raden van wachtwoorden
      if (!wachtwoordKlopt(body(req).wachtwoord, hash)) return fout(res, 401, 'Onjuist wachtwoord.');
      maakSessie(res, hash);
      return ok(res);
    }
    if (a === 'logout') { wisSessie(res); return ok(res); }
    if (!heeftSessie(req, hash)) return fout(res, 401, 'Niet ingelogd.');
    if (a === 'me') return ok(res, { ok: true });

    if (req.method === 'GET') {
      if (a === 'overzicht') return await overzicht(res);
      if (a === 'melding') return await melding(req, res);
      if (a === 'gebouwen') return await gebouwen(res);
    }
    if (req.method === 'POST') {
      const b = body(req);
      const site = siteUrl(req);
      switch (a) {
        case 'melding_actie': return await meldingActie(b, site, res);
        case 'gebouw_opslaan': return await gebouwOpslaan(b, res);
        case 'gebouw_qr_vernieuwen': {
          if (!uuid(b.id)) return fout(res, 400, 'Ongeldig gebouw');
          const [g] = await db.update('sm_gebouwen', `id=eq.${b.id}`, { qr_token: token(9).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || token(9) });
          return ok(res, { gebouw: g });
        }
        case 'toewijzing': return await toewijzing(b, res);
        case 'aannemer_opslaan': return await aannemerOpslaan(b, res);
        case 'aannemer_verwijderen': return await aannemerVerwijderen(b, res);
        case 'wachtwoord': {
          await new Promise((r) => setTimeout(r, 400));
          if (!wachtwoordKlopt(b.huidig, hash)) return fout(res, 400, 'Het huidige wachtwoord klopt niet.');
          const nieuw = String(b.nieuw || '');
          if (nieuw.length < 10) return fout(res, 400, 'Kies een wachtwoord van minstens 10 tekens.');
          if (nieuw === String(b.huidig)) return fout(res, 400, 'Het nieuwe wachtwoord is hetzelfde als het huidige.');
          const nieuweHash = hashWachtwoord(nieuw);
          await db.update('sm_instellingen', 'id=eq.1', { wachtwoord_hash: nieuweHash });
          maakSessie(res, nieuweHash); // dit toestel blijft ingelogd, alle andere worden uitgelogd
          return ok(res);
        }
        case 'instellingen': return await instellingenOpslaan(b, res);
        case 'test_oproep': {
          const inst = await instellingen();
          if (!twilioKlaar()) return fout(res, 400, 'Twilio is nog niet ingesteld in Vercel (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).');
          if (!naarE164(inst.syndicus_gsm)) return fout(res, 400, 'Vul eerst het gsm-nummer van de syndicus in en bewaar.');
          const r = await bel({ naar: inst.syndicus_gsm, twimlUrl: `${site}/api/telefoon?a=test`, statusUrl: `${site}/api/telefoon?a=status&k=test` });
          return ok(res, { ok: true, naar: r.to });
        }
        case 'test_whatsapp': {
          const inst = await instellingen();
          if (!whatsappKlaar()) return fout(res, 400, 'WhatsApp is nog niet ingesteld in Vercel (TWILIO_WHATSAPP_FROM).');
          if (!naarE164(inst.syndicus_gsm)) return fout(res, 400, 'Vul eerst het gsm-nummer van de syndicus in en bewaar.');
          const tekst = 'Syndexia: dit is een testbericht van het schademeldingsplatform. WhatsApp-meldingen werken.';
          const r = await whatsapp({ naar: inst.syndicus_gsm, tekst, sjabloon: process.env.TWILIO_WA_SJABLOON_SYNDICUS, variabelen: { 1: tekst } });
          if (r.fout) return fout(res, 400, r.fout);
          return ok(res, { ok: true });
        }
        case 'test_mail': {
          const inst = await instellingen();
          const r = await verstuur({ to: inst.syndicus_email, subject: 'Testmail schademeldingsplatform', html: sjabloon({ kop: 'Het werkt!', intro: 'Dit is een testmail van het Syndexia-schademeldingsplatform. De mailinstellingen zijn correct.' }) });
          return ok(res, r);
        }
      }
    }
    return fout(res, 404, 'Onbekende actie');
  } catch (e) {
    console.error('admin', a, e);
    return fout(res, 500, e.message);
  }
}

async function overzicht(res) {
  const [meldingen, gebouwen, aannemers, inst] = await Promise.all([
    db.select('sm_meldingen', 'select=id,nummer,titel,status,urgentie,categorie,locatie,created_at,updated_at,aanvaard_op,verstuurd_op,uitgevoerd_op,gepland_op,bevestigingen,escalatie,privatief_vermoeden,melder_naam,gebouw_id,aannemer_id,manueel,manueel_uitvoerder,fotos&order=created_at.desc&limit=400'),
    db.select('sm_gebouwen', 'select=id,naam,adres,actief,qr_token&order=naam.asc'),
    db.select('sm_aannemers', 'select=*&order=firma.asc'),
    instellingen(),
  ]);
  const toew = await db.select('sm_toewijzingen', 'select=aannemer_id,gebouw_id');
  const lopend = {}, koppelingen = {};
  meldingen.filter((m) => ['wacht_aanvaarding', 'aanvaard', 'ingepland'].includes(m.status) && m.aannemer_id)
    .forEach((m) => (lopend[m.aannemer_id] = (lopend[m.aannemer_id] || 0) + 1));
  toew.forEach((t) => (koppelingen[t.aannemer_id] = (koppelingen[t.aannemer_id] || 0) + 1));
  // Kerncijfers: hoeveel open, hoeveel dringend open, wat vraagt actie, gemiddelde reactietijd aannemer
  const open = meldingen.filter((m) => OPEN_STATUSSEN.includes(m.status));
  const reactie = meldingen.filter((m) => m.aanvaard_op && m.verstuurd_op)
    .map((m) => (new Date(m.aanvaard_op) - new Date(m.verstuurd_op)) / 60000);
  const kpi = {
    open: open.length,
    dringend: open.filter((m) => m.urgentie === 'dringend').length,
    actie: open.filter((m) => m.status === 'nieuw' || m.status === 'wacht_goedkeuring' || m.escalatie).length,
    wacht: open.filter((m) => m.status === 'wacht_aanvaarding').length,
    reactie_min: reactie.length ? Math.round(reactie.reduce((s, x) => s + x, 0) / reactie.length) : null,
    afgerond_30d: meldingen.filter((m) => m.uitgevoerd_op && Date.now() - new Date(m.uitgevoerd_op) < 30 * 864e5).length,
  };
  return ok(res, {
    kpi, meldingen: meldingen.map(({ fotos, ...m }) => ({ ...m, aantal_fotos: fotos?.length || 0 })),
    gebouwen, aannemers: aannemers.map((x) => ({ ...x, lopend: lopend[x.id] || 0, koppelingen: koppelingen[x.id] || 0 })),
    instellingen: (({ wachtwoord_hash, ...rest }) => rest)(inst), // de hash gaat nooit naar de browser
    categorieen: CATEGORIEEN, statussen: STATUS,
    mail: process.env.GMAIL_USER ? 'smtp' : process.env.RESEND_API_KEY ? 'resend' : 'uit',
    ai: process.env.ANTHROPIC_API_KEY ? 'aan' : 'uit',
    telefonie: { bellen: twilioKlaar(), whatsapp: whatsappKlaar(), nuBuitenKantooruren: buitenKantooruren(inst) },
  });
}

async function melding(req, res) {
  if (!uuid(req.query.id)) return fout(res, 400, 'Ongeldige melding');
  const m = await db.one('sm_meldingen', `id=eq.${req.query.id}&select=*,gebouw:sm_gebouwen(id,naam,adres,toegang_info),aannemer:sm_aannemers(*)`);
  if (!m) return fout(res, 404, 'Niet gevonden');
  const events = await db.select('sm_events', `melding_id=eq.${m.id}&select=*&order=created_at.asc`);
  const naPaden = events.flatMap((e) => e.data?.fotos || []);
  const [fotos, na] = await Promise.all([signedUrls(m.fotos, 3600 * 6), signedUrls(naPaden, 3600 * 6)]);
  const { ip_hash, ...rest } = m;
  return ok(res, { melding: { ...rest, fotos_urls: fotos, na_fotos: na, opdracht_url: m.aannemer_token ? `/a/${m.aannemer_token}` : null, volg_url: `/t/${m.track_token}` }, events });
}

async function meldingActie(b, site, res) {
  if (!uuid(b.id)) return fout(res, 400, 'Ongeldige melding');
  const m = await db.one('sm_meldingen', `id=eq.${b.id}&select=*`);
  if (!m) return fout(res, 404, 'Niet gevonden');
  switch (b.actie) {
    case 'toewijzen': {
      if (!uuid(b.aannemer_id)) return fout(res, 400, 'Kies een aannemer');
      await doorsturen(m.id, site, { aannemerId: b.aannemer_id, door: 'syndicus', reden: 'toegewezen door de syndicus' });
      break;
    }
    case 'goedkeuren': {
      await event(m.id, 'syndicus', 'goedgekeurd', 'De syndicus keurde de herstelling goed.');
      const gelukt = await doorsturen(m.id, site, { door: 'syndicus' });
      if (!gelukt) return ok(res, { waarschuwing: 'Goedgekeurd, maar er is geen aannemer gekoppeld voor deze categorie. Wijs er een toe.' });
      break;
    }
    case 'opnieuw_versturen': {
      if (!m.aannemer_id) return fout(res, 400, 'Er is nog geen aannemer toegewezen.');
      await doorsturen(m.id, site, { aannemerId: m.aannemer_id, door: 'syndicus', reden: 'opnieuw verstuurd' });
      break;
    }
    case 'urgentie': {
      if (!['dringend', 'niet_dringend'].includes(b.waarde)) return fout(res, 400, 'Ongeldig');
      await db.update('sm_meldingen', `id=eq.${m.id}`, { urgentie: b.waarde });
      await event(m.id, 'syndicus', 'gewijzigd', `Urgentie aangepast naar ${b.waarde === 'dringend' ? 'dringend' : 'niet dringend'}.`);
      break;
    }
    case 'categorie': {
      if (!CATEGORIE_KEYS.includes(b.waarde)) return fout(res, 400, 'Ongeldig');
      await db.update('sm_meldingen', `id=eq.${m.id}`, { categorie: b.waarde });
      await event(m.id, 'syndicus', 'gewijzigd', `Categorie aangepast naar ${CATEGORIEEN[b.waarde].label}.`);
      break;
    }
    case 'afsluiten':
    case 'annuleren': {
      const status = b.actie === 'afsluiten' ? 'afgesloten' : 'geannuleerd';
      await db.update('sm_meldingen', `id=eq.${m.id}`, { status, afgesloten_op: new Date().toISOString() });
      await event(m.id, 'syndicus', status === 'afgesloten' ? 'afgesloten' : 'geannuleerd', `${status === 'afgesloten' ? 'Afgesloten' : 'Geannuleerd'} door de syndicus.${b.tekst ? ` ${tekst(b.tekst, 500)}` : ''}`);
      break;
    }
    case 'uitgevoerd': {
      await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'uitgevoerd', uitgevoerd_op: new Date().toISOString() });
      await event(m.id, 'syndicus', 'uitgevoerd', 'Door de syndicus als uitgevoerd gemarkeerd.');
      await mailBewoner(m, site, 'uitgevoerd');
      break;
    }
    case 'heropenen': {
      await db.update('sm_meldingen', `id=eq.${m.id}`, { status: m.aannemer_id || m.manueel ? 'aanvaard' : 'nieuw', afgesloten_op: null, uitgevoerd_op: null });
      await event(m.id, 'syndicus', 'heropend', 'Heropend door de syndicus.');
      break;
    }
    case 'zelf_afhandelen': {
      const uitvoerder = tekst(b.uitvoerder, 120);
      if (!uitvoerder) return fout(res, 400, 'Vul in wie de herstelling uitvoert.');
      if (['uitgevoerd', 'afgesloten', 'geannuleerd'].includes(m.status)) return fout(res, 400, 'Deze melding is al afgerond.');
      const r = await zelfAfhandelen(m, { uitvoerder, tel: tekst(b.tel, 40), datum: b.datum || null, notitie: tekst(b.notitie, 500) }, site);
      if (r.error) return fout(res, 400, r.error);
      break;
    }
    case 'manueel_plannen': {
      const r = await manueelPlannen(m, b.datum, site);
      if (r.error) return fout(res, 400, r.error);
      break;
    }
    case 'opslaan_als_aannemer': {
      // de manuele uitvoerder voortaan als aannemer gebruiken, en optioneel meteen koppelen
      const email = tekst(b.email, 160);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return fout(res, 400, 'Een geldig e-mailadres is nodig om opdrachten te kunnen sturen.');
      const a = await db.insert('sm_aannemers', {
        firma: tekst(b.firma, 120) || m.manueel_uitvoerder || 'Aannemer', email, telefoon: tekst(b.tel, 40) || m.manueel_tel,
        vakgebied: CATEGORIE_KEYS.includes(m.categorie) ? m.categorie : 'andere',
      });
      let gekoppeld = null;
      if (b.koppelen) {
        const bestaand = await db.select('sm_toewijzingen', `gebouw_id=eq.${m.gebouw_id}&categorie=eq.${enc(m.categorie)}&select=prioriteit`);
        const vrij = [1, 2].find((p) => !bestaand.some((t) => t.prioriteit === p));
        if (vrij) {
          await db.insert('sm_toewijzingen', { gebouw_id: m.gebouw_id, categorie: m.categorie, prioriteit: vrij, aannemer_id: a.id });
          gekoppeld = vrij === 1 ? 'vaste aannemer' : 'reserve-aannemer';
        }
      }
      await event(m.id, 'syndicus', 'notitie', `${a.firma} opgeslagen als aannemer${gekoppeld ? ` en gekoppeld als ${gekoppeld} voor ${CATEGORIEEN[m.categorie]?.label || m.categorie}` : ''}.`);
      return ok(res, { aannemer: a, gekoppeld, waarschuwing: b.koppelen && !gekoppeld ? 'Aannemer opgeslagen. Vaste en reserveplaats voor deze soort zijn al bezet, dus niet automatisch gekoppeld.' : null });
    }
    case 'notitie': {
      const t = tekst(b.tekst, 1500);
      if (!t) return fout(res, 400, 'Lege notitie');
      await event(m.id, 'syndicus', 'notitie', t);
      break;
    }
    default: return fout(res, 400, 'Onbekende actie');
  }
  return ok(res);
}

async function gebouwen(res) {
  const [gebouwen, toew, open] = await Promise.all([
    db.select('sm_gebouwen', 'select=*&order=naam.asc'),
    db.select('sm_toewijzingen', 'select=*'),
    db.select('sm_meldingen', `status=in.(${OPEN_STATUSSEN.join(',')})&select=gebouw_id,urgentie`),
  ]);
  return ok(res, {
    gebouwen: gebouwen.map((g) => ({
      ...g,
      toewijzingen: toew.filter((t) => t.gebouw_id === g.id),
      open: open.filter((m) => m.gebouw_id === g.id).length,
      dringend: open.filter((m) => m.gebouw_id === g.id && m.urgentie === 'dringend').length,
    })),
  });
}

async function gebouwOpslaan(b, res) {
  const rij = { naam: tekst(b.naam, 120), adres: tekst(b.adres, 200), toegang_info: tekst(b.toegang_info, 600), actief: b.actief !== false };
  if (!rij.naam) return fout(res, 400, 'Geef een naam op.');
  const g = uuid(b.id) ? (await db.update('sm_gebouwen', `id=eq.${b.id}`, rij))[0] : await db.insert('sm_gebouwen', rij);
  return ok(res, { gebouw: g });
}

async function toewijzing(b, res) {
  if (!uuid(b.gebouw_id) || ![1, 2].includes(Number(b.prioriteit))) return fout(res, 400, 'Ongeldige toewijzing');
  const cats = (Array.isArray(b.categorieen) ? b.categorieen : [b.categorie]).filter((c) => CATEGORIE_KEYS.includes(c));
  if (!cats.length) return fout(res, 400, 'Ongeldige categorie');
  for (const c of cats) {
    await db.remove('sm_toewijzingen', `gebouw_id=eq.${b.gebouw_id}&categorie=eq.${enc(c)}&prioriteit=eq.${Number(b.prioriteit)}`);
    if (uuid(b.aannemer_id)) await db.insert('sm_toewijzingen', { gebouw_id: b.gebouw_id, categorie: c, prioriteit: Number(b.prioriteit), aannemer_id: b.aannemer_id });
  }
  return ok(res);
}

async function aannemerOpslaan(b, res) {
  const rij = {
    firma: tekst(b.firma, 120), contactpersoon: tekst(b.contactpersoon, 120), email: tekst(b.email, 160),
    telefoon: tekst(b.telefoon, 40), noodnummer: tekst(b.noodnummer, 40),
    vakgebied: CATEGORIE_KEYS.includes(b.vakgebied) ? b.vakgebied : 'andere', actief: b.actief !== false,
  };
  if (!rij.firma || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rij.email || '')) return fout(res, 400, 'Firma en een geldig e-mailadres zijn verplicht.');
  const a = uuid(b.id) ? (await db.update('sm_aannemers', `id=eq.${b.id}`, rij))[0] : await db.insert('sm_aannemers', rij);
  return ok(res, { aannemer: a });
}

// Verwijderen kan enkel als de aannemer geen lopende opdrachten meer heeft.
// Zijn koppelingen aan gebouwen verdwijnen mee (on delete cascade); afgeronde meldingen
// blijven bestaan (aannemer_id wordt leeg) en de firmanaam blijft in hun tijdlijn staan.
async function aannemerVerwijderen(b, res) {
  if (!uuid(b.id)) return fout(res, 400, 'Ongeldige aannemer');
  const lopend = await db.select('sm_meldingen', `aannemer_id=eq.${b.id}&status=in.(wacht_aanvaarding,aanvaard,ingepland)&select=nummer`);
  if (lopend.length) {
    return fout(res, 409, `Deze aannemer heeft nog ${lopend.length} lopende opdracht(en): ${lopend.map((m) => m.nummer).join(', ')}. Wijs die eerst aan iemand anders toe.`);
  }
  await db.remove('sm_aannemers', `id=eq.${b.id}`);
  return ok(res);
}

async function instellingenOpslaan(b, res) {
  const patch = {
    syndicus_naam: tekst(b.syndicus_naam, 120) || 'Syndexia',
    syndicus_email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.syndicus_email || '') ? b.syndicus_email.trim() : 'beheer@syndexia.be',
    auto_doorsturen_niet_dringend: !!b.auto_doorsturen_niet_dringend,
    escalatie_dringend_min: Math.min(1440, Math.max(15, Number(b.escalatie_dringend_min) || 120)),
    herinnering_normaal_uren: Math.min(240, Math.max(4, Number(b.herinnering_normaal_uren) || 48)),
    dagrapport: !!b.dagrapport,
    noodalarm_actief: !!b.noodalarm_actief,
    noodalarm_wanneer: b.noodalarm_wanneer === 'altijd' ? 'altijd' : 'buiten_kantooruren',
    kantoor_van: Math.min(23, Math.max(0, Number(b.kantoor_van) || 8)),
    kantoor_tot: Math.min(24, Math.max(1, Number(b.kantoor_tot) || 18)),
    noodalarm_categorieen: (Array.isArray(b.noodalarm_categorieen) ? b.noodalarm_categorieen : []).filter((c) => CATEGORIE_KEYS.includes(c)),
    syndicus_gsm: tekst(b.syndicus_gsm, 40),
    syndicus_tel: tekst(b.syndicus_tel, 40),
  };
  if (patch.syndicus_gsm && !naarE164(patch.syndicus_gsm)) return fout(res, 400, 'Het gsm-nummer van de syndicus is ongeldig.');
  const [{ wachtwoord_hash, ...inst }] = await db.update('sm_instellingen', 'id=eq.1', patch);
  return ok(res, { instellingen: inst });
}
