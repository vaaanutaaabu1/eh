"use strict";

const accounts = require("../services/accountService");
const store = require("../services/userStore");
const google = require("../services/googleAuthService");
const captcha = require("../services/captchaService");
const { issueSession, clearSession } = require("../middleware/userAuth");
const limits = require("../middleware/authRateLimit");

const PHONE_RE = /^[0-9+()\-\s.]{5,25}$/;

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function maskEmail(email) {
  const [u, d] = String(email).split("@");
  return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
}

/* POST /api/auth/signup  { name, email, phone?, password, confirmPassword? }
   The customer chooses their own password. The account is created and the customer is signed in
   straight away. There is no User ID and no email-confirmation step: the only email sent is one
   with the login details (email + password), best-effort - if the mail provider is down the
   account still exists. */
async function signup(req, res) {
  try {
    /* "I'm not a robot" is compulsory (reduces spam sign-ups): checked first, before anything is read from the database */
    const cap = await captcha.verify(req.body?.captcha, req.body?.website);
    if (!cap.ok) return res.status(cap.status).json({ success: false, field: cap.field, message: cap.message });

    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
    const email = accounts.normalizeEmail(req.body?.email);
    const phone = String(req.body?.phone || "").trim();
    const password = String(req.body?.password || "");
    const confirm = req.body?.confirmPassword;

    if (name.length < 2 || name.length > 150) return fail(res, 400, "Please enter your full name.");
    if (!accounts.isValidEmail(email)) return fail(res, 400, "Please enter a valid email address.");
    if (phone && !PHONE_RE.test(phone)) return fail(res, 400, "Please enter a valid phone number.");
    const problem = accounts.validatePasswordStrength(password);
    if (problem) return fail(res, 400, problem);
    if (confirm !== undefined && String(confirm) !== password) return fail(res, 400, "The two passwords don't match.");

    if (await store.findByEmail(email)) {
      return fail(res, 409, "An account with this email already exists. Log in, or use \"Forgot password\".");
    }

    const { user, emailSent } = await accounts.createAccount({
      name, email, phone: phone || null, provider: "manual", password, req
    });
    await store.touchLogin(user.id);
    issueSession(req, res, user);
    return res.status(201).json({
      success: true,
      emailSent,
      user: accounts.publicUser(user),
      message: emailSent
        ? `Account created. We are sending your login details to ${maskEmail(email)}.`
        : "Account created. You are signed in - log in any time with your email address and password."
    });
  } catch (error) {
    if (error.field) return res.status(error.status || 409).json({ success: false, field: error.field, message: error.message });
    if (error.status) return fail(res, error.status, error.message);
    console.error("SIGNUP ERROR:", error);
    return fail(res, 500, "Unable to create your account right now.");
  }
}

/* POST /api/auth/google  { credential }   (ID token from Google Sign-In) */
async function googleLogin(req, res) {
  try {
    const g = await google.verifyIdToken(req.body?.credential);

    let user = await store.findByGoogleSub(g.sub);
    let isNew = false;

    if (!user) {
      user = await store.findByEmail(g.email);
      if (user) {
        // Same verified email as an existing account: link Google to it (also marks the email verified).
        const resetHash = user.email_verified ? null : await accounts.hashPassword(accounts.generatePassword(24));
        user = await store.linkGoogle(user.id, g.sub, g.picture, resetHash);
        user = await accounts.adoptGoogleUsername(user);   // generated AH- ID -> Gmail username, if free
      } else {
        ({ user } = await accounts.createAccount({
          name: g.name, email: g.email, phone: null,
          provider: "google", googleSub: g.sub, avatarUrl: g.picture, req
        }));
        isNew = true;
      }
    }
    if (user.status === "suspended") { await store.setStatus(user.id, "active"); user.status = "active"; user.is_active = true; }
    if (user.status === "blocked" || !user.is_active) return fail(res, 403, "This account has been blocked. Please contact support.");

    await store.touchLogin(user.id);
    issueSession(req, res, user);
    return res.status(isNew ? 201 : 200).json({
      success: true,
      isNewUser: isNew,
      message: isNew ? "Welcome! Your account is ready." : "Signed in with Google.",
      user: accounts.publicUser(user)
    });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    console.error("GOOGLE LOGIN ERROR:", error);
    return fail(res, 500, "Unable to sign in with Google right now.");
  }
}

/* POST /api/auth/login  { identifier: email, password } */
async function login(req, res) {
  try {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? req.body?.userId ?? "").trim();
    const password = String(req.body?.password || "");
    if (!identifier || !password) return fail(res, 400, "Enter your email address and your password.");

    const parsed = accounts.parseIdentifier(identifier);
    const key = parsed ? parsed.value : identifier.toLowerCase().slice(0, 100);
    if (limits.failedLoginLimiter.count(key) >= limits.failedLoginLimiter.max) {
      return fail(res, 429, "Too many failed attempts for this account. Please wait 15 minutes or use \"Forgot password\".");
    }

    const user = parsed ? await accounts.findByIdentifier(identifier) : null;
    const ok = await accounts.verifyPassword(user, password);
    if (user && ok && user.status === "suspended") { await store.setStatus(user.id, "active"); user.status = "active"; user.is_active = true; }
    if (user && ok && (user.status === "blocked" || !user.is_active)) return fail(res, 403, "This account has been blocked. Please contact support.");
    if (!user || !ok || !user.is_active) {
      limits.failedLoginLimiter.hit(key);
      return fail(res, 401, "Incorrect email or password.");
    }

    await store.touchLogin(user.id);
    issueSession(req, res, user);
    return res.json({ success: true, user: accounts.publicUser(user) });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return fail(res, 500, "Unable to sign in right now.");
  }
}

function logout(req, res) {
  clearSession(req, res);
  res.json({ success: true });
}

/* POST /api/auth/forgot  { identifier }
   Always answers the same way so it can't be used to discover who has an account. */
async function forgot(req, res) {
  const generic = {
    success: true,
    message: "If an account exists, a new password has been emailed to it."
  };
  try {
    const user = await accounts.findByIdentifier(req.body?.identifier);
    // Google accounts sign in with Google, so they have no password to reset.
    const resettable = user && user.auth_provider !== "google" && user.password_set !== false;
    if (resettable && user.is_active && limits.perEmailLimiter.take(user.email.toLowerCase())) {
      try { await accounts.resetPassword(user); }
      catch (error) { console.error("[AUTH] Password email failed:", error.message); }
    }
    return res.json(generic);
  } catch (error) {
    console.error("FORGOT ERROR:", error);
    return res.json(generic);
  }
}

/* POST /api/auth/change-password  { currentPassword, newPassword }   (logged in) */
async function changePassword(req, res) {
  try {
    const current = String(req.body?.currentPassword || "");
    const next = String(req.body?.newPassword || "");
    // Google sign-up accounts have no password yet, so they can set one without a "current" one.
    const hasPassword = req.user.password_set !== false;
    if (hasPassword && !(await accounts.verifyPassword(req.user, current))) {
      return fail(res, 401, "Your current password is incorrect.");
    }
    const problem = accounts.validatePasswordStrength(next);
    if (problem) return fail(res, 400, problem);
    if (hasPassword && next === current) return fail(res, 400, "Choose a password different from the current one.");

    await store.setPassword(req.user.id, await accounts.hashPassword(next), false);
    const fresh = await store.findById(req.user.id);
    issueSession(req, res, fresh); // older sessions stop working; this one continues
    return res.json({ success: true, message: "Password updated." });
  } catch (error) {
    console.error("CHANGE PASSWORD ERROR:", error);
    return fail(res, 500, "Unable to change your password right now.");
  }
}

/* GET /api/auth/captcha  -> { id, nonce, bits }   (tiny proof-of-work challenge for the "I'm not a robot" checkbox) */
function captchaChallenge(req, res) {
  res.set("Cache-Control", "no-store");
  return res.json({ success: true, ...captcha.newChallenge() });
}

/* POST /api/auth/captcha/verify  { id, counter, signals } -> { pass } (single-use token that sign-up then sends back) */
function captchaVerify(req, res) {
  res.set("Cache-Control", "no-store");
  const r = captcha.solve(req.body?.id, req.body?.counter, req.body?.signals);
  if (r.ok) return res.json({ success: true, pass: r.pass });
  return res.status(r.status).json({ success: false, message: r.message, refresh: r.refresh });
}

/* GET /api/auth/config  - lets the frontend know which sign-in buttons to show. */
function config(req, res) {
  res.json({
    success: true,
    google: google.isConfigured() ? { clientId: google.clientId() } : null,
    captcha: { enabled: true },
    emailConfigured: require("../services/mailer").isConfigured()
  });
}

module.exports = { captchaChallenge, captchaVerify, signup, googleLogin, login, logout, forgot, changePassword, config };
