"use strict";

const express = require("express");
const c = require("../controllers/authController");
const { requireUser } = require("../middleware/userAuth");
const { loginLimiter, signupLimiter, forgotLimiter } = require("../middleware/authRateLimit");

const router = express.Router();

// Each picture/answer costs the server a little work, so cap them per IP.
const captchaLimiter = require("../middleware/authRateLimit").makeLimiter({
  windowMs: 60 * 1000, max: 120, message: "Too many checks. Please wait a minute."
});

router.get("/config", c.config);
router.get("/captcha", captchaLimiter, c.captchaChallenge);
router.post("/captcha/verify", captchaLimiter, c.captchaVerify);
router.post("/signup", signupLimiter, c.signup);
router.post("/google", loginLimiter, c.googleLogin);
router.post("/login", loginLimiter, c.login);
router.post("/logout", c.logout);
router.post("/forgot", forgotLimiter, c.forgot);
router.post("/change-password", requireUser, c.changePassword);

module.exports = router;
