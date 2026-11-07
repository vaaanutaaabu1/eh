"use strict";
/*
 * The pointer that stands in for a file stored on another Neon database.
 * Pure helpers (no database, no environment) so scripts can read pointers from a backup folder too.
 *
 *   "\0SHRD1:<database number>:<blob id>"   kept in the same BYTEA column that used to hold the file itself
 */
const MAGIC = Buffer.from("\0SHRD1:");
const isPtr = (v) => Buffer.isBuffer(v) && v.length > MAGIC.length && v.length < 64 && v.subarray(0, MAGIC.length).equals(MAGIC);
const mkPtr = (shard, id) => Buffer.concat([MAGIC, Buffer.from(shard + ":" + id)]);
/* shard = 1-based database number (the N of DATABASE_URL<N>) */
const parsePtr = (v) => { const m = /^(\d+):(\d+)$/.exec(v.subarray(MAGIC.length).toString()); return m ? { shard: Number(m[1]), id: Number(m[2]) } : null; };

module.exports = { MAGIC, isPtr, mkPtr, parsePtr };
