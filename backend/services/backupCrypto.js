"use strict";
/*
 * Backup encryption (AES-256-GCM, key from BACKUP_PASSPHRASE via scrypt). No other dependencies, so backend/scripts/backup-tools.js can use it on its own.
 * File layout: "AHBK1" + salt(16) + iv(12) + auth tag(16) + encrypted data.
 *   encrypt / decrypt           whole buffer in memory (small backups)
 *   encryptFile / decryptFile   streamed from file to file, any size
 */
const fs = require("fs"), crypto = require("crypto");
function encrypt(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv), body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from("AHBK1"), salt, iv, c.getAuthTag(), body]);
}
function decrypt(buf, pass) {
  if (buf.subarray(0, 5).toString() !== "AHBK1") throw new Error("Not an encrypted backup file.");
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), key = crypto.scryptSync(pass, salt, 32);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(49)), d.final()]);
}

/* Same format as encrypt()/decrypt() above, but streamed so a big file is never in memory: header = "AHBK1" + salt + iv + auth tag, then the data. The tag is only known at the end, so it is written last into its slot. */
async function encryptFile(src, dst, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const out = await fs.promises.open(dst, "w");
  try {
    await out.write(Buffer.concat([Buffer.from("AHBK1"), salt, iv, Buffer.alloc(16)]));
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 1 << 20 })) { const e = c.update(chunk); if (e.length) await out.write(e); }
    const f = c.final(); if (f.length) await out.write(f);
    await out.write(c.getAuthTag(), 0, 16, 33);
  } finally { await out.close(); }
}
async function decryptFile(src, dst, pass) {
  const fd = await fs.promises.open(src, "r");
  try {
    const head = Buffer.alloc(49); const { bytesRead } = await fd.read(head, 0, 49, 0);
    if (bytesRead < 49 || head.subarray(0, 5).toString() !== "AHBK1") throw new Error("Not an encrypted backup file.");
    const salt = head.subarray(5, 21), iv = head.subarray(21, 33), tag = head.subarray(33, 49), d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag);
    const out = await fs.promises.open(dst, "w");
    try {
      for await (const chunk of fs.createReadStream(src, { start: 49, highWaterMark: 1 << 20 })) { const x = d.update(chunk); if (x.length) await out.write(x); }
      const f = d.final(); if (f.length) await out.write(f);        /* throws here if the passphrase is wrong or the file is damaged */
    } catch (e) { await out.close().catch(() => {}); try { fs.unlinkSync(dst); } catch { /* ignore */ } throw e; }
    await out.close();
  } finally { await fd.close(); }
}

module.exports = { encrypt, decrypt, encryptFile, decryptFile };
