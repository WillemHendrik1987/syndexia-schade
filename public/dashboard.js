// Syndexia Schademelding — dashboard voor de syndicus.
// Gewone JavaScript zonder framework: elke "view" is een functie die HTML tekent in #hoofd.
'use strict';

const LOGO = 'https://static.wixstatic.com/media/8148b3_ffdefa6217404d49afb9b27cab313b78~mv2.png/v1/fill/w_420,h_240,al_c,q_90/syndexia-logo.png';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = $('#root');
const S = { data: null, filter: 'actie', zoek: '', gebouw: '', gebouwen: null };

const STAP = { nieuw: 1, wacht_goedkeuring: 1, wacht_aanvaarding: 2, aanvaard: 3, ingepland: 4, uitgevoerd: 5, afgesloten: 5, geannuleerd: 0 };
const ACTOR = { bewoner: 'Bewoner', ai: 'Assistent', systeem: 'Systeem', aannemer: 'Aannemer', syndicus: 'Syndicus' };

async function api(actie, data, methode) {
  const get = methode === 'GET' || (!data && methode !== 'POST');
  const url = `/api/admin?a=${actie}` + (get && data ? `&${new URLSearchParams(data)}` : '');
  const r = await fetch(url, get ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && actie !== 'login') { toonLogin(); throw new Error('Niet ingelogd'); }
  if (!r.ok) throw new Error(j.error || 'Er liep iets mis.');
  return j;
}
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 3200); }

function geleden(d) {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d)) / 60000);
  if (min < 1) return 'zonet';
  if (min < 60) return `${min} min`;
  const u = Math.round(min / 60);
  if (u < 24) return `${u} u`;
  const dg = Math.round(u / 24);
  return dg < 31 ? `${dg} d` : new Date(d).toLocaleDateString('nl-BE');
}
const fmt = (d) => d ? new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—';
const minNaarTekst = (m) => m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} u` : `${Math.round(m / 1440)} d`;

function statusTag(st) {
  const s = S.data?.statussen?.[st] || { label: st, kleur: 'grijs' };
  return `<span class="tag s-${s.kleur}">${esc(s.label)}</span>`;
}
function ladder(st) {
  const n = STAP[st] ?? 0;
  return `<span class="ladder" title="${esc(S.data?.statussen?.[st]?.label || '')}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i < n || (n === 5 && i === 5) ? 'aan' : i === n ? 'nu' : ''}"></i>`).join('')}</span>`;
}
const urgTag = (u) => u === 'dringend' ? '<span class="tag dringend">Dringend</span>' : '<span class="tag normaal">Niet dringend</span>';
const catLabel = (k) => S.data?.categorieen?.[k]?.label || k;
const gebouwNaam = (id) => S.data?.gebouwen.find((g) => g.id === id)?.naam || '—';
const aannemer = (id) => S.data?.aannemers.find((a) => a.id === id);
const qrUrl = (t) => `${location.origin}/m/${t}`;
// standaardvoorstel voor een datum: morgen 9u (lokale tijd), in het formaat van <input type="datetime-local">
function morgen9u() {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

// ---------- login ----------
function toonLogin(fout = '') {
  root.innerHTML = `<div class="login"><form id="lf">
    <div class="logo-vak"><img src="${LOGO}" alt="Syndexia"></div>
    <div><h1>Schademeldingen</h1><p class="muted klein" style="margin-top:4px">Dashboard voor de syndicus</p></div>
    ${fout ? `<div class="melding-fout">${esc(fout)}</div>` : ''}
    <div class="veld"><label for="pw">Wachtwoord</label><input type="password" id="pw" autocomplete="current-password" required autofocus></div>
    <button class="knop breed">Inloggen</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('login', { wachtwoord: $('#pw').value }, 'POST'); start(); } catch (err) { toonLogin(err.message); }
  };
}

// ---------- schil ----------
function schil() {
  root.innerHTML = `<div class="schil">
    <aside class="zij">
      <img src="${LOGO}" alt="Syndexia">
      <nav id="nav">
        <a href="#meldingen" data-v="meldingen">Meldingen <span class="badge verborgen" id="badge"></span></a>
        <a href="#gebouwen" data-v="gebouwen">Gebouwen &amp; QR</a>
        <a href="#aannemers" data-v="aannemers">Aannemers</a>
        <a href="#instellingen" data-v="instellingen">Instellingen</a>
      </nav>
      <div class="onder"><div class="systeem" id="systeem"></div><button id="uit">Uitloggen</button></div>
    </aside>
    <main class="hoofd" id="hoofd"></main></div>`;
  $('#uit').onclick = async () => { await api('logout', {}, 'POST'); toonLogin(); };
}

async function laadOverzicht() {
  S.data = await api('overzicht', null, 'GET');
  const b = $('#badge');
  if (b) { b.textContent = S.data.kpi.actie; b.classList.toggle('verborgen', !S.data.kpi.actie); }
  const sys = $('#systeem');
  if (sys) sys.innerHTML = `<span class="${S.data.ai === 'aan' ? '' : 'uit'}">AI-analyse ${S.data.ai === 'aan' ? 'actief' : 'niet ingesteld'}</span><span class="${S.data.mail === 'uit' ? 'uit' : ''}">E-mail ${S.data.mail === 'smtp' ? 'via beheer@syndexia.be' : S.data.mail === 'resend' ? 'via Resend' : 'niet ingesteld'}</span>`;
}

function route() {
  const h = location.hash.slice(1) || 'meldingen';
  const [view, id] = h.startsWith('m=') ? ['meldingen', h.slice(2)] : [h, null];
  $$('#nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.v === view ? 'page' : 'false'));
  ({ meldingen: viewMeldingen, gebouwen: viewGebouwen, aannemers: viewAannemers, instellingen: viewInstellingen }[view] || viewMeldingen)();
  if (id) openMelding(id);
}

// ================= MELDINGEN =================
function filterMeldingen() {
  const q = S.zoek.toLowerCase();
  const open = ['nieuw', 'wacht_goedkeuring', 'wacht_aanvaarding', 'aanvaard', 'ingepland'];
  return S.data.meldingen.filter((m) => {
    if (S.gebouw && m.gebouw_id !== S.gebouw) return false;
    if (S.filter === 'actie' && !(m.status === 'nieuw' || m.status === 'wacht_goedkeuring' || (m.escalatie && open.includes(m.status)) || m.status === 'uitgevoerd')) return false;
    if (S.filter === 'open' && !open.includes(m.status)) return false;
    if (S.filter === 'dringend' && !(m.urgentie === 'dringend' && open.includes(m.status))) return false;
    if (S.filter === 'afgerond' && !['uitgevoerd', 'afgesloten', 'geannuleerd'].includes(m.status)) return false;
    if (q && !`${m.nummer} ${m.titel} ${gebouwNaam(m.gebouw_id)} ${m.locatie || ''} ${aannemer(m.aannemer_id)?.firma || ''} ${m.melder_naam || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function viewMeldingen() {
  const d = S.data; const k = d.kpi;
  const telling = (f) => { const o = S.filter; S.filter = f; const n = filterMeldingen().length; S.filter = o; return n; };
  $('#hoofd').innerHTML = `
    <div class="kop"><div><h1>Meldingen</h1><p class="sub">${k.actie ? `${k.actie} ${k.actie === 1 ? 'melding vraagt' : 'meldingen vragen'} uw aandacht.` : 'Alles loopt automatisch. Niets vraagt nu uw aandacht.'}</p></div>
      <button class="knop licht klein" id="ververs">Vernieuwen</button></div>
    <div class="cijfers">
      <div class="${k.dringend ? 'let' : ''}"><b>${k.dringend}</b><span>dringend open</span></div>
      <div><b>${k.open}</b><span>open in totaal</span></div>
      <div><b>${k.wacht}</b><span>wachten op aanvaarding</span></div>
      <div><b>${minNaarTekst(k.reactie_min)}</b><span>gem. reactietijd aannemer</span></div>
    </div>
    <div class="balk">
      <div class="seg" id="seg">${[['actie', 'Vraagt actie'], ['open', 'Open'], ['dringend', 'Dringend'], ['afgerond', 'Afgerond'], ['alles', 'Alles']].map(([f, l]) => `<button data-f="${f}" aria-pressed="${S.filter === f}">${l}<span class="n">${telling(f)}</span></button>`).join('')}</div>
      <input type="search" id="zoek" placeholder="Zoek op titel, nummer, gebouw, aannemer…" value="${esc(S.zoek)}">
      <select id="gfilter"><option value="">Alle gebouwen</option>${d.gebouwen.map((g) => `<option value="${g.id}" ${S.gebouw === g.id ? 'selected' : ''}>${esc(g.naam)}</option>`).join('')}</select>
    </div>
    <div class="lijst" id="lijst"></div>`;
  tekenLijst();
  $('#seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.f; viewMeldingen(); };
  $('#zoek').oninput = (e) => { S.zoek = e.target.value; tekenLijst(); };
  $('#gfilter').onchange = (e) => { S.gebouw = e.target.value; viewMeldingen(); };
  $('#ververs').onclick = async () => { await laadOverzicht(); viewMeldingen(); toast('Bijgewerkt'); };
}

function tekenLijst() {
  const rijen = filterMeldingen();
  const lijst = $('#lijst');
  if (!rijen.length) {
    const leeg = {
      actie: ['Niets te doen', 'Nieuwe meldingen gaan automatisch naar de juiste aannemer. Wat uw beslissing vraagt, verschijnt hier.'],
      dringend: ['Geen dringende meldingen', 'Dringende meldingen worden meteen naar u en de aannemer gemaild.'],
    }[S.filter] || ['Geen meldingen', S.zoek ? 'Probeer een andere zoekterm.' : 'Hang een QR-affiche op in een gebouw om meldingen te ontvangen.'];
    lijst.innerHTML = `<div class="leeg-staat"><h3>${leeg[0]}</h3><p>${leeg[1]}</p>${!S.data.meldingen.length ? '<a class="knop klein" href="#gebouwen">QR-affiches maken</a>' : ''}</div>`;
    return;
  }
  lijst.innerHTML = rijen.map((m) => {
    const a = aannemer(m.aannemer_id);
    return `<div class="rij ${m.urgentie === 'dringend' ? 'dringend' : ''}" data-id="${m.id}" tabindex="0" role="button">
      <span class="streep"></span>
      <div class="titel"><b>${esc(m.titel)}</b><span>${esc(m.nummer)} — ${esc(gebouwNaam(m.gebouw_id))}${m.locatie ? `, ${esc(m.locatie)}` : ''}${m.bevestigingen ? ` — ${m.bevestigingen + 1} bewoners` : ''}</span></div>
      <div class="stat">${statusTag(m.status)}${ladder(m.status)}</div>
      <div class="wie ${a || m.manueel ? '' : 'leeg'}">${m.manueel ? `<span class="tag s-grijs">zelf</span> ${esc(m.manueel_uitvoerder || '')}` : a ? esc(a.firma) : m.status === 'wacht_goedkeuring' ? 'wacht op u' : 'geen aannemer'}${m.escalatie ? ' <span class="tag s-oranje">escalatie</span>' : ''}</div>
      <div class="tijd">${geleden(m.created_at)}</div></div>`;
  }).join('');
  $$('.rij', lijst).forEach((r) => {
    r.onclick = () => (location.hash = `m=${r.dataset.id}`);
    r.onkeydown = (e) => { if (e.key === 'Enter') r.click(); };
  });
}

// ---------- detail van één melding ----------
function lade(html) {
  sluitLade();
  const bg = document.createElement('div'); bg.className = 'lade-bg'; bg.id = 'ladeBg';
  const l = document.createElement('aside'); l.className = 'lade'; l.id = 'lade'; l.setAttribute('role', 'dialog'); l.setAttribute('aria-modal', 'true');
  l.innerHTML = html;
  document.body.append(bg, l);
  bg.onclick = sluitLade;
  $$('.sluit', l).forEach((b) => (b.onclick = sluitLade));
  document.addEventListener('keydown', escSluit);
  return l;
}
function escSluit(e) { if (e.key === 'Escape') sluitLade(); }
function sluitLade() {
  $('#lade')?.remove(); $('#ladeBg')?.remove();
  document.removeEventListener('keydown', escSluit);
  if (location.hash.startsWith('#m=')) history.replaceState(null, '', '#meldingen');
}

async function openMelding(id) {
  const l = lade('<div class="lade-in"><p class="muted">Laden…</p></div>');
  let r;
  try { r = await api('melding', { id }, 'GET'); } catch (e) { l.innerHTML = `<div class="lade-in"><div class="melding-fout">${esc(e.message)}</div></div>`; return; }
  const m = r.melding; const ai = m.ai || {};
  const actieveAannemers = S.data.aannemers.filter((a) => a.actief);
  const aOpties = (sel) => `<option value="">Kies een aannemer…</option>${actieveAannemers.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.firma)} (${esc(catLabel(a.vakgebied))})</option>`).join('')}`;

  // contextuele hoofdactie: wat moet er nu gebeuren?
  let hoofdActie = '';
  const zelfKnop = '<button class="knop licht" data-actie="zelf_open">Zelf afhandelen</button>';
  if (m.status === 'wacht_goedkeuring') hoofdActie = `<button class="knop" data-actie="goedkeuren">Goedkeuren en doorsturen</button>${zelfKnop}<button class="knop stil" data-actie="annuleren">Afwijzen</button>`;
  else if (m.status === 'nieuw') hoofdActie = `<select id="kiesA">${aOpties()}</select><button class="knop" data-actie="toewijzen">Toewijzen en versturen</button>${zelfKnop}`;
  else if (m.status === 'wacht_aanvaarding') hoofdActie = `<button class="knop licht" data-actie="opnieuw_versturen">Opdracht opnieuw sturen</button>${zelfKnop}`;
  else if (m.manueel && ['aanvaard', 'ingepland'].includes(m.status)) hoofdActie = `<button class="knop" data-actie="uitgevoerd">Markeer als uitgevoerd</button>`;
  else if (m.status === 'uitgevoerd') hoofdActie = `<button class="knop" data-actie="afsluiten">Afsluiten</button><button class="knop licht" data-actie="heropenen">Heropenen</button>`;
  else if (['afgesloten', 'geannuleerd'].includes(m.status)) hoofdActie = `<button class="knop licht" data-actie="heropenen">Heropenen</button>`;
  else if (['aanvaard', 'ingepland'].includes(m.status)) hoofdActie = `<button class="knop licht" data-actie="uitgevoerd">Markeer als uitgevoerd</button>${zelfKnop}`;

  // formulier "Zelf afhandelen" (verborgen tot de knop gebruikt wordt)
  const zelfForm = `<form class="blok verborgen" id="zelfForm">
      <div><h3>Zelf afhandelen</h3><p class="klein muted" style="margin-top:4px">U regelt deze herstelling zelf, buiten het aannemerscircuit. De bewoner krijgt gewoon zijn updates (toegewezen, ingepland, uitgevoerd) en de vraag of het opgelost is; naam en telefoon van de uitvoerder blijven intern.</p></div>
      ${m.aannemer && ['wacht_aanvaarding', 'aanvaard', 'ingepland'].includes(m.status) ? `<div class="melding-fout" style="background:var(--blush);color:var(--wijn)">De opdracht bij <b>${esc(m.aannemer.firma)}</b> wordt ingetrokken; die krijgt daarvan een mail en zijn link vervalt.</div>` : ''}
      <div class="form-grid">
        <div class="veld"><label for="zUit">Wie voert het uit?</label><input type="text" id="zUit" required placeholder="bv. Loodgieterij Peeters"></div>
        <div class="veld"><label for="zTel">Telefoon (optioneel)</label><input type="tel" id="zTel"></div>
        <div class="veld"><label for="zDatum">Datum interventie (optioneel)</label><input type="datetime-local" id="zDatum"><span class="hulp">Leeg laten als die nog niet vastligt.</span></div>
        <div class="veld"><label for="zNot">Interne notitie (optioneel)</label><input type="text" id="zNot" placeholder="bv. telefonisch besteld"></div>
      </div>
      <div class="acties"><button class="knop">Bevestigen</button><button type="button" class="knop stil" id="zAnnuleer">Annuleren</button></div>
    </form>`;

  // blok voor meldingen die al manueel lopen: plannen + uitvoerder opslaan als aannemer
  const manueelBlok = m.manueel && ['aanvaard', 'ingepland'].includes(m.status) ? `<section class="blok">
      <div><h3>Manuele opvolging</h3><p class="klein" style="margin-top:4px">Uitvoerder: <b>${esc(m.manueel_uitvoerder || '')}</b>${m.manueel_tel ? ` — <a href="tel:${esc(m.manueel_tel)}">${esc(m.manueel_tel)}</a>` : ''}${m.gepland_op ? `<br>Gepland: ${fmt(m.gepland_op)}` : ''}</p></div>
      <form class="acties" id="mPlan"><input type="datetime-local" id="mDatum" value="${morgen9u()}" style="width:auto"><button class="knop licht klein">${m.gepland_op ? 'Nieuwe datum bewaren' : 'Datum inplannen'}</button></form>
      <p class="klein muted">De bewoner krijgt een mail met de datum. Is de datum een dag voorbij zonder "uitgevoerd", dan vraagt het platform u of het klaar is.</p>
      <details class="meer"><summary>Deze vakman voortaan als aannemer gebruiken</summary>
        <form id="mAannemer" class="form-grid" style="margin-top:10px">
          <div class="veld"><label for="maFirma">Firma</label><input type="text" id="maFirma" value="${esc(m.manueel_uitvoerder || '')}"></div>
          <div class="veld"><label for="maMail">E-mail voor opdrachten</label><input type="email" id="maMail" required></div>
          <label class="schakel vol"><input type="checkbox" id="maKoppel" checked><span>Meteen koppelen aan ${esc(m.gebouw?.naam || 'dit gebouw')} voor ${esc(catLabel(m.categorie))}</span></label>
          <div class="vol"><button class="knop licht klein">Opslaan als aannemer</button></div>
        </form></details>
    </section>` : '';

  l.innerHTML = `
    <div class="lade-kop">
      <div class="r1"><div class="tags">${esc(m.nummer)} ${urgTag(m.urgentie)} ${statusTag(m.status)} ${ladder(m.status)}</div><button class="sluit" aria-label="Sluiten">×</button></div>
      <h2>${esc(m.titel)}</h2>
      ${hoofdActie ? `<div class="acties">${hoofdActie}</div>` : ''}
    </div>
    <div class="lade-in">
      ${zelfForm}${manueelBlok}
      ${m.escalatie ? '<div class="melding-fout">Deze opdracht werd geëscaleerd: de aannemer reageerde niet op tijd.</div>' : ''}
      ${ai.noodgeval ? `<div class="nood"><div><b>Noodsituatie gemeld</b>${esc(ai.veiligheidsadvies || '')}</div></div>` : ''}
      <section class="blok">
        <div class="ai-kader"><span class="wie">Samenvatting door de assistent</span><p>${esc(m.samenvatting)}</p>
          <p class="klein muted">${esc(ai.urgentie_reden || '')}${ai.vertrouwen != null ? ` Zekerheid: ${Math.round(ai.vertrouwen * 100)}%.` : ''}</p></div>
        ${m.privatief_vermoeden ? `<div class="info" style="background:var(--blush);border-radius:12px;padding:12px 14px"><b>Mogelijk privatief:</b> ${esc(ai.privatief_uitleg || '')}</div>` : ''}
        ${m.fotos_urls?.length ? `<div class="fotos">${m.fotos_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto van de melding"></a>`).join('')}</div>` : ''}
        <details class="meer"><summary>Originele beschrijving van de bewoner</summary><p style="margin-top:8px;white-space:pre-wrap">${esc(m.beschrijving || '—')}</p></details>
      </section>
      ${m.na_fotos?.length ? `<section class="blok"><h3>Foto's na de herstelling</h3><div class="fotos">${m.na_fotos.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto na herstelling"></a>`).join('')}</div></section>` : ''}
      <section class="blok"><h3>Gegevens</h3>
        <dl class="info">
          <dt>Gebouw</dt><dd>${esc(m.gebouw?.naam)}<br><span class="muted">${esc(m.gebouw?.adres || '')}</span></dd>
          <dt>Plaats</dt><dd>${esc(m.locatie || '—')}</dd>
          <dt>Categorie</dt><dd><select id="cat" style="width:auto;padding:7px 10px">${Object.entries(S.data.categorieen).map(([k2, c]) => `<option value="${k2}" ${k2 === m.categorie ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></dd>
          <dt>Urgentie</dt><dd><select id="urg" style="width:auto;padding:7px 10px"><option value="dringend" ${m.urgentie === 'dringend' ? 'selected' : ''}>Dringend</option><option value="niet_dringend" ${m.urgentie !== 'dringend' ? 'selected' : ''}>Niet dringend</option></select></dd>
          <dt>Melder</dt><dd>${[m.melder_naam, m.melder_appartement && `app. ${m.melder_appartement}`].filter(Boolean).map(esc).join(', ') || '<span class="muted">anoniem</span>'}
            ${m.melder_email ? `<br><a href="mailto:${esc(m.melder_email)}">${esc(m.melder_email)}</a>` : ''}${m.melder_tel ? `<br><a href="tel:${esc(m.melder_tel)}">${esc(m.melder_tel)}</a>` : ''}
            ${m.bevestigingen ? `<br><span class="muted">+ ${m.bevestigingen} andere bewoner(s) melden hetzelfde</span>` : ''}</dd>
          <dt>Aannemer</dt><dd>${m.manueel ? `<span class="tag s-grijs">zelf afgehandeld</span> ${esc(m.manueel_uitvoerder || '')}${m.manueel_tel ? `<br><a href="tel:${esc(m.manueel_tel)}">${esc(m.manueel_tel)}</a>` : ''}` : m.aannemer ? `${esc(m.aannemer.firma)}${m.aannemer.telefoon ? `<br><a href="tel:${esc(m.aannemer.telefoon)}">${esc(m.aannemer.telefoon)}</a>` : ''}<br><a href="mailto:${esc(m.aannemer.email)}">${esc(m.aannemer.email)}</a>` : '<span class="muted">nog niet toegewezen</span>'}
            <div class="acties" style="margin-top:8px"><select id="andereA">${aOpties(m.aannemer_id)}</select><button class="knop licht klein" data-actie="toewijzen2">${m.aannemer ? 'Andere aannemer' : 'Toewijzen'}</button></div></dd>
          <dt>Tijdstippen</dt><dd class="klein">Gemeld ${fmt(m.created_at)}${m.verstuurd_op ? `<br>Verstuurd ${fmt(m.verstuurd_op)}` : ''}${m.aanvaard_op ? `<br>Aanvaard ${fmt(m.aanvaard_op)}` : ''}${m.gepland_op ? `<br>Gepland ${fmt(m.gepland_op)}` : ''}${m.uitgevoerd_op ? `<br>Uitgevoerd ${fmt(m.uitgevoerd_op)}` : ''}</dd>
          <dt>Links</dt><dd class="klein">${m.opdracht_url ? `<a href="${esc(m.opdracht_url)}" target="_blank" rel="noopener">Opdrachtpagina aannemer</a> · ` : ''}<a href="${esc(m.volg_url)}" target="_blank" rel="noopener">Volgpagina bewoner</a></dd>
        </dl>
      </section>
      <section class="blok"><h3>Verloop</h3>
        <ol class="tijdlijn">${r.events.map((e) => `<li class="${e.actor}"><div><b class="klein">${ACTOR[e.actor] || e.actor}</b> — ${esc(e.tekst)}<div class="wanneer">${fmt(e.created_at)}</div></div></li>`).join('')}</ol>
        <form class="notitie" id="notitie"><input type="text" placeholder="Interne notitie toevoegen (bv. ‘bewoner gebeld’)"><button class="knop klein">Bewaar</button></form>
      </section>
      ${!['afgesloten', 'geannuleerd'].includes(m.status) ? '<div class="acties"><button class="knop gevaar klein" data-actie="annuleren">Melding annuleren</button></div>' : ''}
    </div>`;
  $$('.sluit', l).forEach((b) => (b.onclick = sluitLade));

  const doe = async (actie, extra = {}, knop) => {
    if (knop) knop.disabled = true;
    try {
      const res = await api('melding_actie', { id: m.id, actie, ...extra }, 'POST');
      toast(res.waarschuwing || 'Opgeslagen');
      await laadOverzicht();
      if ($('#lijst')) viewMeldingen();
      openMelding(m.id);
    } catch (e) { toast(e.message); if (knop) knop.disabled = false; }
  };
  $$('[data-actie]', l).forEach((b) => (b.onclick = () => {
    const a = b.dataset.actie;
    if (a === 'toewijzen') { const v = $('#kiesA', l).value; if (!v) return toast('Kies eerst een aannemer.'); return doe('toewijzen', { aannemer_id: v }, b); }
    if (a === 'toewijzen2') { const v = $('#andereA', l).value; if (!v) return toast('Kies eerst een aannemer.'); return doe('toewijzen', { aannemer_id: v }, b); }
    if (a === 'zelf_open') { const f = $('#zelfForm', l); f.classList.remove('verborgen'); f.scrollIntoView({ behavior: 'smooth' }); $('#zUit', l).focus(); return; }
    if (a === 'annuleren' && !confirm('Deze melding annuleren?')) return;
    doe(a, {}, b);
  }));
  $('#zelfForm', l).onsubmit = (e) => {
    e.preventDefault();
    const datum = $('#zDatum', l).value;
    doe('zelf_afhandelen', { uitvoerder: $('#zUit', l).value, tel: $('#zTel', l).value, datum: datum ? new Date(datum).toISOString() : null, notitie: $('#zNot', l).value }, e.submitter);
  };
  $('#zAnnuleer', l).onclick = () => $('#zelfForm', l).classList.add('verborgen');
  const mPlan = $('#mPlan', l);
  if (mPlan) mPlan.onsubmit = (e) => { e.preventDefault(); const v = $('#mDatum', l).value; if (!v) return toast('Kies een datum.'); doe('manueel_plannen', { datum: new Date(v).toISOString() }, e.submitter); };
  const mA = $('#mAannemer', l);
  if (mA) mA.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r2 = await api('melding_actie', { id: m.id, actie: 'opslaan_als_aannemer', firma: $('#maFirma', l).value, email: $('#maMail', l).value, tel: m.manueel_tel, koppelen: $('#maKoppel', l).checked }, 'POST');
      toast(r2.waarschuwing || `Opgeslagen als aannemer${r2.gekoppeld ? ` en gekoppeld als ${r2.gekoppeld}` : ''}`);
      await laadOverzicht(); openMelding(m.id);
    } catch (err) { toast(err.message); }
  };
  $('#cat', l).onchange = (e) => doe('categorie', { waarde: e.target.value });
  $('#urg', l).onchange = (e) => doe('urgentie', { waarde: e.target.value });
  $('#notitie', l).onsubmit = (e) => { e.preventDefault(); const t = e.target.querySelector('input').value.trim(); if (t) doe('notitie', { tekst: t }); };
}

// ================= GEBOUWEN =================
async function viewGebouwen() {
  $('#hoofd').innerHTML = `<div class="kop"><div><h1>Gebouwen &amp; QR-codes</h1><p class="sub">Per gebouw één QR-code voor de inkomhal, en per soort probleem de vaste en de reserve-aannemer.</p></div>
    <button class="knop" id="nieuwG">Gebouw toevoegen</button></div><div class="lijst" id="glijst"><div class="leeg-staat">Laden…</div></div>`;
  $('#nieuwG').onclick = () => gebouwLade(null);
  S.gebouwen = (await api('gebouwen', null, 'GET')).gebouwen;
  const cats = Object.keys(S.data.categorieen);
  $('#glijst').innerHTML = S.gebouwen.length ? S.gebouwen.map((g) => {
    const gedekt = new Set(g.toewijzingen.filter((t) => t.prioriteit === 1).map((t) => t.categorie));
    const algemeen = gedekt.has('andere');
    return `<div class="gebouw-rij" data-id="${g.id}" tabindex="0" role="button" ${g.actief ? '' : 'style="opacity:.55"'}>
      <div><b>${esc(g.naam)}</b>${g.actief ? '' : ' <span class="tag s-grijs">inactief</span>'}<div class="klein muted">${esc(g.adres || '')}</div></div>
      <div><div class="dekking" title="Gekleurd = aannemer gekoppeld">${cats.map((c) => `<i class="${gedekt.has(c) || algemeen ? 'ja' : ''}" title="${esc(catLabel(c))}"></i>`).join('')}</div>
        <div class="klein muted" style="margin-top:4px">${gedekt.size ? `${gedekt.size} van ${cats.length} soorten gekoppeld${algemeen ? ', met algemene aannemer' : ''}` : 'Nog geen aannemers gekoppeld'}</div></div>
      <div class="klein">${g.open ? `${g.open} open${g.dringend ? `, <b style="color:var(--bordeaux)">${g.dringend} dringend</b>` : ''}` : '<span class="muted">geen open meldingen</span>'}</div>
      <div style="text-align:right"><span class="knop licht klein">Openen</span></div></div>`;
  }).join('') : '<div class="leeg-staat"><h3>Nog geen gebouwen</h3><p>Voeg uw eerste gebouw toe om een QR-code te maken.</p></div>';
  $$('.gebouw-rij').forEach((r) => { r.onclick = () => gebouwLade(S.gebouwen.find((g) => g.id === r.dataset.id)); r.onkeydown = (e) => { if (e.key === 'Enter') r.click(); }; });
}

function qrSvg(tekst, kleur = '#24161C') {
  const qr = qrcode(0, 'M'); qr.addData(tekst); qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true }).replace(/fill="black"/g, `fill="${kleur}"`);
}

function gebouwLade(g) {
  const nieuw = !g;
  g = g || { naam: '', adres: '', toegang_info: '', actief: true, toewijzingen: [] };
  const cats = Object.entries(S.data.categorieen);
  const act = S.data.aannemers.filter((a) => a.actief);
  const huidig = (c, p) => g.toewijzingen.find((t) => t.categorie === c && t.prioriteit === p)?.aannemer_id || '';
  const sel = (c, p) => `<select data-c="${c}" data-p="${p}"><option value="">${p === 1 ? (c === 'andere' ? '— geen —' : 'Algemene aannemer') : '— geen —'}</option>${act.map((a) => `<option value="${a.id}" ${huidig(c, p) === a.id ? 'selected' : ''}>${esc(a.firma)}</option>`).join('')}</select>`;
  const l = lade(`
    <div class="lade-kop"><div class="r1"><h2>${nieuw ? 'Nieuw gebouw' : esc(g.naam)}</h2><button class="sluit" aria-label="Sluiten">×</button></div></div>
    <div class="lade-in">
      ${nieuw ? '' : `<section class="blok"><h3>QR-code voor de inkomhal</h3>
        <div class="qr-vak"><div class="qr">${qrSvg(qrUrl(g.qr_token))}</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <p class="klein">Bewoners scannen deze code en komen meteen op de meldpagina van <b>${esc(g.naam)}</b>.</p>
            <div class="link">${esc(qrUrl(g.qr_token))}</div>
            <div class="acties"><button class="knop klein" id="affiche">Affiche afdrukken (A4)</button><button class="knop licht klein" id="svg">QR downloaden</button>
              <a class="knop stil klein" href="${esc(qrUrl(g.qr_token))}" target="_blank" rel="noopener">Meldpagina testen</a></div>
            <button class="knop stil klein" id="vernieuw" style="align-self:flex-start">QR-code vervangen</button>
          </div></div></section>`}
      <section class="blok"><h3>Gegevens</h3>
        <form id="gform" class="form-grid">
          <div class="veld"><label>Naam</label><input type="text" name="naam" required value="${esc(g.naam)}" placeholder="bv. Residentie EOS"></div>
          <div class="veld"><label>Adres</label><input type="text" name="adres" value="${esc(g.adres || '')}" placeholder="Straat nr, postcode gemeente"></div>
          <div class="veld vol"><label>Toegang voor aannemers</label><textarea name="toegang_info" style="min-height:70px" placeholder="bv. sleutelkluis links van de inkom, code via syndicus. Enkel zichtbaar voor de aannemer.">${esc(g.toegang_info || '')}</textarea></div>
          <label class="schakel vol"><input type="checkbox" name="actief" ${g.actief ? 'checked' : ''}><span>Actief: de QR-code aanvaardt meldingen</span></label>
          <div class="vol"><button class="knop">${nieuw ? 'Gebouw aanmaken' : 'Wijzigingen bewaren'}</button></div>
        </form></section>
      ${nieuw ? '' : `<section class="blok"><h3>Aannemers per soort probleem</h3>
        <p class="klein muted">Elke melding gaat automatisch naar de vaste aannemer. Weigert die of reageert hij niet op tijd, dan gaat ze naar de reserve. Zonder vaste aannemer gebruiken we de algemene aannemer (laatste rij).</p>
        ${act.length ? `<div style="overflow-x:auto"><table class="matrix"><thead><tr><th>Soort</th><th>Vaste aannemer</th><th>Reserve</th></tr></thead><tbody>
          ${cats.map(([c, info]) => `<tr><td>${esc(info.label)}</td><td>${sel(c, 1)}</td><td>${sel(c, 2)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="info" style="background:var(--blush);border-radius:12px;padding:12px 14px">Voeg eerst aannemers toe bij <a href="#aannemers">Aannemers</a>.</div>'}
      </section>`}
    </div>`);
  $('#gform', l).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('gebouw_opslaan', { id: g.id, naam: f.get('naam'), adres: f.get('adres'), toegang_info: f.get('toegang_info'), actief: f.get('actief') === 'on' }, 'POST');
      toast('Gebouw bewaard'); await laadOverzicht(); await viewGebouwen();
      gebouwLade(S.gebouwen.find((x) => x.id === r.gebouw.id));
    } catch (err) { toast(err.message); }
  };
  if (nieuw) return;
  $$('.matrix select', l).forEach((s) => (s.onchange = async () => {
    try {
      await api('toewijzing', { gebouw_id: g.id, categorie: s.dataset.c, prioriteit: Number(s.dataset.p), aannemer_id: s.value || null }, 'POST');
      const t = g.toewijzingen.filter((x) => !(x.categorie === s.dataset.c && x.prioriteit === Number(s.dataset.p)));
      if (s.value) t.push({ categorie: s.dataset.c, prioriteit: Number(s.dataset.p), aannemer_id: s.value });
      g.toewijzingen = t; toast('Koppeling bewaard');
    } catch (err) { toast(err.message); }
  }));
  $('#affiche', l).onclick = () => affiche(g);
  $('#svg', l).onclick = () => {
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${qrSvg(qrUrl(g.qr_token))}`], { type: 'image/svg+xml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `QR-schademelding-${g.naam.replace(/[^\w-]+/g, '-')}.svg`; a.click();
  };
  $('#vernieuw', l).onclick = async () => {
    if (!confirm('Een nieuwe QR-code maken? De oude affiche werkt daarna niet meer en moet vervangen worden.')) return;
    const r = await api('gebouw_qr_vernieuwen', { id: g.id }, 'POST');
    toast('Nieuwe QR-code gemaakt'); await viewGebouwen(); gebouwLade({ ...g, ...r.gebouw });
  };
}

// A4-affiche voor in de inkomhal: opent een printklare pagina.
function affiche(g) {
  const w = window.open('', '_blank');
  const url = qrUrl(g.qr_token);
  w.document.write(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Affiche ${esc(g.naam)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,650&family=Instrument+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: 'Instrument Sans', Arial, sans-serif; color: #24161C; background: #eee; }
    .a4 { width: 210mm; height: 297mm; margin: 0 auto; background: #fff; display: flex; flex-direction: column; overflow: hidden; }
    .top { background: #892546; color: #fff; padding: 14mm 16mm 12mm; display: flex; justify-content: space-between; align-items: flex-start; }
    .top img { width: 52mm; }
    .pix { display: grid; grid-template-columns: repeat(3, 5mm); gap: 2mm; }
    .pix i { width: 5mm; height: 5mm; border-radius: 1mm; background: rgba(255,255,255,.18); }
    .pix i.a { background: #fff; } .pix i.b { background: #D2ABB8; }
    .kern { flex: 1; padding: 14mm 16mm 0; display: flex; flex-direction: column; }
    h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 650; font-size: 30pt; line-height: 1.05; margin: 0 0 4mm; letter-spacing: -.01em; }
    .lead { font-size: 15pt; color: #6B5560; margin: 0 0 10mm; max-width: 150mm; }
    .qrrij { display: flex; gap: 12mm; align-items: center; }
    .qr { width: 88mm; height: 88mm; padding: 5mm; border: 1.2mm solid #892546; border-radius: 6mm; flex: none; }
    .qr svg { width: 100%; height: 100%; display: block; }
    ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7mm; counter-reset: s; }
    ol li { display: grid; grid-template-columns: 10mm 1fr; gap: 4mm; font-size: 13pt; line-height: 1.3; counter-increment: s; }
    ol li::before { content: counter(s); width: 10mm; height: 10mm; border-radius: 2mm; background: #892546; color: #fff; display: grid; place-items: center; font-weight: 700; }
    ol li b { display: block; font-size: 14pt; }
    .gebouw { margin-top: 11mm; padding-top: 6mm; border-top: .4mm solid #E7DDE2; display: flex; justify-content: space-between; align-items: baseline; gap: 8mm; }
    .gebouw b { font-family: 'Fraunces', Georgia, serif; font-size: 18pt; font-weight: 500; }
    .gebouw span { font-size: 10pt; color: #6B5560; text-align: right; overflow-wrap: anywhere; }
    .nood { background: #F5B700; color: #241A00; padding: 7mm 16mm; font-size: 13pt; font-weight: 700; display: flex; justify-content: space-between; align-items: center; gap: 8mm; }
    .nood big { font-family: 'Fraunces', Georgia, serif; font-size: 26pt; }
    .voet { padding: 5mm 16mm 7mm; font-size: 9.5pt; color: #6B5560; display: flex; justify-content: space-between; }
    .printknop { position: fixed; top: 12px; right: 12px; padding: 12px 18px; background: #892546; color: #fff; border: 0; border-radius: 10px; font: 700 15px 'Instrument Sans', Arial; cursor: pointer; }
    @media print { body { background: #fff; } .printknop { display: none; } .a4 { margin: 0; } }
  </style></head><body>
  <button class="printknop" onclick="print()">Afdrukken</button>
  <div class="a4">
    <div class="top"><img src="${LOGO}" alt="Syndexia"><div class="pix"><i class="a"></i><i></i><i class="b"></i><i></i><i class="a"></i><i></i><i class="b"></i><i></i><i class="a"></i></div></div>
    <div class="kern">
      <h1>Schade of defect gezien?</h1>
      <p class="lead">Scan de code met uw gsm en meld het in één minuut. Met foto, zonder app.</p>
      <div class="qrrij">
        <div class="qr">${qrSvg(url)}</div>
        <ol>
          <li><span><b>Scan de code</b>met de camera van uw gsm</span></li>
          <li><span><b>Foto en korte uitleg</b>van wat er stuk is en waar</span></li>
          <li><span><b>Wij doen de rest</b>de juiste vakman wordt meteen verwittigd</span></li>
        </ol>
      </div>
      <div class="gebouw"><b>${esc(g.naam)}</b><span>${esc(url.replace(/^https?:\/\//, ''))}</span></div>
    </div>
    <div class="nood"><span>Brand, gasgeur of iemand opgesloten in de lift?<br>Bel eerst de hulpdiensten.</span><big>112</big></div>
    <div class="voet"><span>Syndexia, syndicus van dit gebouw</span><span>beheer@syndexia.be · +32 473 73 72 31</span></div>
  </div></body></html>`);
  w.document.close();
}

// ================= AANNEMERS =================
function viewAannemers() {
  const lijst = S.data.aannemers;
  $('#hoofd').innerHTML = `<div class="kop"><div><h1>Aannemers</h1><p class="sub">Vaklui en liftbedrijven die opdrachten kunnen krijgen. Koppel ze per gebouw bij Gebouwen.</p></div>
    <button class="knop" id="nieuwA">Aannemer toevoegen</button></div>
    <div class="lijst">${lijst.length ? lijst.map((a) => `<div class="aannemer-rij ${a.actief ? '' : 'inactief'}" data-id="${a.id}" tabindex="0" role="button">
      <div><b>${esc(a.firma)}</b><div class="klein muted">${esc(a.contactpersoon || '')}</div></div>
      <div class="klein">${esc(catLabel(a.vakgebied))}${a.lopend ? `<br><span class="muted">${a.lopend} lopend</span>` : ''}</div>
      <div class="klein">${esc(a.email)}${a.telefoon ? `<br>${esc(a.telefoon)}` : ''}</div>
      <div style="text-align:right">${a.actief ? '<span class="knop licht klein">Bewerken</span>' : '<span class="tag s-grijs">inactief</span>'}</div></div>`).join('')
      : '<div class="leeg-staat"><h3>Nog geen aannemers</h3><p>Voeg uw liftbedrijf, loodgieter, elektricien en een algemene klusjesdienst toe.</p></div>'}</div>`;
  $('#nieuwA').onclick = () => aannemerLade(null);
  $$('.aannemer-rij').forEach((r) => { r.onclick = () => aannemerLade(lijst.find((a) => a.id === r.dataset.id)); r.onkeydown = (e) => { if (e.key === 'Enter') r.click(); }; });
}

function aannemerLade(a) {
  const nieuw = !a;
  a = a || { firma: '', contactpersoon: '', email: '', telefoon: '', vakgebied: 'andere', actief: true };
  const l = lade(`<div class="lade-kop"><div class="r1"><h2>${nieuw ? 'Nieuwe aannemer' : esc(a.firma)}</h2><button class="sluit" aria-label="Sluiten">×</button></div></div>
    <div class="lade-in"><form id="aform" class="blok form-grid">
      <div class="veld vol"><label>Firma</label><input type="text" name="firma" required value="${esc(a.firma)}" placeholder="bv. Liftservice Brugge"></div>
      <div class="veld"><label>Contactpersoon</label><input type="text" name="contactpersoon" value="${esc(a.contactpersoon || '')}"></div>
      <div class="veld"><label>Vakgebied</label><select name="vakgebied">${Object.entries(S.data.categorieen).map(([k, c]) => `<option value="${k}" ${a.vakgebied === k ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
      <div class="veld"><label>E-mail voor opdrachten</label><input type="email" name="email" required value="${esc(a.email)}"></div>
      <div class="veld"><label>Telefoon</label><input type="tel" name="telefoon" value="${esc(a.telefoon || '')}" placeholder="Voor escalaties"></div>
      <label class="schakel vol"><input type="checkbox" name="actief" ${a.actief ? 'checked' : ''}><span>Actief: kan opdrachten ontvangen</span></label>
      <div class="vol"><button class="knop">${nieuw ? 'Aannemer toevoegen' : 'Wijzigingen bewaren'}</button></div>
    </form>
    <p class="klein muted">De aannemer heeft geen account nodig. Elke opdracht komt per mail met een persoonlijke link om te aanvaarden, in te plannen en af te melden.</p>
    ${nieuw ? '' : `<section class="blok"><h3>Aannemer verwijderen</h3>
      ${a.lopend
        ? `<p class="klein">Deze aannemer heeft nog <b>${a.lopend} lopende opdracht(en)</b>. Wijs die eerst aan iemand anders toe via Meldingen, daarna kan u hem verwijderen.</p>`
        : `<p class="klein muted">${a.koppelingen ? `De ${a.koppelingen} koppeling(en) aan gebouwen verdwijnen mee. ` : ''}Afgeronde meldingen blijven bewaard. Wilt u hem enkel tijdelijk niet gebruiken? Vink dan "Actief" uit.</p>
           <div><button type="button" class="knop gevaar" id="verwijderA">Aannemer verwijderen</button></div>`}
    </section>`}</div>`);
  const vk = $('#verwijderA', l);
  if (vk) vk.onclick = async () => {
    if (!confirm(`${a.firma} definitief verwijderen?`)) return;
    try {
      await api('aannemer_verwijderen', { id: a.id }, 'POST');
      toast('Aannemer verwijderd'); sluitLade(); await laadOverzicht(); viewAannemers();
    } catch (err) { toast(err.message); }
  };
  $('#aform', l).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('aannemer_opslaan', { id: a.id, firma: f.get('firma'), contactpersoon: f.get('contactpersoon'), vakgebied: f.get('vakgebied'), email: f.get('email'), telefoon: f.get('telefoon'), actief: f.get('actief') === 'on' }, 'POST');
      toast('Aannemer bewaard'); sluitLade(); await laadOverzicht(); viewAannemers();
    } catch (err) { toast(err.message); }
  };
}

// ================= INSTELLINGEN =================
function viewInstellingen() {
  const i = S.data.instellingen;
  $('#hoofd').innerHTML = `<div class="kop"><div><h1>Instellingen</h1><p class="sub">Hoe automatisch het platform werkt en wanneer het u verwittigt.</p></div></div>
    <form id="iform" class="blok" style="max-width:680px">
      <div class="form-grid">
        <div class="veld"><label>Naam syndicus</label><input type="text" name="syndicus_naam" value="${esc(i.syndicus_naam)}"></div>
        <div class="veld"><label>E-mail syndicus</label><input type="email" name="syndicus_email" value="${esc(i.syndicus_email)}"><span class="hulp">Hier komen dringende meldingen, escalaties en het dagrapport binnen.</span></div>
      </div>
      <label class="schakel"><input type="checkbox" name="auto" ${i.auto_doorsturen_niet_dringend ? 'checked' : ''}><span><b>Ook niet-dringende meldingen automatisch doorsturen</b><br><span class="klein muted">Uit: niet-dringende meldingen wachten op uw goedkeuring. Dringende gaan altijd meteen door. Vermoedelijk privatieve problemen wachten altijd op u.</span></span></label>
      <div class="form-grid">
        <div class="veld"><label>Dringend niet aanvaard na (minuten)</label><input type="number" name="esc" min="15" max="1440" value="${i.escalatie_dringend_min}"><span class="hulp">Dan volgt een herinnering aan de aannemer en een seintje aan u. Na het dubbele gaat de opdracht naar de reserve-aannemer.</span></div>
        <div class="veld"><label>Niet-dringend niet aanvaard na (uren)</label><input type="number" name="her" min="4" max="240" value="${i.herinnering_normaal_uren}"><span class="hulp">Zelfde werkwijze voor gewone meldingen.</span></div>
      </div>
      <label class="schakel"><input type="checkbox" name="dag" ${i.dagrapport ? 'checked' : ''}><span><b>Dagrapport om 7 uur</b><br><span class="klein muted">Eén mail met alles wat openstaat en wat uw actie vraagt.</span></span></label>
      <div class="acties"><button class="knop">Instellingen bewaren</button><button type="button" class="knop licht" id="testmail">Testmail sturen</button></div>
    </form>
    <form id="pwform" class="blok" style="max-width:680px;margin-top:16px">
      <div><h3>Wachtwoord wijzigen</h3><p class="klein muted" style="margin-top:4px">Na het wijzigen worden alle andere toestellen automatisch uitgelogd.</p></div>
      <div class="form-grid">
        <div class="veld vol"><label for="pwHuidig">Huidig wachtwoord</label><input type="password" id="pwHuidig" autocomplete="current-password" required></div>
        <div class="veld"><label for="pwNieuw">Nieuw wachtwoord</label><input type="password" id="pwNieuw" autocomplete="new-password" minlength="10" required><span class="hulp">Minstens 10 tekens. Een zin van enkele woorden is sterk en makkelijk te onthouden.</span></div>
        <div class="veld"><label for="pwHerhaal">Herhaal nieuw wachtwoord</label><input type="password" id="pwHerhaal" autocomplete="new-password" required></div>
      </div>
      <div><button class="knop">Wachtwoord wijzigen</button></div>
    </form>
    <section class="blok" style="max-width:680px;margin-top:16px"><h3>Hoe het platform zelf opvolgt</h3>
      <ol class="tijdlijn">
        <li><div>Bewoner scant de QR-code, neemt een foto en beschrijft het probleem. De assistent vat samen, kiest de soort en beslist of het dringend is.</div></li>
        <li><div>De opdracht gaat naar de vaste aannemer van dat gebouw voor die soort. Bij dringend krijgt u meteen een mail.</div></li>
        <li><div>Aanvaardt de aannemer niet op tijd, dan volgt een herinnering; daarna gaat de opdracht naar de reserve-aannemer.</div></li>
        <li><div>Aanvaard maar niet ingepland, of ingepland maar niet afgemeld? De aannemer krijgt automatisch een opvolgmail.</div></li>
        <li><div>Na "uitgevoerd" vraagt het platform de bewoner of het opgelost is. Zonder klacht sluit de melding na 5 dagen.</div></li>
      </ol></section>`;
  $('#iform').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      await api('instellingen', { syndicus_naam: f.get('syndicus_naam'), syndicus_email: f.get('syndicus_email'), auto_doorsturen_niet_dringend: f.get('auto') === 'on', escalatie_dringend_min: f.get('esc'), herinnering_normaal_uren: f.get('her'), dagrapport: f.get('dag') === 'on' }, 'POST');
      await laadOverzicht(); toast('Instellingen bewaard');
    } catch (err) { toast(err.message); }
  };
  $('#pwform').onsubmit = async (e) => {
    e.preventDefault();
    const nieuw = $('#pwNieuw').value;
    if (nieuw !== $('#pwHerhaal').value) return toast('De twee nieuwe wachtwoorden zijn niet gelijk.');
    try {
      await api('wachtwoord', { huidig: $('#pwHuidig').value, nieuw }, 'POST');
      e.target.reset(); toast('Wachtwoord gewijzigd');
    } catch (err) { toast(err.message); }
  };
  $('#testmail').onclick = async () => {
    try { const r = await api('test_mail', {}, 'POST'); toast(r.ok ? `Testmail verstuurd naar ${i.syndicus_email}` : r.fout ? `Mislukt: ${r.fout}` : 'Mail staat nog niet ingesteld'); } catch (err) { toast(err.message); }
  };
}

// ---------- opstart ----------
async function start() {
  try { await api('me', null, 'GET'); } catch { return; }
  schil();
  await laadOverzicht();
  route();
  window.onhashchange = route;
  setInterval(async () => { if (!$('#lade') && location.hash.replace('#', '') in { '': 1, meldingen: 1 }) { await laadOverzicht(); viewMeldingen(); } }, 60000);
}
start();
