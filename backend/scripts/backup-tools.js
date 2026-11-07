#!/usr/bin/env node
"use strict";
/* node backend/scripts/backup-tools.js decrypt backup-2026-10-20T09-00-00.zip.enc [passphrase]  ->  backup-....zip
   Works on files of any size (read and written in pieces). */
const fs = require("fs");
const [, , cmd, file, pass] = process.argv;
if (cmd !== "decrypt" || !file) { console.log("Usage: node backend/scripts/backup-tools.js decrypt <file.zip.enc> [passphrase]  (or set BACKUP_PASSPHRASE)"); process.exit(1); }
const p = pass || process.env.BACKUP_PASSPHRASE;
if (!p) { console.error("Give the passphrase as the last argument or in BACKUP_PASSPHRASE."); process.exit(1); }
const out = file.replace(/\.enc$/, "");
if (out === file) { console.error("The file name should end in .enc"); process.exit(1); }
require("../services/backupCrypto").decryptFile(file, out, p)
  .then(() => console.log("Decrypted ->", out))
  .catch((e) => { console.error("Could not decrypt (wrong passphrase or damaged file):", e.message); process.exit(1); });
