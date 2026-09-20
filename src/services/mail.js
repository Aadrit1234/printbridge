'use strict';
/* Outgoing mail — the licence email, and anything else worth sending.
 *
 * Three ways out, tried in this order:
 *
 *   MAIL_API_KEY + MAIL_FROM    Resend's HTTP API. No dependency, just fetch.
 *   MAIL_WEBHOOK_URL            POST the message as JSON to any relay you run
 *                               (Zapier, Make, your own endpoint, a mail server
 *                               with a small shim in front of it).
 *   neither                     data/mail-outbox/<time>-<address>.txt, plus a
 *                               line in the log.
 *
 * The last one is not a failure. On a machine that has not been given mail
 * credentials yet, an access code still has to exist somewhere a person can go
 * and read it, and a file in the data directory is that place: nothing is ever
 * silently dropped, and the buyer's code is never only in an error message.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger').make('mail');

let outboxDir = null;

function init(dataDir) {
  if (dataDir) outboxDir = path.join(dataDir, 'mail-outbox');
  return module.exports;
}

function env(name) {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function provider() {
  if (env('MAIL_API_KEY') && env('MAIL_FROM')) return 'resend';
  if (env('MAIL_WEBHOOK_URL')) return 'webhook';
  return 'outbox';
}

function configured() {
  return provider() !== 'outbox';
}

/** Where a message ended up, for the operator: a provider, or a file to open. */
function outboxPath(to, subject) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const who = String(to || 'unknown').replace(/[^a-z0-9@._-]/gi, '_').slice(0, 80);
  const what = String(subject || 'message').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  return path.join(outboxDir, `${stamp}-${who}-${what}.txt`);
}

function writeToOutbox({ to, subject, text }) {
  if (!outboxDir) throw new Error('mail.init() has not been called');
  fs.mkdirSync(outboxDir, { recursive: true });
  const file = outboxPath(to, subject);
  const body = [
    `To:      ${to}`,
    `From:    ${env('MAIL_FROM') || 'PrintBridge <no-reply@localhost>'}`,
    `Subject: ${subject}`,
    `Date:    ${new Date().toISOString()}`,
    '',
    text,
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

async function post(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (payload && (payload.message || payload.error)) || `HTTP ${res.status}`;
    throw new Error(`mail provider refused the message: ${detail}`);
  }
  return payload;
}

/**
 * Send one message. Never throws for want of credentials — it falls back to the
 * outbox instead — but does throw if a *configured* provider refuses, so a bad
 * API key cannot pass for a delivered licence.
 */
async function send({ to, subject, text, html = null, replyTo = null } = {}) {
  const address = String(to || '').trim();
  if (!address) throw new Error('mail.send() needs a recipient');
  const message = {
    to: address,
    subject: String(subject || 'PrintBridge').slice(0, 200),
    text: String(text || ''),
    html,
    replyTo,
  };

  const via = provider();
  try {
    if (via === 'resend') {
      const payload = await post('https://api.resend.com/emails', {
        from: env('MAIL_FROM'),
        to: [address],
        subject: message.subject,
        text: message.text,
        ...(html ? { html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }, { Authorization: `Bearer ${env('MAIL_API_KEY')}` });
      log.info(`sent "${message.subject}" to ${address} via resend`);
      return { sent: true, via, id: (payload && payload.id) || null, to: address };
    }

    if (via === 'webhook') {
      const payload = await post(env('MAIL_WEBHOOK_URL'), {
        from: env('MAIL_FROM') || null,
        ...message,
        secret: env('MAIL_WEBHOOK_SECRET') || undefined,
        sentAt: new Date().toISOString(),
      });
      log.info(`handed "${message.subject}" for ${address} to the mail webhook`);
      return { sent: true, via, id: (payload && payload.id) || null, to: address };
    }

    const file = writeToOutbox(message);
    log.warn(`no mail credentials — "${message.subject}" for ${address} written to ${file}`);
    return { sent: false, via: 'outbox', file, to: address };
  } catch (e) {
    /* A configured provider that fails must not lose the message either. Keep
     * the copy, then rethrow so the caller can tell the buyer what happened. */
    const file = outboxDir ? writeToOutbox(message) : null;
    log.error(`could not send "${message.subject}" to ${address}: ${e.message}${file ? ` (kept at ${file})` : ''}`);
    const err = new Error(e.message);
    err.file = file;
    throw err;
  }
}

/** Everything waiting in the outbox, newest first — for the operator console. */
function outbox(limit = 20) {
  if (!outboxDir || !fs.existsSync(outboxDir)) return [];
  return fs.readdirSync(outboxDir)
    .filter(name => name.endsWith('.txt'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(name => {
      const file = path.join(outboxDir, name);
      const stat = fs.statSync(file);
      return { file, name, bytes: stat.size, at: stat.mtime.toISOString() };
    });
}

function token(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }

module.exports = { init, send, outbox, configured, provider, token };
