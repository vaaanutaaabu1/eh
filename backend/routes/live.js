"use strict";
const express = require("express");
const { requireUser } = require("../middleware/userAuth");
const live = require("../services/liveEvents");
const router = express.Router();
router.get("/", requireUser, live.handler);
module.exports = router;
