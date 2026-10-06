// Vaste lijsten die zowel de AI, de routering als de schermen gebruiken.

export const CATEGORIEEN = {
  lift:            { label: 'Lift',                         icoon: '⇅' },
  sanitair:        { label: 'Water, lekkage & afvoer',      icoon: '💧' },
  dak_gevel:       { label: 'Dak, gevel & vochtinfiltratie', icoon: '⌂' },
  elektriciteit:   { label: 'Elektriciteit & verlichting',  icoon: '⚡' },
  verwarming:      { label: 'Verwarming & warm water',      icoon: '♨' },
  deuren_toegang:  { label: 'Deuren, poort, parlofoon & sloten', icoon: '⚿' },
  brandveiligheid: { label: 'Brandveiligheid',              icoon: '🔥' },
  glas_ramen:      { label: 'Glas & ramen',                 icoon: '▦' },
  schoonmaak:      { label: 'Schoonmaak & afval',           icoon: '✧' },
  groen_buiten:    { label: 'Tuin, groen & buitenaanleg',   icoon: '❀' },
  andere:          { label: 'Andere / algemeen',            icoon: '•' },
};
export const CATEGORIE_KEYS = Object.keys(CATEGORIEEN);

export const STATUS = {
  nieuw:             { label: 'Nieuw – geen aannemer',  kleur: 'grijs' },
  wacht_goedkeuring: { label: 'Wacht op goedkeuring',   kleur: 'oranje' },
  wacht_aanvaarding: { label: 'Wacht op aanvaarding',   kleur: 'oranje' },
  aanvaard:          { label: 'Aanvaard',               kleur: 'blauw' },
  ingepland:         { label: 'Ingepland',              kleur: 'blauw' },
  uitgevoerd:        { label: 'Uitgevoerd',             kleur: 'groen' },
  afgesloten:        { label: 'Afgesloten',             kleur: 'groen' },
  geannuleerd:       { label: 'Geannuleerd',            kleur: 'grijs' },
};
export const OPEN_STATUSSEN = ['nieuw', 'wacht_goedkeuring', 'wacht_aanvaarding', 'aanvaard', 'ingepland'];

export const BRAND = {
  naam: 'Syndexia',
  bordeaux: '#892546',
  roos: '#A44967',
  blush: '#D2ABB8',
  logo: 'https://static.wixstatic.com/media/8148b3_ffdefa6217404d49afb9b27cab313b78~mv2.png/v1/fill/w_420,h_240,al_c,q_90/syndexia-logo.png',
  adres: 'Gulden-Vlieslaan 59, 8000 Brugge',
  tel: '+32 473 73 72 31',
};
