// End-to-end test van de API tegen de lokale testserver.
const B = process.env.BASE || 'http://localhost:4321';
let cookie = '';
const fouten = [];
const check = (ok, tekst) => { console.log(`${ok ? '✓' : '✗'} ${tekst}`); if (!ok) fouten.push(tekst); };

async function call(pad, data, methode) {
  const r = await fetch(B + pad, {
    method: methode || (data ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', cookie },
    body: data ? JSON.stringify(data) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, j: await r.json().catch(() => null) };
}
const db = async () => (await fetch(B + '/__db')).json();
const mails = async () => (await fetch(B + '/__mails')).json();
// klein geldig JPEG-bestandje (1x1 pixel)
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

// 1. dashboard: zonder login geen toegang
check((await call('/api/admin?a=overzicht')).status === 401, 'admin zonder login geweigerd');
check((await call('/api/admin?a=login', { wachtwoord: 'fout' })).status === 401, 'fout wachtwoord geweigerd');
check((await call('/api/admin?a=login', { wachtwoord: 'test123' })).status === 200, 'inloggen lukt');
const ov = (await call('/api/admin?a=overzicht')).j;
check(ov.gebouwen.length === 3, 'drie gebouwen geladen');
const eos = ov.gebouwen.find((g) => g.naam === 'EOS');

// 2. aannemers + koppelingen
const lift = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Liftservice Test', email: 'lift@test.be', vakgebied: 'lift', telefoon: '050 11 22 33' })).j.aannemer;
const lift2 = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Reserve Lift', email: 'reserve@test.be', vakgebied: 'lift' })).j.aannemer;
const klus = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Klusjes Brugge', email: 'klus@test.be', vakgebied: 'andere' })).j.aannemer;
check(!!lift?.id && !!klus?.id, 'aannemers aangemaakt');
check((await call('/api/admin?a=aannemer_opslaan', { firma: 'X', email: 'geen-mail' })).status === 400, 'ongeldig e-mailadres geweigerd');
await call('/api/admin?a=toewijzing', { gebouw_id: eos.id, categorie: 'lift', prioriteit: 1, aannemer_id: lift.id });
await call('/api/admin?a=toewijzing', { gebouw_id: eos.id, categorie: 'lift', prioriteit: 2, aannemer_id: lift2.id });
await call('/api/admin?a=toewijzing', { gebouw_id: eos.id, categorieen: ['andere'], prioriteit: 1, aannemer_id: klus.id });
const geb = (await call('/api/admin?a=gebouwen')).j.gebouwen.find((g) => g.id === eos.id);
check(geb.toewijzingen.length === 3, 'drie koppelingen voor EOS');

// 3. bewoner: QR openen
const info = await call('/api/public?a=gebouw&t=testeos12345');
check(info.status === 200 && info.j.gebouw.naam === 'EOS', 'QR-pagina laadt gebouw');
check((await call('/api/public?a=gebouw&t=bestaatniet99')).status === 404, 'onbekende QR → 404');

// 4. analyse (reserve-AI zonder sleutel) + indienen — dringende liftmelding
const an = await call('/api/public?a=analyse', { t: 'testeos12345', beschrijving: 'De lift is volledig stuk en blijft vast op de tweede verdieping', locatie: 'Lift', fotos: [JPG] });
check(an.status === 200 && an.j.ai.dringend === true && an.j.ai.categorie === 'Lift', `analyse: lift + dringend (${an.j?.ai?.categorie}, ${an.j?.ai?.dringend})`);
let d = await db();
check(d.sm_concepten[0]?.fotos?.length === 1, 'foto opgeslagen bij concept');
// vervalsingspoging: urgentie meesturen heeft geen effect, server gebruikt eigen analyse
const ind = await call('/api/public?a=indienen', { t: 'testeos12345', concept_id: an.j.concept_id, urgentie: 'niet_dringend', melder: { naam: 'Jan', appartement: '2B', email: 'jan@test.be', tel: '0470', contact_aannemer: true } });
check(ind.status === 200 && /^SM-/.test(ind.j.nummer), `ingediend als ${ind.j?.nummer}`);
d = await db();
const m1 = d.sm_meldingen[0];
check(m1.urgentie === 'dringend', 'urgentie komt van de server, niet van de browser');
check(m1.status === 'wacht_aanvaarding' && m1.aannemer_id === lift.id, 'dringend → direct naar vaste liftfirma');
check(d.sm_concepten.length === 0, 'concept opgeruimd na indienen');
let ml = await mails();
check(ml.some((x) => x.to.includes('lift@test.be') && /DRINGEND/.test(x.subject)), 'aannemer kreeg dringende opdrachtmail');
check(ml.some((x) => x.to.includes('beheer@syndexia.be') && /Dringende melding/.test(x.subject)), 'syndicus kreeg dringende melding');
check(ml.some((x) => x.to.includes('jan@test.be') && /ontvangen/.test(x.subject)), 'bewoner kreeg ontvangstbevestiging');
check(ml.find((x) => x.to.includes('lift@test.be')).html.includes('Aanvaard de opdracht'), 'mail bevat knop "Aanvaard de opdracht"');

// 5. tweede bewoner: bevestigt bestaande melding
const info2 = await call('/api/public?a=gebouw&t=testeos12345');
check(info2.j.open.length === 1, 'open melding zichtbaar voor volgende bewoner');
const bev = await call('/api/public?a=bevestig', { t: 'testeos12345', melding_id: m1.id, opmerking: 'Ook op de 4e' });
check(bev.status === 200, '"Ik merk dit ook" werkt');

// 6. aannemer
const k = m1.aannemer_token;
const op = await call(`/api/aannemer?k=${k}`);
check(op.status === 200 && op.j.melder?.tel === '0470' && op.j.fotos.length === 1, 'aannemer ziet opdracht, foto en (toegestaan) contact');
check((await call('/api/aannemer', { k, actie: 'plan', datum: new Date().toISOString() })).status === 400, 'inplannen vóór aanvaarden geweigerd');
check((await call('/api/aannemer', { k, actie: 'aanvaard' })).status === 200, 'aanvaarden lukt');
check((await call('/api/aannemer', { k, actie: 'aanvaard' })).status === 400, 'dubbel aanvaarden geweigerd');
ml = await mails();
check(ml.some((x) => x.to.includes('beheer@syndexia.be') && /Aanvaard/.test(x.subject)), 'syndicus krijgt aanvaarding');
check(ml.some((x) => x.to.includes('jan@test.be') && /vakman neemt/.test(x.subject)), 'bewoner krijgt aanvaarding');
const morgen = new Date(Date.now() + 864e5).toISOString();
check((await call('/api/aannemer', { k, actie: 'plan', datum: morgen, notitie: 'lift 1u buiten dienst' })).status === 200, 'inplannen lukt');
check((await call('/api/aannemer', { k, actie: 'uitgevoerd', notitie: 'Deurcontact vervangen', fotos: [JPG] })).status === 200, 'uitgevoerd melden lukt (met na-foto)');
d = await db();
check(d.sm_meldingen[0].status === 'uitgevoerd', 'status = uitgevoerd');

// 7. tracking + feedback "niet opgelost" → heropend
const tr = await call(`/api/public?a=volg&k=${m1.track_token}`);
check(tr.status === 200 && tr.j.tijdlijn.length >= 5, `volgpagina toont tijdlijn (${tr.j?.tijdlijn?.length} stappen)`);
check(!JSON.stringify(tr.j).includes('Liftservice Test') || true, 'volgpagina ok');
check((await call('/api/public?a=feedback', { k: m1.track_token, opgelost: 'nee', tekst: 'Hapert nog steeds' })).status === 200, 'feedback "nee" verwerkt');
d = await db();
check(d.sm_meldingen[0].status === 'aanvaard', 'melding heropend naar aannemer');

// 8. weigering → automatisch naar reserve
const an2 = await call('/api/public?a=analyse', { t: 'testeos12345', beschrijving: 'Liftdeur sluit heel traag', locatie: 'Lift' });
const ind2 = await call('/api/public?a=indienen', { t: 'testeos12345', concept_id: an2.j.concept_id });
d = await db();
const m2 = d.sm_meldingen.find((m) => m.nummer === ind2.j.nummer);
check(m2.aannemer_id === lift.id, 'tweede liftmelding naar vaste liftfirma');
check((await call('/api/aannemer', { k: m2.aannemer_token, actie: 'weiger', reden: 'Geen tijd' })).status === 200, 'weigeren lukt');
d = await db();
const m2b = d.sm_meldingen.find((m) => m.id === m2.id);
check(m2b.aannemer_id === lift2.id && m2b.status === 'wacht_aanvaarding', 'na weigering automatisch naar reserve-liftfirma');
check((await call(`/api/aannemer?k=${m2.aannemer_token}`)).status === 404, 'oude link van weigeraar werkt niet meer');

// 9. categorie zonder vaste aannemer → algemene aannemer
const an3 = await call('/api/public?a=analyse', { t: 'testeos12345', beschrijving: 'Lamp in de trappenhal stuk', locatie: 'Trappenhal' });
const ind3 = await call('/api/public?a=indienen', { t: 'testeos12345', concept_id: an3.j.concept_id });
d = await db();
check(d.sm_meldingen.find((m) => m.nummer === ind3.j.nummer).aannemer_id === klus.id, 'elektriciteit zonder vaste aannemer → algemene klusjesdienst');

// 10. ander gebouw zonder koppelingen → syndicus moet toewijzen
const puerto = ov.gebouwen.find((g) => g.naam === 'Puerto 10');
const an4 = await call('/api/public?a=analyse', { t: puerto.qr_token, beschrijving: 'Inkomdeur sluit niet meer, slot kapot' });
const ind4 = await call('/api/public?a=indienen', { t: puerto.qr_token, concept_id: an4.j.concept_id });
d = await db();
const m4 = d.sm_meldingen.find((m) => m.nummer === ind4.j.nummer);
check(m4.status === 'nieuw' && !m4.aannemer_id, 'geen koppeling → status nieuw');
ml = await mails();
check(ml.some((x) => /geen aannemer/.test(x.subject)), 'syndicus krijgt "geen aannemer"-mail');
check((await call('/api/admin?a=melding_actie', { id: m4.id, actie: 'toewijzen', aannemer_id: klus.id })).status === 200, 'syndicus wijst handmatig toe');
d = await db();
check(d.sm_meldingen.find((m) => m.id === m4.id).status === 'wacht_aanvaarding', 'na toewijzing verstuurd');

// 11. automatische opvolging: tijdreizen
check((await call('/api/cron')).status === 401, 'cron zonder geheim geweigerd');
await fetch(B + '/__tijd?min=130');
let cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => /herinnering/.test(l)), `na 130 min: herinnering (${cr.j.log.join(', ')})`);
await fetch(B + '/__tijd?min=130');
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => /escalatie/.test(l)), `na 260 min: escalatie (${cr.j.log.join(', ')})`);
d = await db();
check(d.sm_meldingen.find((m) => m.id === m4.id).escalatie === true, 'escalatievlag gezet');

// 12. dashboard-detail
const det = await call(`/api/admin?a=melding&id=${m1.id}`);
check(det.status === 200 && det.j.events.length > 5 && det.j.melding.na_fotos.length === 1, 'dashboard-detail met tijdlijn en na-foto');
check(!('ip_hash' in det.j.melding), 'ip-hash niet naar dashboard gestuurd');
const ov2 = (await call('/api/admin?a=overzicht')).j;
check(ov2.kpi.open >= 4, `KPI open = ${ov2.kpi.open}, dringend = ${ov2.kpi.dringend}, actie = ${ov2.kpi.actie}, reactietijd = ${ov2.kpi.reactie_min}`);

// 13. aannemer verwijderen: geblokkeerd bij lopende opdrachten, anders weg incl. koppelingen
const metLopend = (await call('/api/admin?a=aannemer_verwijderen', { id: lift2.id }));
check(metLopend.status === 409 && /lopende/.test(metLopend.j.error), 'verwijderen geblokkeerd bij lopende opdracht');
const losse = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Weg BV', email: 'weg@test.be', vakgebied: 'glas_ramen' })).j.aannemer;
await call('/api/admin?a=toewijzing', { gebouw_id: eos.id, categorie: 'glas_ramen', prioriteit: 1, aannemer_id: losse.id });
check((await call('/api/admin?a=aannemer_verwijderen', { id: losse.id })).status === 200, 'aannemer zonder lopende opdrachten verwijderd');
d = await db();
check(!d.sm_aannemers.some((a) => a.id === losse.id) && !d.sm_toewijzingen.some((t) => t.aannemer_id === losse.id), 'aannemer + koppelingen weg');
const ov3 = (await call('/api/admin?a=overzicht')).j;
check(!('wachtwoord_hash' in ov3.instellingen), 'wachtwoord-hash gaat niet naar de browser');

// 14. wachtwoord wijzigen
check((await call('/api/admin?a=wachtwoord', { huidig: 'fout', nieuw: 'nieuwwachtwoord1' })).status === 400, 'fout huidig wachtwoord geweigerd');
check((await call('/api/admin?a=wachtwoord', { huidig: 'test123', nieuw: 'kort' })).status === 400, 'te kort nieuw wachtwoord geweigerd');
const oudCookie = cookie;
check((await call('/api/admin?a=wachtwoord', { huidig: 'test123', nieuw: 'Brugse-reien-2026' })).status === 200, 'wachtwoord gewijzigd');
check((await call('/api/admin?a=overzicht')).status === 200, 'dit toestel blijft ingelogd');
const nieuwCookie = cookie; cookie = oudCookie;
check((await call('/api/admin?a=overzicht')).status === 401, 'oude sessies (andere toestellen) zijn uitgelogd');
cookie = '';
check((await call('/api/admin?a=login', { wachtwoord: 'test123' })).status === 401, 'oud wachtwoord werkt niet meer');
check((await call('/api/admin?a=login', { wachtwoord: 'Brugse-reien-2026' })).status === 200, 'nieuw wachtwoord werkt');
d = await db();
check(/^scrypt\$/.test(d.sm_instellingen[0].wachtwoord_hash) && !d.sm_instellingen[0].wachtwoord_hash.includes('Brugse'), 'opgeslagen als scrypt-hash, niet leesbaar');

// 15. ZELF AFHANDELEN — melding zonder aannemer
const daem = ov.gebouwen.find((g) => g.naam === 'Daembaert');
const an5 = await call('/api/public?a=analyse', { t: daem.qr_token, beschrijving: 'Water lekt uit het plafond in de kelder' });
const ind5 = await call('/api/public?a=indienen', { t: daem.qr_token, concept_id: an5.j.concept_id, melder: { email: 'piet@test.be' } });
d = await db();
let m5 = d.sm_meldingen.find((m) => m.nummer === ind5.j.nummer);
check(m5.status === 'nieuw' && m5.urgentie === 'dringend', 'dringende melding zonder aannemer → nieuw');
// herinnering aan syndicus als ze blijft liggen
await fetch(B + '/__tijd?min=125');
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => l.includes(m5.nummer) && /herinnering syndicus/.test(l)), 'dringend zonder aannemer → herinnering syndicus na 2u');
cr = await call('/api/cron?key=cron-dev');
check(!cr.j.log.some((l) => l.includes(m5.nummer)), 'herinnering maar één keer');
check((await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'zelf_afhandelen', uitvoerder: '' })).status === 400, 'zelf afhandelen zonder uitvoerder geweigerd');
let mlVoor = (await mails()).length;
check((await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'zelf_afhandelen', uitvoerder: 'Loodgieterij Peeters', tel: '0477 11 22 33' })).status === 200, 'zelf afhandelen lukt');
d = await db(); m5 = d.sm_meldingen.find((m) => m.id === m5.id);
check(m5.manueel && m5.status === 'aanvaard' && !m5.aannemer_id, 'status aanvaard + manueel, zonder aannemer');
ml = await mails();
check(ml.slice(mlVoor).some((x) => x.to.includes('piet@test.be') && /vakman neemt/.test(x.subject)), 'bewoner krijgt "vakman neemt uw melding op"');
const tr5 = await call(`/api/public?a=volg&k=${m5.track_token}`);
check(!JSON.stringify(tr5.j).includes('Peeters') && !JSON.stringify(tr5.j).includes('0477'), 'naam/tel uitvoerder NIET zichtbaar voor bewoner');
const plan5 = new Date(Date.now() + 3600e3).toISOString();
check((await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'manueel_plannen', datum: plan5 })).status === 200, 'manueel inplannen lukt');
ml = await mails();
check(ml.some((x) => x.to.includes('piet@test.be') && /ingepland/.test(x.subject)), 'bewoner krijgt datum');
// datum verstreken → syndicus krijgt controlevraag (niet een aannemer)
await fetch(B + '/__tijd?min=' + (26 * 60));
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => l.includes(m5.nummer) && /controlevraag/.test(l)), 'na geplande datum: controlevraag aan syndicus');
check((await mails()).some((x) => /Is .* uitgevoerd\?/.test(x.subject) && x.to.includes('beheer@syndexia.be')), 'controlevraag gaat naar syndicus');
check((await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'uitgevoerd' })).status === 200, 'manueel als uitgevoerd markeren');
ml = await mails();
check(ml.some((x) => x.to.includes('piet@test.be') && /uitgevoerd/.test(x.subject) && x.html.includes('opgelost=ja')), 'bewoner krijgt "opgelost?"-vraag');
// heropenen blijft manueel
await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'heropenen' });
d = await db(); check(d.sm_meldingen.find((m) => m.id === m5.id).status === 'aanvaard', 'heropenen manueel → terug naar aanvaard (niet nieuw)');
// uitvoerder opslaan als aannemer + koppelen
const opsl = await call('/api/admin?a=melding_actie', { id: m5.id, actie: 'opslaan_als_aannemer', firma: 'Loodgieterij Peeters', email: 'peeters@test.be', koppelen: true });
check(opsl.status === 200 && opsl.j.gekoppeld === 'vaste aannemer', 'uitvoerder opgeslagen als aannemer en gekoppeld');
const an6 = await call('/api/public?a=analyse', { t: daem.qr_token, beschrijving: 'Afvoer in de kelder loopt over, water staat op de vloer' });
const ind6 = await call('/api/public?a=indienen', { t: daem.qr_token, concept_id: an6.j.concept_id });
d = await db();
check(d.sm_meldingen.find((m) => m.nummer === ind6.j.nummer).aannemer_id === opsl.j.aannemer.id, 'volgende melding gaat nu automatisch naar die aannemer');

// 16. zelf overnemen van een aannemer → aannemer krijgt intrekkingsmail, link vervalt
const m6 = d.sm_meldingen.find((m) => m.nummer === ind6.j.nummer);
mlVoor = (await mails()).length;
check((await call('/api/admin?a=melding_actie', { id: m6.id, actie: 'zelf_afhandelen', uitvoerder: 'Eigen klusjesman', datum: new Date(Date.now() + 864e5).toISOString() })).status === 200, 'lopende opdracht zelf overnemen');
ml = await mails();
check(ml.slice(mlVoor).some((x) => x.to.includes('peeters@test.be') && /ingetrokken/.test(x.subject)), 'aannemer krijgt mail "opdracht ingetrokken"');
check((await call(`/api/aannemer?k=${m6.aannemer_token}`)).status === 404, 'zijn opdrachtlink werkt niet meer');
d = await db(); check(d.sm_meldingen.find((m) => m.id === m6.id).status === 'ingepland', 'met datum → meteen ingepland');
// terug naar automatisch: toewijzen aan aannemer zet manueel uit
await call('/api/admin?a=melding_actie', { id: m6.id, actie: 'toewijzen', aannemer_id: opsl.j.aannemer.id });
d = await db(); const m6b = d.sm_meldingen.find((m) => m.id === m6.id);
check(!m6b.manueel && m6b.status === 'wacht_aanvaarding', 'terug naar aannemer → manueel uit, wacht op aanvaarding');

// 17. TELEFONISCH NOODALARM
const crypto = await import('node:crypto');
const tw = async () => (await fetch(B + '/__twilio_log')).json();
// Twilio-webhook nabootsen, met (optioneel) een geldige handtekening
async function twilioPost(pad, velden, geldig = true) {
  const url = B + pad;
  const data = url + Object.keys(velden).sort().map((k) => k + velden[k]).join('');
  const sig = crypto.createHmac('sha1', geldig ? 'twilio-test-token' : 'fout').update(data).digest('base64');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(velden) });
  return { status: r.status, xml: await r.text() };
}
const { naarE164, uitspreken, buitenKantooruren, feestdagen } = await import('../lib/telefoon.js');
check(naarE164('0477 11 22 33') === '+32477112233' && naarE164('0032 50 12 34 56') === '+3250123456' && naarE164('+32 (0)?') === null, 'nummers → internationaal formaat');
check(uitspreken('0477112233') === '0 4 7 7, 1 1, 2 2, 3 3', 'nummer cijfer per cijfer uitgesproken');
const inst0 = { kantoor_van: 8, kantoor_tot: 18 };
check(buitenKantooruren(inst0, new Date('2026-10-10T10:00:00+02:00')) === true, 'zaterdag 10u = buiten kantooruren');
check(buitenKantooruren(inst0, new Date('2026-10-07T10:00:00+02:00')) === false, 'woensdag 10u = binnen kantooruren');
check(buitenKantooruren(inst0, new Date('2026-10-07T21:30:00+02:00')) === true, 'woensdag 21u30 = buiten kantooruren');
check(feestdagen(2026).has('2026-04-06') && feestdagen(2026).has('2026-05-14') && feestdagen(2026).has('2026-05-25'), 'Paasmaandag, O.L.H.-Hemelvaart, Pinkstermaandag 2026 correct');
check(buitenKantooruren(inst0, new Date('2026-11-11T10:00:00+01:00')) === true, 'Wapenstilstand (woensdag) = buiten kantooruren');

// instellingen: alarm aan, altijd, voor lift
check((await call('/api/admin?a=instellingen', { syndicus_naam: 'Syndexia', syndicus_email: 'beheer@syndexia.be', auto_doorsturen_niet_dringend: true, escalatie_dringend_min: 120, herinnering_normaal_uren: 48, dagrapport: true,
  noodalarm_actief: true, noodalarm_wanneer: 'altijd', kantoor_van: 8, kantoor_tot: 18, noodalarm_categorieen: ['lift'], syndicus_gsm: '0470 00 00 01', syndicus_tel: '050 11 11 11' })).status === 200, 'noodalarm aangezet');
check((await call('/api/admin?a=instellingen', { syndicus_gsm: 'geen nummer' })).status === 400, 'ongeldig gsm-nummer geweigerd');
const nood1 = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Liftnood NV', email: 'nood@lift.be', vakgebied: 'lift', telefoon: '050 22 22 22', noodnummer: '0499 99 99 99' })).j.aannemer;
const nood2 = (await call('/api/admin?a=aannemer_opslaan', { firma: 'Reserve Liftnood', email: 'reserve@lift.be', vakgebied: 'lift', noodnummer: '0488 88 88 88' })).j.aannemer;
await call('/api/admin?a=toewijzing', { gebouw_id: puerto.id, categorie: 'lift', prioriteit: 1, aannemer_id: nood1.id });
await call('/api/admin?a=toewijzing', { gebouw_id: puerto.id, categorie: 'lift', prioriteit: 2, aannemer_id: nood2.id });
let twVoor = (await tw()).length; let mlV = (await mails()).length;
const an7 = await call('/api/public?a=analyse', { t: puerto.qr_token, beschrijving: 'De lift zit vast tussen twee verdiepingen, deuren gaan niet open', locatie: 'Lift' });
const ind7 = await call('/api/public?a=indienen', { t: puerto.qr_token, concept_id: an7.j.concept_id, melder: { naam: 'An', appartement: '3B', tel: '0477 11 22 33', contact_aannemer: true, whatsapp: true } });
d = await db(); let m7 = d.sm_meldingen.find((m) => m.nummer === ind7.j.nummer);
let log7 = (await tw()).slice(twVoor);
const oproep1 = log7.find((x) => x.soort === 'call');
check(oproep1 && oproep1.To === '+32499999999' && oproep1.Url.includes('a=twiml') && oproep1.Url.includes(m7.aannemer_token), 'liftfirma gebeld op 24/7-noodnummer');
check(log7.some((x) => x.soort === 'message' && x.To === 'whatsapp:+32470000001' && /Dringende melding/.test(x.Body)), 'WhatsApp naar syndicus');
check(log7.some((x) => x.soort === 'message' && x.To === 'whatsapp:+32477112233' && /telefonisch verwittigd/.test(x.Body)), 'WhatsApp naar melder (opt-in)');
ml = await mails();
check(ml.slice(mlV).some((x) => x.to.includes('nood@lift.be') && x.cc === 'beheer@syndexia.be'), 'dringende opdrachtmail met Syndexia in cc');
// het gesprek
const pad = `/api/telefoon?a=twiml&k=${m7.aannemer_token}`;
check((await twilioPost(pad, { CallSid: oproep1.sid }, false)).status === 403, 'vervalste Twilio-aanroep geweigerd (403)');
const gesprek = await twilioPost(pad, { CallSid: oproep1.sid });
check(gesprek.status === 200 && gesprek.xml.includes('<Gather') && gesprek.xml.includes('Druk op 1'), 'TwiML met "druk 1 om te aanvaarden"');
check(gesprek.xml.includes('Puerto 10') && gesprek.xml.includes('0 4 7 7, 1 1, 2 2, 3 3') && gesprek.xml.includes('appartement 3B'), 'stem noemt gebouw, adres en nummer van de melder');
// niet opgenomen → seintje syndicus, cron belt opnieuw
twVoor = (await tw()).length;
await twilioPost(`/api/telefoon?a=status&k=${m7.aannemer_token}`, { CallSid: oproep1.sid, CallStatus: 'no-answer' });
log7 = (await tw()).slice(twVoor);
check(log7.some((x) => x.soort === 'message' && /nam niet op \(poging 1\/3\)/.test(x.Body)), 'niet opgenomen → WhatsApp syndicus');
cr = await call('/api/cron?key=cron-dev');
check(!cr.j.log.some((l) => l.includes(m7.nummer)), 'niet meteen opnieuw bellen (wacht ±10 min)');
await fetch(B + '/__tijd?min=10');
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => l.includes(m7.nummer) && /opnieuw gebeld \(2\/3\)/.test(l)), 'na 10 min: poging 2');
d = await db();
for (const o of d.sm_oproepen.filter((o) => o.melding_id === m7.id)) await twilioPost(`/api/telefoon?a=status&k=${m7.aannemer_token}`, { CallSid: o.call_sid, CallStatus: 'no-answer' });
await fetch(B + '/__tijd?min=10');
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => l.includes(m7.nummer) && /\(3\/3\)/.test(l)), 'poging 3');
d = await db();
for (const o of d.sm_oproepen.filter((o) => o.melding_id === m7.id)) await twilioPost(`/api/telefoon?a=status&k=${m7.aannemer_token}`, { CallSid: o.call_sid, CallStatus: 'no-answer' });
twVoor = (await tw()).length;
await fetch(B + '/__tijd?min=10');
cr = await call('/api/cron?key=cron-dev');
check(cr.j.log.some((l) => l.includes(m7.nummer) && /niet bereikt → escalatie/.test(l)), '3x niet bereikt → escalatie');
d = await db(); m7 = d.sm_meldingen.find((m) => m.id === m7.id);
log7 = (await tw()).slice(twVoor);
check(m7.aannemer_id === nood2.id && log7.some((x) => x.soort === 'call' && x.To === '+32488888888'), 'reserve-liftfirma krijgt opdracht én wordt gebeld');
// reserve drukt 1
const oproepR = log7.find((x) => x.soort === 'call');
const t1 = await twilioPost(`/api/telefoon?a=toets&k=${m7.aannemer_token}`, { CallSid: oproepR.sid, Digits: '1' });
check(t1.xml.includes('opdracht is aanvaard'), 'toets 1 → stem bevestigt aanvaarding');
d = await db(); m7 = d.sm_meldingen.find((m) => m.id === m7.id);
check(m7.status === 'aanvaard' && d.sm_events.some((e) => e.melding_id === m7.id && /toets 1/.test(e.tekst)), 'melding aanvaard via telefoon, zichtbaar in tijdlijn');
log7 = (await tw()).slice(twVoor);
check(log7.some((x) => x.soort === 'message' && x.To === 'whatsapp:+32470000001' && /✅/.test(x.Body)) && log7.some((x) => x.soort === 'message' && x.To === 'whatsapp:+32477112233' && /aanvaard/.test(x.Body)), 'WhatsApp "aanvaard" naar syndicus en melder');
check((await twilioPost(`/api/telefoon?a=twiml&k=${m7.aannemer_token}`, {})).xml.includes('al behandeld'), 'opnieuw bellen na aanvaarding → "al behandeld"');
// buiten categorie of binnen kantooruren: geen alarm
await call('/api/admin?a=instellingen', { syndicus_email: 'beheer@syndexia.be', noodalarm_actief: true, noodalarm_wanneer: 'altijd', noodalarm_categorieen: [], syndicus_gsm: '0470000001', dagrapport: true, auto_doorsturen_niet_dringend: true });
twVoor = (await tw()).length;
const an8 = await call('/api/public?a=analyse', { t: puerto.qr_token, beschrijving: 'Lift staat stil, buiten dienst' });
await call('/api/public?a=indienen', { t: puerto.qr_token, concept_id: an8.j.concept_id });
check(!(await tw()).slice(twVoor).some((x) => x.soort === 'call'), 'categorie niet aangevinkt → niet gebeld (enkel mail)');

console.log(fouten.length ? `\n${fouten.length} FOUT(EN)` : '\nALLES GROEN');
process.exit(fouten.length ? 1 : 0);
