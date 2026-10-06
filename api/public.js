// Publieke API voor bewoners (geen login; toegang via de QR-token van het gebouw of de volg-token van de melding).
import { db, enc, uploadFoto, signedUrls } from '../lib/db.js';
import { analyseer } from '../lib/ai.js';
import { verwerkNieuweMelding, event, mailBewoner, mailSyndicus } from '../lib/flow.js';
import { verstuur, sjabloon } from '../lib/mail.js';
import { ok, fout, body, siteUrl, ipHash } from '../lib/http.js';
import { CATEGORIEEN, STATUS, OPEN_STATUSSEN } from '../lib/constants.js';

const MAX_FOTO_BYTES = 3.5 * 1024 * 1024;

export default async function handler(req, res) {
  const a = req.query.a;
  try {
    if (req.method === 'GET' && a === 'gebouw') return await gebouwInfo(req, res);
    if (req.method === 'GET' && a === 'volg') return await volg(req, res);
    if (req.method !== 'POST') return fout(res, 405, 'Methode niet toegelaten');
    if (a === 'analyse') return await analyse(req, res);
    if (a === 'indienen') return await indienen(req, res);
    if (a === 'bevestig') return await bevestig(req, res);
    if (a === 'feedback') return await feedback(req, res);
    return fout(res, 404, 'Onbekende actie');
  } catch (e) {
    console.error('public', a, e);
    return fout(res, 500, 'Er liep iets mis. Probeer het opnieuw of bel Syndexia.');
  }
}

async function gebouwVanToken(t) {
  if (!t || !/^[a-z0-9]{6,40}$/i.test(t)) return null;
  return db.one('sm_gebouwen', `qr_token=eq.${enc(t)}&actief=eq.true&select=id,naam,adres`);
}

async function openMeldingen(gebouwId) {
  return db.select('sm_meldingen',
    `gebouw_id=eq.${gebouwId}&status=in.(${OPEN_STATUSSEN.join(',')})&select=id,titel,categorie,locatie,status,urgentie,created_at,bevestigingen&order=created_at.desc&limit=15`);
}

async function gebouwInfo(req, res) {
  const g = await gebouwVanToken(req.query.t);
  if (!g) return fout(res, 404, 'Deze QR-code is niet (meer) geldig.');
  const open = (await openMeldingen(g.id)).map((m) => ({
    id: m.id, titel: m.titel, categorie: CATEGORIEEN[m.categorie]?.label, locatie: m.locatie,
    status: STATUS[m.status]?.label, dringend: m.urgentie === 'dringend', sinds: m.created_at, bevestigingen: m.bevestigingen,
  }));
  return ok(res, { gebouw: { naam: g.naam, adres: g.adres }, open });
}

// Beperk misbruik (en AI-kosten): max. 12 analyses per uur per toestel/IP
async function teVeel(ip, tabel, max) {
  const sinds = new Date(Date.now() - 3600 * 1000).toISOString();
  const rijen = await db.select(tabel, `ip_hash=eq.${ip}&created_at=gte.${sinds}&select=id`);
  return rijen.length >= max;
}

function leesFoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_FOTO_BYTES) return null;
  return { media_type: m[1], data: m[2], buf };
}

// Publieke versie van de AI-analyse: enkel wat de bewoner moet zien
function voorBewoner(ai) {
  return {
    titel: ai.titel, samenvatting: ai.samenvatting, categorie: CATEGORIEEN[ai.categorie]?.label,
    dringend: ai.urgentie === 'dringend', urgentie_reden: ai.urgentie_reden, noodgeval: !!ai.noodgeval,
    veiligheidsadvies: ai.veiligheidsadvies || '', vervolgvragen: ai.vervolgvragen || [],
    duplicaat_van: ai.duplicaat_van || null, privatief_vermoeden: !!ai.privatief_vermoeden,
    privatief_uitleg: ai.privatief_uitleg || '', bericht_bewoner: ai.bericht_bewoner || '',
  };
}

async function analyse(req, res) {
  const b = body(req);
  const g = await gebouwVanToken(b.t);
  if (!g) return fout(res, 404, 'Ongeldige QR-code.');
  const ip = ipHash(req);
  const open = await openMeldingen(g.id);

  // Ronde 2: antwoorden op de vervolgvragen
  if (b.concept_id) {
    const c = await db.one('sm_concepten', `id=eq.${enc(b.concept_id)}&gebouw_id=eq.${g.id}&select=*`);
    if (!c) return fout(res, 404, 'Concept niet gevonden; begin opnieuw.');
    if (c.ronde >= 2) return ok(res, { concept_id: c.id, ai: voorBewoner(c.ai) });
    const antwoorden = (Array.isArray(b.antwoorden) ? b.antwoorden : []).slice(0, 2)
      .map((x) => ({ vraag: String(x.vraag || '').slice(0, 200), antwoord: String(x.antwoord || '').slice(0, 300) }));
    const ai = await analyseer({ gebouw: g, beschrijving: c.beschrijving, locatie: c.locatie, openMeldingen: open, vorige: c.ai, antwoorden, laatsteRonde: true });
    ai.antwoorden = antwoorden;
    await db.update('sm_concepten', `id=eq.${c.id}`, { ai, ronde: 2 });
    return ok(res, { concept_id: c.id, ai: voorBewoner(ai) });
  }

  // Ronde 1: beschrijving + foto's
  if (await teVeel(ip, 'sm_concepten', 12)) return fout(res, 429, 'U deed al veel meldingen dit uur. Probeer later opnieuw of bel Syndexia.');
  const beschrijving = String(b.beschrijving || '').trim().slice(0, 2000);
  const locatie = String(b.locatie || '').trim().slice(0, 120);
  const fotos = (Array.isArray(b.fotos) ? b.fotos : []).slice(0, 4).map(leesFoto).filter(Boolean);
  if (beschrijving.length < 4 && !fotos.length) return fout(res, 400, 'Beschrijf kort het probleem of voeg een foto toe.');

  const concept = await db.insert('sm_concepten', { gebouw_id: g.id, beschrijving, locatie, ip_hash: ip });
  const paden = [];
  for (const [i, f] of fotos.entries()) {
    const ext = f.media_type.split('/')[1].replace('jpeg', 'jpg');
    paden.push(await uploadFoto(`concept/${concept.id}/${i + 1}.${ext}`, f.buf, f.media_type));
  }
  const ai = await analyseer({ gebouw: g, beschrijving, locatie, fotos, openMeldingen: open });
  const klaar = !ai.vervolgvragen?.length;
  await db.update('sm_concepten', `id=eq.${concept.id}`, { ai, fotos: paden, ronde: klaar ? 2 : 1 });
  return ok(res, { concept_id: concept.id, ai: voorBewoner(ai) });
}

async function indienen(req, res) {
  const b = body(req);
  const g = await gebouwVanToken(b.t);
  if (!g) return fout(res, 404, 'Ongeldige QR-code.');
  const c = await db.one('sm_concepten', `id=eq.${enc(b.concept_id || '')}&gebouw_id=eq.${g.id}&select=*`);
  if (!c?.ai) return fout(res, 404, 'Deze melding is verlopen; begin opnieuw.');
  const ip = ipHash(req);
  if (await teVeel(ip, 'sm_meldingen', 6)) return fout(res, 429, 'U deed al veel meldingen dit uur. Bel Syndexia bij nood.');

  const melder = b.melder || {};
  const email = String(melder.email || '').trim().slice(0, 160);
  const aanvulling = String(b.aanvulling || '').trim().slice(0, 1000);
  const ai = c.ai;
  const beschrijving = [c.beschrijving, ai.antwoorden?.map((x) => `${x.vraag} ${x.antwoord}`).join('\n'), aanvulling && `Aanvulling: ${aanvulling}`].filter(Boolean).join('\n\n');

  const m = await db.insert('sm_meldingen', {
    gebouw_id: g.id, urgentie: ai.urgentie, categorie: ai.categorie, titel: ai.titel,
    samenvatting: ai.samenvatting + (aanvulling ? `\nAanvulling bewoner: ${aanvulling}` : ''),
    beschrijving, locatie: c.locatie, ai, fotos: c.fotos || [], privatief_vermoeden: !!ai.privatief_vermoeden,
    melder_naam: String(melder.naam || '').trim().slice(0, 120) || null,
    melder_appartement: String(melder.appartement || '').trim().slice(0, 40) || null,
    melder_email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    melder_tel: String(melder.tel || '').trim().slice(0, 40) || null,
    melder_contact_aannemer: !!melder.contact_aannemer,
    ip_hash: ip,
  });
  await db.remove('sm_concepten', `id=eq.${c.id}`); // foto's blijven; ze horen nu bij de melding
  await event(m.id, 'bewoner', 'aangemaakt', `Melding ingediend via QR-code${m.melder_naam ? ` door ${m.melder_naam}` : ''}.`);
  await event(m.id, 'ai', 'analyse', `Ingedeeld als ${CATEGORIEEN[ai.categorie]?.label} – ${ai.urgentie === 'dringend' ? 'DRINGEND' : 'niet dringend'}. ${ai.urgentie_reden || ''}`,
    { vertrouwen: ai.vertrouwen, bron: ai.bron, privatief: ai.privatief_vermoeden });

  const site = siteUrl(req);
  await verwerkNieuweMelding(m.id, site);
  await mailBewoner(m, site, 'ontvangen');
  return ok(res, { nummer: m.nummer, volg: `${site}/t/${m.track_token}`, dringend: m.urgentie === 'dringend' });
}

// "Ik merk dit ook" – een bewoner bevestigt een bestaande melding i.p.v. een dubbele aan te maken
async function bevestig(req, res) {
  const b = body(req);
  const g = await gebouwVanToken(b.t);
  if (!g) return fout(res, 404, 'Ongeldige QR-code.');
  const m = await db.one('sm_meldingen', `id=eq.${enc(b.melding_id || '')}&gebouw_id=eq.${g.id}&select=id,nummer,track_token,bevestigingen,status`);
  if (!m || !OPEN_STATUSSEN.includes(m.status)) return fout(res, 404, 'Deze melding staat niet meer open.');
  await db.update('sm_meldingen', `id=eq.${m.id}`, { bevestigingen: (m.bevestigingen || 0) + 1 });
  const extra = String(b.opmerking || '').trim().slice(0, 500);
  await event(m.id, 'bewoner', 'bevestiging', `Nog een bewoner meldt hetzelfde probleem.${extra ? ` “${extra}”` : ''}`);
  if (b.concept_id) await db.remove('sm_concepten', `id=eq.${enc(b.concept_id)}&gebouw_id=eq.${g.id}`);
  return ok(res, { nummer: m.nummer, volg: `${siteUrl(req)}/t/${m.track_token}` });
}

const PUBLIEKE_EVENTS = ['aangemaakt', 'analyse', 'doorgestuurd', 'aanvaard', 'ingepland', 'uitgevoerd', 'afgesloten', 'heropend', 'bevestiging', 'goedgekeurd'];

async function volg(req, res) {
  const k = String(req.query.k || '');
  if (!/^[a-f0-9]{32}$/.test(k)) return fout(res, 404, 'Onbekende melding.');
  const m = await db.one('sm_meldingen', `track_token=eq.${k}&select=id,nummer,titel,samenvatting,status,urgentie,categorie,locatie,created_at,gepland_op,uitgevoerd_op,fotos,opgelost_feedback,gebouw:sm_gebouwen(naam,adres),aannemer:sm_aannemers(firma)`);
  if (!m) return fout(res, 404, 'Onbekende melding.');
  const ev = await db.select('sm_events', `melding_id=eq.${m.id}&type=in.(${PUBLIEKE_EVENTS.join(',')})&select=type,actor,tekst,created_at&order=created_at.asc`);
  return ok(res, {
    nummer: m.nummer, titel: m.titel, samenvatting: m.samenvatting, status: m.status, status_label: STATUS[m.status]?.label,
    dringend: m.urgentie === 'dringend', categorie: CATEGORIEEN[m.categorie]?.label, locatie: m.locatie,
    gebouw: m.gebouw?.naam, aannemer: m.aannemer?.firma || null, created_at: m.created_at, gepland_op: m.gepland_op,
    uitgevoerd_op: m.uitgevoerd_op, feedback: m.opgelost_feedback, fotos: await signedUrls(m.fotos, 3600),
    tijdlijn: ev.map((e) => ({ type: e.type, tekst: e.type === 'doorgestuurd' ? 'Opdracht doorgegeven aan een vakman.' : e.tekst, op: e.created_at })),
  });
}

async function feedback(req, res) {
  const b = body(req);
  const k = String(b.k || '');
  if (!/^[a-f0-9]{32}$/.test(k)) return fout(res, 404, 'Onbekende melding.');
  const m = await db.one('sm_meldingen', `track_token=eq.${k}&select=*,gebouw:sm_gebouwen(*),aannemer:sm_aannemers(*)`);
  if (!m) return fout(res, 404, 'Onbekende melding.');
  if (!['uitgevoerd', 'afgesloten'].includes(m.status)) return fout(res, 400, 'Deze melding is nog niet als uitgevoerd gemeld.');
  const site = siteUrl(req);
  const tekst = String(b.tekst || '').trim().slice(0, 600);
  if (b.opgelost === 'ja') {
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'afgesloten', afgesloten_op: new Date().toISOString(), opgelost_feedback: 'ja' });
    await event(m.id, 'bewoner', 'afgesloten', 'De bewoner bevestigt dat het probleem opgelost is.');
  } else {
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'aanvaard', uitgevoerd_op: null, afgesloten_op: null, opgelost_feedback: 'nee', laatste_opvolging: new Date().toISOString() });
    await event(m.id, 'bewoner', 'heropend', `De bewoner meldt dat het probleem niet opgelost is.${tekst ? ` “${tekst}”` : ''}`);
    await mailSyndicus(m, site, 'niet_opgelost', { tekst });
    if (m.aannemer) {
      await verstuur({
        to: m.aannemer.email, subject: `Niet opgelost – opdracht ${m.nummer} (${m.gebouw.naam})`,
        html: sjabloon({ kop: 'De bewoner meldt: nog niet opgelost', intro: `Volgens de bewoner is het probleem van opdracht <b>${m.nummer}</b> nog niet verholpen.${tekst ? `<br><i>“${tekst.replace(/</g, '&lt;')}”</i>` : ''} Plan aub een nieuwe interventie.`, blokken: [{ label: 'Opdracht', waarde: `${m.titel}\n${m.gebouw.naam}` }], knop: { tekst: 'Open de opdracht', url: `${site}/a/${m.aannemer_token}` } }),
      });
    }
  }
  return ok(res, { ok: true });
}
