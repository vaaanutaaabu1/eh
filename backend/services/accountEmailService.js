"use strict";

/*
 * Login-details email (email address + password) - the only account email that is sent: there is
 * no User ID and no "confirm your email" message. Uses the same SMTP account as the order emails
 * (SMTP_USER / SMTP_PASS / SMTP_FROM).
 *
 * The plain password only ever exists in memory long enough to be emailed;
 * the database stores a bcrypt hash.
 */

const mailer = require("./mailer");

const SITE_NAME = String(process.env.SITE_NAME || "Expert Help").trim();

function siteUrl() {
  return String(process.env.WEBSITE_URL || "").trim().replace(/\/+$/, "");
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isConfigured() {
  return mailer.isConfigured();
}

function credentialsHtml({ name, email, password, reason }) {
  const login = siteUrl() ? `${siteUrl()}/login` : "";
  const intro = {
    signup: "Your account is ready. Here are your login details:",
    reset: "As requested, we have issued a new password. Your previous password no longer works:"
  }[reason] || "Here are your sign-in details:";

  return `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1e1b4b">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e5e7f5">
      <h2 style="margin:0 0 6px;color:#5b21b6">${esc(SITE_NAME)}</h2>
      <p style="margin:0 0 18px">Hi ${esc(name)},</p>
      <p style="margin:0 0 16px">${intro}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;background:#f5f3ff;border-radius:10px">
        <tr><td style="padding:12px 16px;color:#6b7280;font-size:13px">Email</td>
            <td style="padding:12px 16px">${esc(email)}</td></tr>
        <tr><td style="padding:12px 16px;color:#6b7280;font-size:13px">Password</td>
            <td style="padding:12px 16px;font-family:Consolas,monospace;font-size:16px;font-weight:bold">${esc(password)}</td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:14px">Sign in with your <b>email address</b> and the password above. Keep this email for future use - you can change your password any time after logging in (Account &rarr; Settings). You can change the password any time from your account page.</p>
      ${login ? `<p style="margin:20px 0"><a href="${esc(login)}" style="background:#6d28d9;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:bold">Sign in</a></p>` : ""}
      <p style="margin:18px 0 0;font-size:12px;color:#6b7280">Keep this email private. If you did not create this account or request this, you can ignore it.</p>
    </div>
  </div></body></html>`;
}

function credentialsText({ name, email, password, reason }) {
  return `Hi ${name},\n\nEmail: ${email}\nPassword: ${password}\n\nSign in with your email address and this password. You can change your password any time after logging in (Account > Settings). You can change the password any time from your account page.\n`;
}

/** reason: "signup" | "reset" */
async function sendCredentials({ name, email, password, reason }) {
  if (!isConfigured()) {
    if (String(process.env.AUTH_DEV_LOG_CREDENTIALS || "").toLowerCase() === "true" && process.env.NODE_ENV !== "production") {
      console.log(`[AUTH DEV] SMTP not configured. Credentials for ${email}: ${password}`);
      return { sent: false, devLogged: true };
    }
    const err = new Error("Email is not configured on the server.");
    err.status = 503;
    throw err;
  }
  const subjects = {
    signup: `Your ${SITE_NAME} login details`,
    reset: `Your new ${SITE_NAME} password`
  };
  await mailer.send({
    to: email,
    subject: subjects[reason] || subjects.signup,
    html: credentialsHtml({ name, email, password, reason }),
    text: credentialsText({ name, email, password, reason })
  });
  return { sent: true };
}

module.exports = { sendCredentials, isConfigured };
