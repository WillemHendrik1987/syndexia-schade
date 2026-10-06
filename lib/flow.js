// De "motor" van het platform: routering, statuswissels, mails en automatische opvolging.
// Alle API-bestanden roepen deze functies aan, zodat de regels maar op één plek staan.

import { db, enc, signedUrls, verwijderFotos } from './db.js';
import { verstuur, sjabloon, fotoStrip } from './mail.js';
import { CATEGORIEEN, STATUS, OPEN_STATUSSEN } from './constants.js';
import { token, fmt, esc } from './http.js';

export async function instellingen() {
  return (await db.one('sm_instellingen', 'id=eq.1&select=*')) || {
    syndicus_naam: 'Syndexia', syndicus_email: 'beheer@syndexia.be', auto_doorsturen_niet_dringend: true,
    escalatie_dringend_min: 120, herinnering_normaal_uren: 48, dagrapport: true,
  };
}

export function event(meldingId, actor, type, tekst, data = null) {
  return db.insert('sm_events', { melding_id: meldingId, actor, type, tekst, data }).catch((e) => console.error('event', e.message));
}

const catLabel = (k) => CATEGORIEEN[k]?.label || k;
const urg = (m) => (m.urgentie === 'dringend' ? 'DRINGEND' : 'Niet dringend');

// Zoek de juiste aannemer: eerst de vaste (prio 1) voor deze categorie, dan de reserve (prio 2),
// daarna de algemene aannemer van het gebouw (categorie "andere"). Wie al weigerde, slaan we over.
export async function zoekAannemer(gebouwId, categorie, uitsluiten = []) {
  const rijen = await db.select('sm_toewijzingen',
    `gebouw_id=eq.${gebouwId}&categorie=in.(${enc(categorie)},andere)&select=categorie,prioriteit,aannemer:sm_aannemers(*)`);
  const kandidaten = rijen
    .filter((r) => r.aannemer?.actief && !uitsluiten.includes(r.aannemer.id))
    .sort((a, b) => (a.categorie === categorie ? 0 : 1) - (b.categorie === categorie ? 0 : 1) || a.prioriteit - b.prioriteit);
  return kandidaten[0]?.aannemer || null;
}

async function laad(meldingId) {
  return db.one('sm_meldingen', `id=eq.${meldingId}&select=*,gebouw:sm_gebouwen(*),aannemer:sm_aannemers(*)`);
}

// ---------- een nieuwe melding verwerken ----------
export async function verwerkNieuweMelding(meldingId, site) {
  const m = await laad(meldingId);
  const inst = await instellingen();

  // Vermoedelijk privatief en niet dringend → syndicus beslist eerst (vermijdt onnodige kosten voor de VME)
  if (m.privatief_vermoeden && m.urgentie !== 'dringend') {
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'wacht_goedkeuring' });
    await event(m.id, 'systeem', 'goedkeuring_nodig', 'Vermoedelijk privatief probleem: wacht op beslissing van de syndicus.');
    await mailSyndicus(m, site, 'goedkeuring');
    return;
  }
  if (m.urgentie !== 'dringend' && !inst.auto_doorsturen_niet_dringend) {
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'wacht_goedkeuring' });
    await event(m.id, 'systeem', 'goedkeuring_nodig', 'Niet-dringende melding wacht op goedkeuring (instelling).');
    return; // komt in het dagrapport
  }
  const ok = await doorsturen(m.id, site);
  if (m.urgentie === 'dringend') await mailSyndicus(await laad(m.id), site, ok ? 'dringend' : 'geen_aannemer');
  else if (!ok) await mailSyndicus(m, site, 'geen_aannemer');
}

// Wijs toe aan een aannemer en stuur hem de opdracht met de knop "Aanvaard de opdracht".
export async function doorsturen(meldingId, site, { aannemerId = null, door = 'systeem', reden = null } = {}) {
  const m = await laad(meldingId);
  const aannemer = aannemerId
    ? await db.one('sm_aannemers', `id=eq.${aannemerId}&select=*`)
    : await zoekAannemer(m.gebouw_id, m.categorie, m.geweigerd_door || []);

  if (!aannemer) {
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'nieuw', aannemer_id: null, aannemer_token: null });
    await event(m.id, 'systeem', 'geen_aannemer', `Geen aannemer gekoppeld voor "${catLabel(m.categorie)}" in ${m.gebouw.naam}.`);
    return false;
  }
  const t = token(18);
  await db.update('sm_meldingen', `id=eq.${m.id}`, {
    status: 'wacht_aanvaarding', aannemer_id: aannemer.id, aannemer_token: t,
    verstuurd_op: new Date().toISOString(), herinneringen: 0, laatste_opvolging: null,
  });
  await event(m.id, door, 'doorgestuurd', `Opdracht verstuurd naar ${aannemer.firma}${reden ? ` (${reden})` : ''}.`, { aannemer_id: aannemer.id });
  await mailAannemer({ ...m, aannemer_token: t }, aannemer, site, { reden });
  return true;
}

// ---------- acties van de aannemer ----------
export async function aannemerActie(m, actie, data, site) {
  const nu = new Date().toISOString();
  const a = m.aannemer;
  if (actie === 'aanvaard') {
    if (m.status !== 'wacht_aanvaarding') return { error: 'Deze opdracht werd al verwerkt.' };
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'aanvaard', aanvaard_op: nu, laatste_opvolging: null });
    await event(m.id, 'aannemer', 'aanvaard', `${a.firma} heeft de opdracht aanvaard.`);
    await mailSyndicus({ ...m, status: 'aanvaard' }, site, 'aanvaard');
    await mailBewoner(m, site, 'aanvaard');
  } else if (actie === 'weiger') {
    if (m.status !== 'wacht_aanvaarding') return { error: 'Deze opdracht kan niet meer geweigerd worden.' };
    const reden = String(data.reden || '').slice(0, 500);
    await db.update('sm_meldingen', `id=eq.${m.id}`, { geweigerd_door: [...(m.geweigerd_door || []), a.id] });
    await event(m.id, 'aannemer', 'geweigerd', `${a.firma} weigerde de opdracht${reden ? `: ${reden}` : '.'}`);
    const verder = await doorsturen(m.id, site, { reden: `na weigering door ${a.firma}` });
    await mailSyndicus({ ...m }, site, verder ? 'geweigerd_doorgestuurd' : 'geweigerd_geen_reserve', { reden });
  } else if (actie === 'plan') {
    if (!['aanvaard', 'ingepland'].includes(m.status)) return { error: 'Aanvaard eerst de opdracht.' };
    const d = new Date(data.datum);
    if (Number.isNaN(d.getTime())) return { error: 'Ongeldige datum.' };
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'ingepland', gepland_op: d.toISOString(), laatste_opvolging: null });
    await event(m.id, 'aannemer', 'ingepland', `Interventie ingepland op ${fmt(d)}.${data.notitie ? ` ${String(data.notitie).slice(0, 300)}` : ''}`);
    await mailBewoner({ ...m, gepland_op: d.toISOString() }, site, 'ingepland');
  } else if (actie === 'uitgevoerd') {
    if (!['aanvaard', 'ingepland'].includes(m.status)) return { error: 'Deze opdracht staat niet open.' };
    await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'uitgevoerd', uitgevoerd_op: nu, laatste_opvolging: null });
    await event(m.id, 'aannemer', 'uitgevoerd', `${a.firma} meldt de herstelling als uitgevoerd.${data.notitie ? ` Verslag: ${String(data.notitie).slice(0, 800)}` : ''}`, { fotos: data.fotos || [] });
    await mailSyndicus({ ...m }, site, 'uitgevoerd', { notitie: data.notitie });
    await mailBewoner(m, site, 'uitgevoerd');
  } else return { error: 'Onbekende actie.' };
  return { ok: true };
}

// ---------- mails ----------
async function fotoUrls(m) { return signedUrls(m.fotos || []); }

async function mailAannemer(m, aannemer, site, { herinnering = false, reden = null } = {}) {
  const url = `${site}/a/${m.aannemer_token}`;
  const urls = await fotoUrls(m);
  const blokken = [
    { label: 'Gebouw', waarde: `${m.gebouw.naam}\n${m.gebouw.adres || ''}` },
    { label: 'Plaats', waarde: m.locatie || '—' },
    { label: 'Probleem', waarde: `${m.titel}\n${m.samenvatting || ''}` },
    { label: 'Categorie · urgentie', waarde: `${catLabel(m.categorie)} · ${urg(m)}` },
  ];
  if (m.gebouw.toegang_info) blokken.push({ label: 'Toegang', waarde: m.gebouw.toegang_info });
  if (urls.length) blokken.push({ html: fotoStrip(urls) });
  await verstuur({
    to: aannemer.email,
    subject: `${herinnering ? 'Herinnering – ' : ''}${m.urgentie === 'dringend' ? 'DRINGEND – ' : ''}Opdracht ${m.nummer}: ${m.titel} (${m.gebouw.naam})`,
    replyTo: (await instellingen()).syndicus_email,
    html: sjabloon({
      kop: herinnering ? 'Herinnering: opdracht wacht op uw aanvaarding' : 'Nieuwe herstelopdracht',
      intro: `Beste ${esc(aannemer.contactpersoon || aannemer.firma)}, Syndexia vraagt u deze herstelling uit te voeren${reden ? ` (${esc(reden)})` : ''}. Bevestig met één klik dat u de opdracht aanvaardt.`,
      urgent: m.urgentie === 'dringend', blokken,
      knop: { tekst: 'Aanvaard de opdracht', url },
      knop2: { tekst: 'Details bekijken', url },
      voet: 'Via dezelfde link kan u de interventie inplannen en melden wanneer de herstelling klaar is. Kan u de opdracht niet uitvoeren? Weiger ze via de link, dan schakelen we meteen een andere aannemer in.',
    }),
  });
}

export async function mailSyndicus(m, site, soort, extra = {}) {
  const inst = await instellingen();
  if (!m.gebouw) m = await laad(m.id);
  const titels = {
    dringend: [`Dringende melding ${m.nummer} – ${m.gebouw.naam}`, `Er kwam een dringende melding binnen. ${m.aannemer ? `De opdracht ging automatisch naar <b>${esc(m.aannemer.firma)}</b>; u krijgt bericht zodra die aanvaardt.` : ''}`],
    geen_aannemer: [`Actie nodig: geen aannemer voor ${m.nummer}`, `Voor de categorie "${esc(catLabel(m.categorie))}" is in ${esc(m.gebouw.naam)} nog geen aannemer gekoppeld. Wijs er een toe in het dashboard; de opdracht vertrekt dan meteen.`],
    goedkeuring: [`Te beoordelen: ${m.nummer} – ${m.gebouw.naam}`, `De AI vermoedt dat dit een privatief probleem is. Beslis in het dashboard of de VME dit laat herstellen.`],
    aanvaard: [`Aanvaard: ${m.nummer} door ${m.aannemer?.firma || 'aannemer'}`, `<b>${esc(m.aannemer?.firma || '')}</b> heeft de opdracht aanvaard.`],
    geweigerd_doorgestuurd: [`Geweigerd en doorgestuurd: ${m.nummer}`, `${esc(m.aannemer?.firma || 'De aannemer')} weigerde${extra.reden ? ` (“${esc(extra.reden)}”)` : ''}. De opdracht ging automatisch naar de reserve-aannemer.`],
    geweigerd_geen_reserve: [`Actie nodig: ${m.nummer} geweigerd`, `${esc(m.aannemer?.firma || 'De aannemer')} weigerde${extra.reden ? ` (“${esc(extra.reden)}”)` : ''} en er is geen reserve-aannemer. Wijs zelf iemand toe.`],
    niet_aanvaard: [`Nog niet aanvaard: ${m.nummer}`, `De dringende opdracht is na ${extra.minuten} minuten nog niet aanvaard door ${esc(m.aannemer?.firma || 'de aannemer')}. We stuurden een herinnering.`],
    escalatie: [`Escalatie: ${m.nummer}`, extra.tekst || 'De opdracht blijft onbeantwoord. Neem telefonisch contact op of wijs een andere aannemer toe.'],
    uitgevoerd: [`Uitgevoerd: ${m.nummer}`, `${esc(m.aannemer?.firma || 'De aannemer')} meldt de herstelling als uitgevoerd.${extra.notitie ? `<br><i>“${esc(extra.notitie)}”</i>` : ''} De melding sluit automatisch na 5 dagen, tenzij de bewoner aangeeft dat het probleem niet opgelost is.`],
    niet_opgelost: [`Heropend: ${m.nummer}`, `De bewoner geeft aan dat het probleem <b>niet</b> opgelost is.${extra.tekst ? `<br><i>“${esc(extra.tekst)}”</i>` : ''}`],
  };
  const [onderwerp, intro] = titels[soort] || [`Update ${m.nummer}`, ''];
  const urls = ['dringend', 'geen_aannemer', 'goedkeuring'].includes(soort) ? await fotoUrls(m) : [];
  const blokken = [
    { label: 'Gebouw · plaats', waarde: `${m.gebouw.naam} · ${m.locatie || '—'}` },
    { label: 'Probleem', waarde: `${m.titel}\n${m.samenvatting || ''}` },
    { label: 'Categorie · urgentie', waarde: `${catLabel(m.categorie)} · ${urg(m)}` },
  ];
  if (m.melder_naam || m.melder_email || m.melder_tel) {
    blokken.push({ label: 'Melder', waarde: [m.melder_naam, m.melder_appartement && `app. ${m.melder_appartement}`, m.melder_email, m.melder_tel].filter(Boolean).join(' · ') });
  }
  if (urls.length) blokken.push({ html: fotoStrip(urls) });
  await verstuur({
    to: inst.syndicus_email,
    subject: onderwerp,
    html: sjabloon({ kop: onderwerp, intro, urgent: m.urgentie === 'dringend' && ['dringend', 'niet_aanvaard', 'escalatie'].includes(soort), blokken, knop: { tekst: 'Open in dashboard', url: `${site}/#m=${m.id}` } }),
  });
}

export async function mailBewoner(m, site, soort) {
  if (!m.melder_email) return;
  if (!m.gebouw) m = await laad(m.id);
  const volg = `${site}/t/${m.track_token}`;
  const teksten = {
    ontvangen: ['Uw melding is goed ontvangen', `Bedankt om dit te melden. Uw melding <b>${m.nummer}</b> (“${esc(m.titel)}”) wordt ${m.urgentie === 'dringend' ? '<b>met voorrang</b> ' : ''}behandeld. Via de knop volgt u live de status.`],
    aanvaard: ['Een vakman neemt uw melding op', `De herstelling voor <b>${m.nummer}</b> (“${esc(m.titel)}”) werd aanvaard door de aannemer. U hoort van ons zodra er een datum is.`],
    ingepland: ['De herstelling is ingepland', `De interventie voor <b>${m.nummer}</b> staat gepland op <b>${fmt(m.gepland_op)}</b>.`],
    uitgevoerd: ['De herstelling is uitgevoerd', `De aannemer meldt dat <b>${m.nummer}</b> (“${esc(m.titel)}”) hersteld is. Klopt dat? Laat het ons weten via de knop.`],
  };
  const [kop, intro] = teksten[soort];
  await verstuur({
    to: m.melder_email,
    subject: `${kop} – ${m.nummer}`,
    html: sjabloon({
      kop, intro,
      blokken: [{ label: 'Gebouw', waarde: m.gebouw.naam }],
      knop: soort === 'uitgevoerd' ? { tekst: 'Ja, het is opgelost', url: `${volg}?opgelost=ja` } : { tekst: 'Volg uw melding', url: volg },
      knop2: soort === 'uitgevoerd' ? { tekst: 'Nee, nog niet', url: `${volg}?opgelost=nee` } : null,
    }),
  });
}

// ---------- automatische opvolging (draait elke 10 minuten) ----------
export async function opvolging(site) {
  const inst = await instellingen();
  const nu = Date.now();
  const min = (d) => (nu - new Date(d).getTime()) / 60000;
  const log = [];
  const open = await db.select('sm_meldingen', `status=in.(wacht_aanvaarding,aanvaard,ingepland,uitgevoerd)&select=*,gebouw:sm_gebouwen(*),aannemer:sm_aannemers(*)`);

  for (const m of open) {
    try {
      const sindsOpvolging = m.laatste_opvolging ? min(m.laatste_opvolging) : Infinity;
      if (m.status === 'wacht_aanvaarding' && m.verstuurd_op && m.aannemer) {
        const grens = m.urgentie === 'dringend' ? inst.escalatie_dringend_min : inst.herinnering_normaal_uren * 60;
        const leeftijd = min(m.verstuurd_op);
        if (leeftijd > grens && m.herinneringen === 0) {
          await mailAannemer(m, m.aannemer, site, { herinnering: true });
          await db.update('sm_meldingen', `id=eq.${m.id}`, { herinneringen: 1, laatste_opvolging: new Date().toISOString() });
          await event(m.id, 'systeem', 'herinnering', `Herinnering verstuurd naar ${m.aannemer.firma}.`);
          if (m.urgentie === 'dringend') await mailSyndicus(m, site, 'niet_aanvaard', { minuten: Math.round(leeftijd) });
          log.push(`${m.nummer}: herinnering`);
        } else if (leeftijd > grens * 2 && m.herinneringen >= 1 && !m.escalatie) {
          // Geen reactie na herinnering → doorschuiven naar reserve-aannemer (indien die bestaat)
          const reserve = await zoekAannemer(m.gebouw_id, m.categorie, [...(m.geweigerd_door || []), m.aannemer_id]);
          await db.update('sm_meldingen', `id=eq.${m.id}`, { escalatie: true, geweigerd_door: [...(m.geweigerd_door || []), m.aannemer_id] });
          if (reserve) {
            await event(m.id, 'systeem', 'escalatie', `${m.aannemer.firma} reageerde niet; opdracht gaat naar reserve-aannemer ${reserve.firma}.`);
            await doorsturen(m.id, site, { aannemerId: reserve.id, reden: 'geen reactie van de vorige aannemer' });
            await mailSyndicus(m, site, 'escalatie', { tekst: `${m.aannemer.firma} reageerde niet. De opdracht ging automatisch naar ${reserve.firma}.` });
          } else {
            await event(m.id, 'systeem', 'escalatie', `${m.aannemer.firma} reageerde niet en er is geen reserve-aannemer.`);
            await mailSyndicus(m, site, 'escalatie', { tekst: `${m.aannemer.firma} reageerde niet op opdracht en herinnering. Er is geen reserve-aannemer: neem telefonisch contact op${m.aannemer.telefoon ? ` (${m.aannemer.telefoon})` : ''} of wijs iemand anders toe.` });
          }
          log.push(`${m.nummer}: escalatie`);
        }
      } else if (m.status === 'aanvaard' && m.aanvaard_op) {
        const grens = m.urgentie === 'dringend' ? 24 * 60 : 5 * 24 * 60;
        if (min(m.aanvaard_op) > grens && sindsOpvolging > 3 * 24 * 60) {
          await herinnerAannemer(m, site, 'Wanneer komt u langs?', 'Deze opdracht is aanvaard maar nog niet ingepland. Kies via de knop een datum, zodat de bewoners en de syndicus op de hoogte zijn.');
          log.push(`${m.nummer}: vraag planning`);
        }
      } else if (m.status === 'ingepland' && m.gepland_op) {
        if (min(m.gepland_op) > 24 * 60 && sindsOpvolging > 2 * 24 * 60) {
          await herinnerAannemer(m, site, 'Is de herstelling uitgevoerd?', `De interventie stond gepland op ${fmt(m.gepland_op)}. Is de herstelling klaar? Meld het met één klik, of plan een nieuwe datum.`);
          if (m.herinneringen >= 2) await mailSyndicus(m, site, 'escalatie', { tekst: `De geplande interventie (${fmt(m.gepland_op)}) is nog niet als uitgevoerd gemeld.` });
          log.push(`${m.nummer}: vraag status`);
        }
      } else if (m.status === 'uitgevoerd' && m.uitgevoerd_op && min(m.uitgevoerd_op) > 5 * 24 * 60) {
        await db.update('sm_meldingen', `id=eq.${m.id}`, { status: 'afgesloten', afgesloten_op: new Date().toISOString() });
        await event(m.id, 'systeem', 'afgesloten', 'Automatisch afgesloten 5 dagen na uitvoering (geen klacht ontvangen).');
        log.push(`${m.nummer}: afgesloten`);
      }
    } catch (e) { console.error('opvolging', m.nummer, e.message); }
  }

  // Dagrapport om 7u (Belgische tijd)
  const vandaag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(new Date());
  const uur = Number(new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (inst.dagrapport && uur >= 7 && inst.laatste_dagrapport !== vandaag) {
    await db.update('sm_instellingen', 'id=eq.1', { laatste_dagrapport: vandaag });
    await dagrapport(site, inst);
    log.push('dagrapport');
  }

  // Opruimen: concepten die nooit werden ingediend (en hun foto's) na 2 dagen wissen
  const oud = new Date(nu - 2 * 24 * 3600 * 1000).toISOString();
  const verlaten = await db.select('sm_concepten', `created_at=lt.${oud}&select=id,fotos`);
  if (verlaten.length) {
    await verwijderFotos(verlaten.flatMap((c) => c.fotos || []));
    await db.remove('sm_concepten', `id=in.(${verlaten.map((c) => c.id).join(',')})`);
    log.push(`${verlaten.length} concepten opgeruimd`);
  }
  return log;
}

async function herinnerAannemer(m, site, kop, intro) {
  await verstuur({
    to: m.aannemer.email,
    subject: `${kop} – opdracht ${m.nummer} (${m.gebouw.naam})`,
    html: sjabloon({ kop, intro, blokken: [{ label: 'Opdracht', waarde: `${m.titel}\n${m.gebouw.naam}, ${m.gebouw.adres || ''}` }], knop: { tekst: 'Open de opdracht', url: `${site}/a/${m.aannemer_token}` } }),
  });
  await db.update('sm_meldingen', `id=eq.${m.id}`, { laatste_opvolging: new Date().toISOString(), herinneringen: (m.herinneringen || 0) + 1 });
  await event(m.id, 'systeem', 'opvolging', `Opvolgmail aan ${m.aannemer.firma}: ${kop}`);
}

async function dagrapport(site, inst) {
  const open = await db.select('sm_meldingen', `status=in.(${OPEN_STATUSSEN.join(',')})&select=nummer,titel,status,urgentie,created_at,gebouw:sm_gebouwen(naam),aannemer:sm_aannemers(firma)&order=urgentie.asc,created_at.asc`);
  const gisteren = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const nieuw = await db.select('sm_meldingen', `created_at=gte.${gisteren}&select=id`);
  const klaar = await db.select('sm_meldingen', `uitgevoerd_op=gte.${gisteren}&select=id`);
  if (!open.length && !nieuw.length) return;
  const rij = (m) => `<tr><td style="padding:6px 8px 6px 0;font:13px Arial;color:${m.urgentie === 'dringend' ? '#C2410C' : '#2A1A20'}">${m.urgentie === 'dringend' ? '●' : '○'} ${esc(m.nummer)}</td><td style="padding:6px 8px;font:13px Arial">${esc(m.gebouw?.naam)} – ${esc(m.titel)}</td><td style="padding:6px 0;font:12px Arial;color:#8A6A75;white-space:nowrap">${esc(STATUS[m.status]?.label)}${m.aannemer ? ` · ${esc(m.aannemer.firma)}` : ''}</td></tr>`;
  await verstuur({
    to: inst.syndicus_email,
    subject: `Dagrapport schademeldingen – ${open.length} open`,
    html: sjabloon({
      kop: 'Uw dagrapport',
      intro: `Afgelopen 24 uur: <b>${nieuw.length}</b> nieuwe melding(en), <b>${klaar.length}</b> uitgevoerd. Er staan <b>${open.length}</b> meldingen open, waarvan <b>${open.filter((m) => m.status === 'nieuw' || m.status === 'wacht_goedkeuring').length}</b> uw actie vragen.`,
      blokken: open.length ? [{ html: `<table role="presentation" width="100%" style="border-collapse:collapse">${open.map(rij).join('')}</table>` }] : [],
      knop: { tekst: 'Open het dashboard', url: site },
    }),
  });
}
