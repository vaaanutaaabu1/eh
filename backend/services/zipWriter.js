"use strict";
/* Minimal ZIP writer (no dependencies): createZip().add(name, buffer) ... .finish() -> Buffer. */
const zlib = require("zlib");
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };

function createZip() {
  const parts = [], cen = []; let off = 0, count = 0;
  return {
    add(name, data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const nm = Buffer.from(String(name).replace(/\\/g, "/").replace(/^\/+/, ""));
      const def = zlib.deflateRawSync(buf, { level: 6 }), useDef = def.length < buf.length, body = useDef ? def : buf, c = crc32(buf);
      const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDef ? 8 : 0, 8);
      lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(buf.length, 22); lh.writeUInt16LE(nm.length, 26);
      parts.push(lh, nm, body);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDef ? 8 : 0, 10);
      ch.writeUInt16LE(tm, 12); ch.writeUInt16LE(dt, 14); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(buf.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
      cen.push(ch, nm); off += 30 + nm.length + body.length; count++;
    },
    finish() {
      const cd = Buffer.concat(cen), e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(count, 8); e.writeUInt16LE(count, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
      return Buffer.concat([...parts, cd, e]);
    }
  };
}

/*
 * Same idea, but written straight to a file on disk, one entry at a time, so a backup with hundreds of megabytes of files
 * never sits in memory. Uses ZIP64 automatically (more than 65 535 entries, or a file that grows past 4 GB), so the result
 * opens with any normal unzip tool.
 *
 *   const z = await createZipFile("/tmp/x.zip");  await z.add("a/b.bin", buffer);  ...  const { size, count } = await z.finish();
 *   await z.abort()   closes and deletes the half-written file.
 * opts.level = default deflate level (6); add(name, data, { level: 1 }) overrides it per entry (1 is much faster for files that hardly compress). opts.forceZip64 is for tests.
 */
const fs = require("fs"), { promisify } = require("util");
const deflateRaw = promisify(zlib.deflateRaw);
const U32 = 0xFFFFFFFF, U16 = 0xFFFF;

async function createZipFile(filePath, opts = {}) {
  const fh = await fs.promises.open(filePath, "w");
  const level = opts.level == null ? 6 : opts.level, force64 = !!opts.forceZip64;
  const cen = []; let off = 0, count = 0, closed = false;
  async function put(buf) {
    let done = 0;
    while (done < buf.length) { const r = await fh.write(buf, done, buf.length - done, null); done += r.bytesWritten; }
    off += buf.length;
  }
  return {
    async add(name, data, o) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data)), lv = o && o.level != null ? o.level : level;
      if (buf.length >= U32) throw new Error("File too large for the zip writer: " + name);
      const nm = Buffer.from(String(name).replace(/\\/g, "/").replace(/^\/+/, ""));
      let body = buf, useDef = false;
      if (buf.length >= 64 && lv > 0) { const def = await deflateRaw(buf, { level: lv }); if (def.length < buf.length) { body = def; useDef = true; } }
      const c = crc32(buf), d = new Date();
      const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const big = force64 || off >= U32;                                        /* this entry starts beyond 4 GB: its offset needs the ZIP64 extra field */
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDef ? 8 : 0, 8);
      lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(buf.length, 22); lh.writeUInt16LE(nm.length, 26);
      const startOff = off;
      await put(lh); await put(nm); await put(body);
      const ex = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) { ex.writeUInt16LE(0x0001, 0); ex.writeUInt16LE(8, 2); ex.writeBigUInt64LE(BigInt(startOff), 4); }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(big ? 45 : 20, 4); ch.writeUInt16LE(big ? 45 : 20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDef ? 8 : 0, 10);
      ch.writeUInt16LE(tm, 12); ch.writeUInt16LE(dt, 14); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(buf.length, 24); ch.writeUInt16LE(nm.length, 28);
      ch.writeUInt16LE(ex.length, 30); ch.writeUInt32LE(big ? U32 : startOff, 42);
      cen.push(ch, nm, ex); count++;
    },
    async finish() {
      const cd = Buffer.concat(cen), cdOff = off;
      const need64 = force64 || count > U16 - 1 || cdOff >= U32 || cd.length >= U32;
      await put(cd);
      if (need64) {
        const z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
        z.writeBigUInt64LE(BigInt(count), 24); z.writeBigUInt64LE(BigInt(count), 32); z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(cdOff), 48);
        const loc = Buffer.alloc(20), z64Off = off;
        loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(z64Off), 8); loc.writeUInt32LE(1, 16);
        await put(z); await put(loc);
      }
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0);
      e.writeUInt16LE(need64 ? U16 : count, 8); e.writeUInt16LE(need64 ? U16 : count, 10);
      e.writeUInt32LE(need64 ? U32 : cd.length, 12); e.writeUInt32LE(need64 ? U32 : cdOff, 16);
      await put(e);
      await fh.sync(); await fh.close(); closed = true;
      return { size: off, count };
    },
    async abort() { try { if (!closed) await fh.close(); } catch { /* ignore */ } closed = true; try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
  };
}

module.exports = { createZip, createZipFile };
