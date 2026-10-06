# Syndexia Schademelding

Schademeldingsplatform voor Syndexia: bewoners melden schade via een QR-code in hun gebouw, Claude analyseert foto + beschrijving, en de melding gaat automatisch naar de juiste aannemer. Die aanvaardt met één klik. Opvolging en escalatie lopen automatisch.

## Hoe het werkt (de keten)

1. **QR-code per gebouw** (`/m/<qr_token>`): de bewoner maakt een foto, beschrijft het probleem en kiest waar in het gebouw.
2. **AI-analyse** (`lib/ai.js`): Claude bepaalt titel, samenvatting, categorie, urgentie, noodgeval, mogelijk privatief deel en mogelijke dubbele melding. Via *tool use* geeft Claude altijd geldige JSON terug. Zonder API-sleutel valt het terug op een eenvoudige inschatting op trefwoorden, zodat er nooit een melding verloren gaat.
3. **Concept → melding**: het AI-resultaat wordt op de server bewaard (`sm_concepten`). Bij het indienen gebruikt de server zijn eigen opgeslagen analyse, dus een bewoner kan de urgentie niet via de browser vervalsen.
4. **Routering** (`lib/flow.js → zoekAannemer`): vaste aannemer voor die categorie in dat gebouw → reserve → algemene aannemer ("andere"). Weigeraars worden overgeslagen.
5. **Aannemer** (`/a/<token>`): aanvaarden, weigeren (gaat dan automatisch naar de reserve), inplannen en als uitgevoerd melden, met foto's na de herstelling.
6. **Bewoner** (`/t/<token>`): volgt de status live en bevestigt na de herstelling of het opgelost is. "Nee" heropent de opdracht.
7. **Opvolging** (`/api/cron`, elke 10 min via Supabase pg_cron): herinneringen, escalatie naar de reserve, vragen naar planning en status, automatisch afsluiten, dagrapport om 7u en het opruimen van verlaten concepten.

## Mappen

| Pad | Inhoud |
|---|---|
| `api/public.js` | bewoners: gebouw, analyse, indienen, "ik merk dit ook", volgen, feedback |
| `api/aannemer.js` | opdrachtpagina en acties van de aannemer |
| `api/admin.js` | dashboard (wachtwoord + ondertekend sessiecookie) |
| `api/cron.js` | automatische opvolging (beveiligd met `CRON_SECRET`) |
| `lib/` | database, AI, mail, routering en opvolging |
| `public/` | schermen: `index.html` + `dashboard.js` (syndicus), `melden.html`, `volg.html`, `opdracht.html` |
| `db/` | SQL-migraties (Supabase-project "Attestenbeheer VME", tabellen met prefix `sm_`) |
| `dev/` | lokale testserver met nagebootste Supabase + end-to-end test (`node dev/server.js`, dan `node dev/test-flow.mjs`) |

## Omgevingsvariabelen (Vercel)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`, `SITE_URL`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `MAIL_FROM`. Optioneel: `ANTHROPIC_MODEL`, of `RESEND_API_KEY` in plaats van Gmail.

## Beveiliging

- Alle tabellen hebben RLS aan zonder policies: enkel de server (service-sleutel) kan erbij.
- Foto's staan in een private bucket en zijn enkel zichtbaar via tijdelijke, ondertekende links.
- Elke opdrachtlink en volglink is een lange, willekeurige token. Bij toewijzing aan een andere aannemer vervalt de oude link.
- Misbruikrem: max. 12 analyses en 6 meldingen per uur per toestel (gehashte IP).
- Contactgegevens van de bewoner gaan enkel naar de aannemer als de bewoner dat aanvinkt.
