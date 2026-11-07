"use strict";

/*
 * Account rules: password generation, hashing, creating accounts and
 * issuing login details by email. Customers sign in with their email address only.
 */

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const store = require("./userStore");
const emailer = require("./accountEmailService");

const BCRYPT_ROUNDS = 12;
// No 0/O, 1/I/l - IDs and passwords are read from an email and typed by hand.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function pick(chars) {
  return chars[crypto.randomInt(chars.length)];
}

function generateUserCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += pick(CODE_CHARS);
  return "AH-" + s;
}

/** 12 characters, always containing an upper-case letter, a lower-case letter and a digit. */
function generatePassword(length = 12) {
  const all = UPPER + LOWER + DIGITS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase().slice(0, 254);
}

function isValidEmail(v) {
  return EMAIL_RE.test(v);
}

const USER_ID_RE = /^[A-Za-z0-9._-]{4,16}$/;
const RESERVED_IDS = new Set(["admin", "administrator", "support", "root", "system", "help", "staff", "owner", "moderator", "assignmenthelp"]);

/** null if the chosen User ID is acceptable, otherwise the message to show. */
function validateUserId(raw) {
  const v = String(raw || "").trim();
  if (!USER_ID_RE.test(v)) return "Use 4-16 letters, numbers, dots, dashes or underscores.";
  if (/^ah-/i.test(v)) return "That User ID is reserved. Please pick another.";   // generated IDs use the AH- prefix
  if (RESERVED_IDS.has(v.toLowerCase())) return "That User ID isn't available.";
  return null;
}

/** Accounts are identified by email address only (the internal user code is never shown or typed). */
function parseIdentifier(raw) {
  const v = String(raw || "").trim();
  if (v.includes("@")) return { type: "email", value: normalizeEmail(v) };
  return null;
}

/* Google sign-in: the User ID is the part of the address before the @ (skrawal@gmail.com -> skrawal).
   Characters the User ID rules don't allow are dropped, it is cut to 16 characters, and if that is
   too short, reserved or already taken a short number is added so the ID stays unique. */
function usernameBase(email) {
  let base = String(email || "").split("@")[0].replace(/[^A-Za-z0-9._-]/g, "");
  if (/^ah-/i.test(base)) base = base.replace(/^ah-+/i, "");
  return base.slice(0, 16);
}

async function googleUserId(email, attempt = 0) {
  const base = usernameBase(email) || "user";
  for (let i = 0; i < 12; i++) {
    let candidate;
    if (attempt === 0 && i === 0) candidate = base;
    else candidate = base.slice(0, 12) + String(crypto.randomInt(100, 10000));
    while (candidate.length < 4) candidate += String(crypto.randomInt(10));
    candidate = candidate.slice(0, 16);
    if (validateUserId(candidate)) continue;                 // reserved or malformed
    if (!(await store.findByCode(candidate))) return candidate;
  }
  return generateUserCode();                                 // extremely unlikely fallback
}

/* An older account that only has a generated AH-XXXXXXXX ID switches to the Gmail username the first
   time Google sign-in is used with it. IDs the customer chose themselves are never changed. */
async function adoptGoogleUsername(user) {
  if (!user || !/^AH-/i.test(String(user.user_code || ""))) return user;
  const wanted = usernameBase(user.email);
  if (validateUserId(wanted) || (await store.findByCode(wanted))) return user;
  try {
    return (await store.setUserCode(user.id, wanted)) || user;
  } catch (error) {
    if (error && error.code === "23505") return user;        // someone took it a moment ago
    throw error;
  }
}

function validatePasswordStrength(pw) {
  const p = String(pw || "");
  if (p.length < 8) return "Password must be at least 8 characters.";
  if (p.length > 72) return "Password must be 72 characters or fewer.";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Password must contain letters and numbers.";
  return null;
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

let dummyHash = null;
/** Constant-ish work when the account does not exist, so timing doesn't reveal which IDs are registered. */
async function verifyPassword(user, pw) {
  if (!user) {
    if (!dummyHash) dummyHash = await bcrypt.hash("not-a-real-password", BCRYPT_ROUNDS);
    await bcrypt.compare(String(pw || ""), dummyHash);
    return false;
  }
  return bcrypt.compare(String(pw || ""), user.password_hash);
}

async function findByIdentifier(raw) {
  const id = parseIdentifier(raw);
  if (!id) return null;
  return id.type === "email" ? store.findByEmail(id.value) : store.findByCode(id.value);
}

function publicUser(u) {
  return {
    name: u.name,
    email: u.email,
    phone: u.phone || "",
    provider: u.auth_provider,
    avatarUrl: u.avatar_url || null,
    mustChangePassword: !!u.must_change_password,
    hasPassword: u.password_set !== false,
    memberSince: u.created_at,
    lastLogin: u.last_login_at || null
  };
}

/*
 * Create an account.
 *  - manual: the customer chose `password`. There is no email-confirmation step, so the address is
 *    treated as confirmed straight away; the only email sent contains the login details.
 *  - google: Google already verified the address; no password exists until the customer sets one,
 *    so nothing is emailed.
 * Sending email is best-effort and NEVER blocks or rolls back sign-up (a mail outage must not
 * stop customers from getting an account).
 */
async function createAccount({ name, email, phone, provider, googleSub, avatarUrl, password, req }) {
  const isGoogle = provider === "google";
  const passwordHash = await hashPassword(isGoogle ? generatePassword(24) : password);

  /* The user code is an internal key only (the column is required and unique); customers never see or type it. */
  let user = null;
  let code = isGoogle ? await googleUserId(email, 0) : null;
  for (let attempt = 0; attempt < 6 && !user; attempt++) {
    try {
      user = await store.insertUser({
        userCode: code || generateUserCode(),
        name, email, phone, provider, googleSub, avatarUrl,
        passwordHash,
        mustChangePassword: false,
        emailVerified: true,
        passwordSet: !isGoogle,
        verifyTokenHash: null,
        verifyExpires: null
      });
    } catch (error) {
      if (error && error.code === "23505") {
        if (/user_?code/i.test(String(error.constraint || ""))) {
          code = isGoogle ? await googleUserId(email, attempt + 1) : null;
          continue;                           // generated code collided: try another
        }
        const dup = new Error("An account with this email already exists.");
        dup.status = 409;
        throw dup;
      }
      throw error;
    }
  }
  if (!user) throw new Error("Could not allocate an account.");

  /* The login-details email is sent in the BACKGROUND: a slow or blocked mail provider (Railway blocks SMTP on Free/Hobby, relays can take
     up to 2 minutes) must never make sign-up hang or fail. The account already exists. */
  const emailSent = !isGoogle && emailer.isConfigured();
  if (!isGoogle) {
    Promise.resolve().then(() => emailer.sendCredentials({
      name: user.name, email: user.email, password, reason: "signup"
    })).catch((error) => console.error("[AUTH] Login-details email failed (account was still created):", error.message));
  }
  return { user, emailSent };
}

/* Issue a fresh password (forgot-password). Returns false if nothing was sent. */
async function resetPassword(user) {
  const password = generatePassword();
  await emailer.sendCredentials({
    name: user.name, email: user.email, password, reason: "reset"
  });
  // Only replace the stored password once the email has actually gone out.
  await store.setPassword(user.id, await hashPassword(password), true);
  return true;
}

module.exports = {
  generateUserCode, generatePassword, normalizeEmail, isValidEmail, parseIdentifier,
  validatePasswordStrength, hashPassword, verifyPassword, findByIdentifier,
  publicUser, validateUserId, googleUserId, adoptGoogleUsername, createAccount, resetPassword
};
