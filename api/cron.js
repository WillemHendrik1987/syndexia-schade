// Automatische opvolging. Wordt elke 10 minuten aangeroepen door Supabase (pg_cron + pg_net)
// en als vangnet één keer per dag door Vercel Cron.
import { opvolging } from '../lib/flow.js';
import { ok, fout, siteUrl } from '../lib/http.js';

export default async function handler(req, res) {
  const geheim = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!geheim || (auth !== `Bearer ${geheim}` && req.query.key !== geheim)) return fout(res, 401, 'Geen toegang');
  try {
    const log = await opvolging(siteUrl(req));
    return ok(res, { ok: true, log });
  } catch (e) {
    console.error('cron', e);
    return fout(res, 500, e.message);
  }
}
