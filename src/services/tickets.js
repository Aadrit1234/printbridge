'use strict';
/* Print tickets — one short, unique code per print command.
 *
 * Every time someone presses Print, the job gets a *new* ticket: a token the
 * person can read out loud (PB-7K4Q-2M9D) and the admin can look up. The ticket
 * carries the state of that print command — queued, waiting for the printer,
 * printing, printed, failed — so both sides can talk about the same print
 * without quoting job ids.
 *
 * Tickets are appended to the job (`job.tickets`) and the newest one is the
 * live ticket (`job.token`), so a reprint keeps its own history.
 */

const crypto = require('crypto');
const log = require('../logger').make('tickets');

/* No 0/O/1/I/L: these get read off a screen and typed by hand. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUP = 4;
const MAX_PER_JOB = 12;

const STATES = ['queued', 'waiting', 'printing', 'printed', 'failed', 'canceled'];
const TERMINAL = new Set(['printed', 'failed', 'canceled']);

function block() {
  let out = '';
  for (let i = 0; i < GROUP; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

/** PB-XXXX-XXXX */
function newToken() {
  return `PB-${block()}-${block()}`;
}

/** Tolerate however somebody types it back in. */
function normalize(value) {
  const raw = String(value || '').toUpperCase().replace(/^PB/, '').replace(/[^0-9A-Z]/g, '');
  if (raw.length !== GROUP * 2) return null;
  return `PB-${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`;
}

/** Every token already handed out, so a fresh one is never a repeat. */
function issuedTokens(jobs) {
  const taken = new Set();
  for (const job of jobs) {
    for (const ticket of job.tickets || []) if (ticket && ticket.token) taken.add(ticket.token);
  }
  return taken;
}

function uniqueToken(jobs) {
  const taken = issuedTokens(jobs);
  for (let attempt = 0; attempt < 50; attempt++) {
    const token = newToken();
    if (!taken.has(token)) return token;
  }
  return `${newToken()}${crypto.randomInt(0, 9)}`;
}

/**
 * Open a ticket for a print command. Returns the ticket; the caller stores it.
 */
function issue(job, { target = null, copies = 1, paper = null, duplex = false, allJobs = [] } = {}) {
  const ticket = {
    token: uniqueToken(allJobs),
    state: 'queued',
    at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    target: target || null,
    targetName: null,
    copies: Number(copies) || 1,
    paper: paper || null,
    duplex: Boolean(duplex),
    backend: null,
    printerJobId: null,
    message: '',
    error: '',
  };
  log.info(`${job.id} ticket ${ticket.token} opened${target ? ` for ${target}` : ''}`);
  return ticket;
}

function forJob(job, token) {
  const wanted = normalize(token);
  if (!wanted) return null;
  return (job.tickets || []).find(t => t.token === wanted) || null;
}

/** The ticket a job is currently working on (the newest one). */
function active(job) {
  const list = job && job.tickets ? job.tickets : [];
  return list.length ? list[list.length - 1] : null;
}

function append(job, ticket) {
  const list = [...(job.tickets || []), ticket];
  return list.slice(-MAX_PER_JOB);
}

function isTerminal(state) { return TERMINAL.has(state); }

module.exports = {
  issue, append, active, forJob, normalize, newToken,
  STATES, TERMINAL, MAX_PER_JOB, isTerminal,
};
