"use strict";
/* Where the website files live. Works with BOTH layouts:
     project/frontend + project/backend   (the 2-folder layout)   -> FRONT = project/frontend
     project/index.html + project/backend (the old flat layout)   -> FRONT = project                      */
const path = require("path"), fs = require("fs");
const PROJECT = path.resolve(__dirname, "..", "..");
const FRONT = fs.existsSync(path.join(PROJECT, "frontend", "index.html")) ? path.join(PROJECT, "frontend") : PROJECT;
module.exports = { PROJECT, FRONT };
