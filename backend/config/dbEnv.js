"use strict";
/*
 * Neon connection strings.
 *   DATABASE_URL1 ... DATABASE_URL20   one per Neon database ("shard"), in this order.
 *   DATABASE_URL                       optional; if empty it is set to DATABASE_URL1.
 * DATABASE_URL1 is the MAIN database (users, orders, document list, text, settings ...).
 * Uploaded files are spread over ALL numbered databases (see shards.js).
 */
function clean(v) {
  let s = String(v == null ? "" : v).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).trim();
  return s;
}
const urls = [];
for (let i = 1; i <= 20; i++) { const u = clean(process.env["DATABASE_URL" + i]); if (u) urls.push({ n: i, url: u }); }
const single = clean(process.env.DATABASE_URL);
if (!single && urls.length) process.env.DATABASE_URL = urls[0].url;
if (single) process.env.DATABASE_URL = single;
if (!urls.length && single) urls.push({ n: 1, url: single });

/* The main database must be shard 1: if DATABASE_URL differs from DATABASE_URL1 the file shards still start at DATABASE_URL1,
   but the main data stays where DATABASE_URL points. */
module.exports = { urls, mainUrl: clean(process.env.DATABASE_URL) };
