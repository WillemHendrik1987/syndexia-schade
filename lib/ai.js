// AI-analyse van een schademelding met Claude (tekst + foto's).
//
// Waarom "structured outputs"? Via output_config.format geven we Claude een vast JSON-schema mee.
// Het model kan dan letterlijk niets anders teruggeven dan JSON die aan dat schema voldoet,
// zodat we altijd geldige, voorspelbare velden krijgen (categorie, urgentie, ...).
// (Het vroegere trucje "tool forceren" met tool_choice wordt door de nieuwste modellen geweigerd.)

import { CATEGORIEEN, CATEGORIE_KEYS } from './constants.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

// Het JSON-schema dat Claude MOET volgen (structured outputs via output_config.format).
// Beperkingen van de API: geen min/max/maxItems, geen ["string","null"], en elk object
// heeft additionalProperties: false. Daarom zijn alle velden verplicht en gebruiken we
// een lege string i.p.v. null.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titel: { type: 'string', description: 'Korte, feitelijke titel (max 60 tekens), bv. "Lift blijft steken tussen 2e en 3e verdieping".' },
    samenvatting: { type: 'string', description: '2 tot 4 zinnen, neutraal en concreet, voor syndicus en aannemer: wat, waar, sinds wanneer, wat is zichtbaar op de foto’s.' },
    categorie: { type: 'string', enum: CATEGORIE_KEYS },
    urgentie: { type: 'string', enum: ['dringend', 'niet_dringend'] },
    urgentie_reden: { type: 'string', description: 'Eén zin waarom deze urgentie.' },
    noodgeval: { type: 'boolean', description: 'True bij acuut gevaar voor personen: gasgeur, brand/rook, persoon opgesloten in lift, elektrocutiegevaar, instortingsgevaar.' },
    veiligheidsadvies: { type: 'string', description: 'Concreet advies aan de bewoner voor NU (bv. "Bel 112"). Lege string als niet nodig.' },
    vervolgvragen: {
      type: 'array',
      description: 'Maximaal 2 vragen, enkel als cruciale info ontbreekt om urgentie of categorie te bepalen. Anders een lege lijst.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vraag: { type: 'string' },
          opties: { type: 'array', items: { type: 'string' }, description: '0 tot 4 korte antwoordopties' },
        },
        required: ['vraag', 'opties'],
      },
    },
    duplicaat_van: { type: 'string', description: 'ID van een openstaande melding die over HETZELFDE probleem gaat, anders een lege string.' },
    privatief_vermoeden: { type: 'boolean', description: 'True als het probleem waarschijnlijk een privatief deel betreft (binnen een appartement, eigen installatie) en niet de gemeenschappelijke delen.' },
    privatief_uitleg: { type: 'string', description: 'Korte uitleg voor de bewoner indien privatief_vermoeden true is, anders lege string.' },
    advies_aannemer: { type: 'string', description: 'Praktische tip voor de aannemer (wat meenemen/controleren). Lege string als niets zinvols.' },
    bericht_bewoner: { type: 'string', description: 'Eén vriendelijke zin aan de bewoner (u-vorm) die bevestigt wat er gebeurt.' },
    vertrouwen: { type: 'number', description: 'Zekerheid van de analyse tussen 0 en 1.' },
  },
  required: ['titel', 'samenvatting', 'categorie', 'urgentie', 'urgentie_reden', 'noodgeval', 'veiligheidsadvies', 'vervolgvragen',
    'duplicaat_van', 'privatief_vermoeden', 'privatief_uitleg', 'advies_aannemer', 'bericht_bewoner', 'vertrouwen'],
};

const SYSTEEM = `Je bent de schademelding-assistent van Syndexia, een syndicuskantoor in Brugge (België).
Bewoners van appartementsgebouwen (VME's) melden schade of defecten aan de GEMEENSCHAPPELIJKE delen via een QR-code.
Jij analyseert de beschrijving en foto's en geeft je analyse terug als JSON volgens het opgegeven schema. Schrijf in Belgisch-Nederlands.

Categorieën: ${CATEGORIE_KEYS.map((k) => `${k} (${CATEGORIEEN[k].label})`).join(', ')}.

URGENTIE — "dringend" als minstens één van deze geldt:
- gevaar voor personen of veiligheid (gasgeur, rook/brand, loszittende gevelstenen, elektrische vonken/blootliggende draden, gladheid door lekkage op trap)
- actieve waterlekkage, overstroming, rioolverstopping met terugloop, geen water in het gebouw
- lift volledig buiten dienst of persoon opgesloten; lift stopt niet op niveau (struikelgevaar)
- inkomdeur, garagepoort of slot dat niet meer sluit (inbraakrisico) of dat bewoners buitensluit
- uitval verwarming/warm water voor meerdere appartementen, stroomuitval gemeenschappelijke delen (trapverlichting volledig uit)
- defect brandalarm, branddeur blokkeert, noodverlichting volledig uit
- stormschade aan dak of gevel met risico op verdere schade
Anders "niet_dringend" (één lampje stuk, cosmetische schade, schoonmaak, kleine scheur, traag sluitende deur, ...).

NOODGEVAL (noodgeval=true + veiligheidsadvies): gasgeur → "Verlaat het gebouw, gebruik geen schakelaars en bel 112."; brand/rook → "Bel 112."; persoon opgesloten in lift → "Druk op de alarmknop in de lift en bel 112 bij nood."; elektrocutiegevaar → "Blijf weg en bel 112."

PRIVATIEF: lekkende kraan of toilet in een appartement, eigen ketel, eigen ramen of deur van een appartement, eigen parlofoontoestel binnen → meestal privatief. Meld het vriendelijk, maar laat de melding toe (de syndicus beslist).

DUPLICATEN: je krijgt de openstaande meldingen van dit gebouw. Gaat de nieuwe melding over hetzelfde probleem, vul duplicaat_van in met dat id.

VERVOLGVRAGEN: stel er maximaal 2, alleen als de urgentie of de categorie anders echt niet te bepalen is (bv. "Staat er nog iemand in de lift?", "Loopt het water nog?"). Geef bij voorkeur 2–4 korte antwoordopties. Als je het antwoord al uit de tekst of foto kan afleiden: niet vragen.

Wees feitelijk; verzin geen details die niet in de tekst of op de foto staan. Vermeld wat je op de foto's ziet.`;

export async function analyseer({ gebouw, beschrijving, locatie, fotos = [], openMeldingen = [], vorige = null, antwoorden = null, laatsteRonde = false }) {
  if (!process.env.ANTHROPIC_API_KEY) return reserveAnalyse({ beschrijving, locatie });

  const inhoud = [];
  for (const f of fotos.slice(0, 4)) {
    inhoud.push({ type: 'image', source: { type: 'base64', media_type: f.media_type || 'image/jpeg', data: f.data } });
  }
  let tekst = `Gebouw: ${gebouw.naam}${gebouw.adres ? ` (${gebouw.adres})` : ''}
Plaats in het gebouw: ${locatie || 'niet opgegeven'}
Beschrijving van de bewoner: """${(beschrijving || '').slice(0, 2000)}"""
Aantal foto's: ${fotos.length}

Openstaande meldingen in dit gebouw:
${openMeldingen.length ? openMeldingen.map((m) => `- id=${m.id} | ${m.categorie} | ${m.titel} | ${m.locatie || ''}`).join('\n') : '(geen)'}`;

  if (vorige && antwoorden) {
    tekst += `\n\nJe eerdere analyse: ${JSON.stringify({ titel: vorige.titel, samenvatting: vorige.samenvatting, categorie: vorige.categorie, urgentie: vorige.urgentie })}
De bewoner beantwoordde je vervolgvragen:
${antwoorden.map((a) => `- ${a.vraag} → ${a.antwoord || '(geen antwoord)'}`).join('\n')}`;
  }
  if (laatsteRonde) tekst += `\n\nDit is de definitieve analyse: stel GEEN vervolgvragen meer (vervolgvragen = []).`;
  inhoud.push({ type: 'text', text: tekst });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: inhoud }],
    }),
  });
  if (!res.ok) {
    console.error('Claude-fout', res.status, (await res.text()).slice(0, 400));
    return reserveAnalyse({ beschrijving, locatie });
  }
  const data = await res.json();
  const tekstBlok = data.content?.find((c) => c.type === 'text');
  let resultaat = null;
  try { resultaat = JSON.parse(tekstBlok?.text || ''); } catch { /* onvolledig antwoord */ }
  if (!resultaat || data.stop_reason === 'refusal') {
    console.error('Claude gaf geen bruikbare JSON', data.stop_reason);
    return reserveAnalyse({ beschrijving, locatie });
  }
  return normaliseer(resultaat, openMeldingen, laatsteRonde);
}

// Zorgt dat we nooit onverwachte waarden opslaan, wat Claude ook teruggeeft.
function normaliseer(a, openMeldingen, laatsteRonde) {
  const out = { ...a };
  if (!CATEGORIE_KEYS.includes(out.categorie)) out.categorie = 'andere';
  out.urgentie = String(out.urgentie || '').toLowerCase(); // enums: hoofdletters niet gegarandeerd
  if (!['dringend', 'niet_dringend'].includes(out.urgentie)) out.urgentie = 'niet_dringend';
  if (out.noodgeval) out.urgentie = 'dringend';
  out.titel = String(out.titel || 'Schademelding').slice(0, 80);
  out.vervolgvragen = laatsteRonde ? [] : (Array.isArray(out.vervolgvragen) ? out.vervolgvragen.slice(0, 2) : []);
  if (!out.duplicaat_van || !openMeldingen.some((m) => m.id === out.duplicaat_van)) out.duplicaat_van = null;
  out.vertrouwen = Math.min(1, Math.max(0, Number(out.vertrouwen) || 0));
  out.bron = 'claude';
  return out;
}

// Eenvoudige terugval op trefwoorden — enkel gebruikt als de AI niet bereikbaar is,
// zodat een melding nooit verloren gaat.
function reserveAnalyse({ beschrijving = '', locatie = '' }) {
  const t = `${beschrijving} ${locatie}`.toLowerCase();
  const regels = [
    ['sanitair', /lek|water|riool|afvoer|wc|toilet|overstroom|vocht|plas/], ['lift', /lift|ascenseur/],
    ['elektriciteit', /licht|lamp|stroom|elektr|stopcontact|zekering/], ['verwarming', /verwarm|ketel|warm water|radiator/],
    ['deuren_toegang', /deur|poort|slot|sleutel|parlofoon|bel|badge/], ['brandveiligheid', /brand|rook|blusapparaat|alarm|nooduitgang/],
    ['glas_ramen', /glas|raam|ruit/], ['dak_gevel', /dak|gevel|goot|dakgoot|steen|barst|scheur/],
    ['schoonmaak', /vuil|afval|container|schoonmaak|graffiti/], ['groen_buiten', /tuin|gras|boom|haag|oprit|parking/],
  ];
  const categorie = regels.find(([, re]) => re.test(t))?.[0] || 'andere';
  const dringend = /gas|brand|rook|opgesloten|lek|overstroom|stroomuitval|sluit niet|kapot slot|slot kapot|vonk|gevaar|geen water|geen verwarming/.test(t)
    || (categorie === 'lift' && /stuk|vast|buiten dienst|werkt niet|defect|blokkeert/.test(t));
  return {
    titel: (beschrijving.split(/[.!?\n]/)[0] || 'Schademelding').slice(0, 60),
    samenvatting: beschrijving.slice(0, 500),
    categorie, urgentie: dringend ? 'dringend' : 'niet_dringend',
    urgentie_reden: 'Automatisch ingeschat op basis van trefwoorden (AI tijdelijk niet beschikbaar).',
    noodgeval: /gas|brand|rook|opgesloten/.test(t),
    veiligheidsadvies: /gas/.test(t) ? 'Verlaat het gebouw, gebruik geen schakelaars en bel 112.' : /brand|rook/.test(t) ? 'Bel 112.' : '',
    vervolgvragen: [], duplicaat_van: null, privatief_vermoeden: false, privatief_uitleg: '',
    advies_aannemer: '', bericht_bewoner: 'Bedankt, uw melding wordt meteen doorgegeven.', vertrouwen: 0.3, bron: 'reserve',
  };
}
