require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const registers = require('./config/registers');
const sec = require('./lib/security');

let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  Redis = null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// Vercel and most reverse proxies put the real client address in
// X-Forwarded-For. Without this, req.ip is the proxy and the audit log is
// useless for attribution.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(sec.securityHeaders);

// Same-origin only by default: the SPA is served by this very server, so there
// is no legitimate cross-origin caller. Set ALLOWED_ORIGIN to opt one in.
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || false,
  credentials: true
}));

// A day's readings for the largest plant is a few KB. The old 50mb ceiling let
// a single request append hundreds of thousands of rows to the spreadsheet.
app.use(bodyParser.json({ limit: '256kb' }));

// NOTE: there is deliberately no express.static here. Serving __dirname exposed
// credentials.json, server.js and code.gs over HTTP. Index.html is the only
// asset the page needs (its logo is an inline data URI) and it is served
// explicitly by the routes at the bottom of this file.

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1dfY5fkCvrgFTkGxH8ozSUhmct7q5oL6gCSWnpwUV7LY';
const CONFIG = {
  USD_CONVERSION_RATE: registers.USD_CONVERSION_RATE,
  LOGS_SHEET_NAME: 'Logs',
  ADJUSTMENT_SHEET_NAME: 'Adjustment/Correction Record'
};

// Helper: Get formatted date and time in Bangladesh Standard Time (BST, UTC+6)
function getBDTime(date = new Date()) {
  const formatterDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatterTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = formatterDate.format(date); // YYYY-MM-DD
  const timeStr = formatterTime.format(date); // HH:mm:ss
  const dateCompact = dateStr.replace(/-/g, ''); // YYYYMMDD
  return { dateStr, timeStr, dateCompact, fullStr: `${dateStr} ${timeStr}` };
}

// ============================================================================
// 1. REDIS & HIGH-SPEED IN-MEMORY HYBRID CACHING SYSTEM
// ============================================================================
let redisClient = null;
let redisConnected = false;

const redisUrl = process.env.REDIS_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_URL;

if (Redis && redisUrl) {
  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 4000,
      lazyConnect: true,
      enableOfflineQueue: false
    });

    redisClient.connect()
      .then(() => {
        redisConnected = true;
        console.log('[Cache] Redis Cache connected successfully.');
      })
      .catch(err => {
        console.warn('[Warning] Redis connection failed, using In-Memory Cache fallback:', err.message);
        redisConnected = false;
      });

    redisClient.on('error', (err) => {
      if (redisConnected) {
        console.warn('[Warning] Redis runtime error, falling back to In-Memory:', err.message);
      }
      redisConnected = false;
    });

    redisClient.on('ready', () => {
      redisConnected = true;
    });
  } catch (err) {
    console.warn('[Warning] Could not initialize Redis client, using In-Memory Cache:', err.message);
  }
}

// In-Memory TTL Cache Fallback.
// Bounded: an unbounded Map was a memory-exhaustion vector, because cache keys
// embed request-supplied values.
const MEMORY_CACHE_MAX_ENTRIES = 500;
const memoryCache = new Map();

function memoryCacheSet(key, value, ttlSeconds) {
  // Map preserves insertion order, so the first key is the oldest.
  if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES && !memoryCache.has(key)) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { data: value, expiry: Date.now() + (ttlSeconds * 1000) });
}

async function cacheGet(key) {
  if (redisConnected && redisClient) {
    try {
      const data = await redisClient.get(key);
      if (data) return JSON.parse(data);
    } catch (e) {
      // Fall through to memoryCache on error
    }
  }
  const item = memoryCache.get(key);
  if (item) {
    if (Date.now() < item.expiry) {
      return item.data;
    }
    memoryCache.delete(key);
  }
  return null;
}

async function cacheSet(key, value, ttlSeconds = 300) {
  if (redisConnected && redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      // Fall through to memoryCache
    }
  }
  memoryCacheSet(key, value, ttlSeconds);
}

async function cacheDel(patternOrPrefix) {
  if (redisConnected && redisClient) {
    // SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
    // keyspace, which on a shared Upstash instance affects everyone.
    try {
      let cursor = '0';
      do {
        const [next, found] = await redisClient.scan(cursor, 'MATCH', `*${patternOrPrefix}*`, 'COUNT', 200);
        cursor = next;
        if (found && found.length) await redisClient.del(...found);
      } while (cursor !== '0');
    } catch (e) {
      // Ignore Redis del errors
    }
  }
  for (const k of memoryCache.keys()) {
    if (k.includes(patternOrPrefix)) {
      memoryCache.delete(k);
    }
  }
}

async function cacheFlush() {
  if (redisConnected && redisClient) {
    try { await redisClient.flushdb(); } catch (e) {}
  }
  memoryCache.clear();
}

const rateLimit = sec.createRateLimiter({ cacheGet, cacheSet });

// ============================================================================
// 2. GOOGLE SHEETS API V4 CLIENT INITIALIZATION
// ============================================================================
let sheets;
try {
  let authConfig = {
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  };

  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const parsedCreds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      authConfig.credentials = parsedCreds;
    } catch (e) {
      console.warn("GOOGLE_CREDENTIALS env var found but failed to JSON parse, checking file fallback...");
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    authConfig.credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  if (!authConfig.credentials) {
    const credPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(credPath)) {
      authConfig.keyFile = credPath;
    }
  }

  const auth = new google.auth.GoogleAuth(authConfig);
  sheets = google.sheets({ version: 'v4', auth });
  console.log("Google Sheets API client initialized successfully.");
} catch (error) {
  console.error("Error initializing Google Sheets client:", error);
}

// --- Helpers ---
const getSheetName = registers.getSheetName;

// Robust date normalizer supporting Excel serial numbers, '25-Sep-26', ISO 'YYYY-MM-DD', Date objects
function formatDateIso(val) {
  if (val === undefined || val === null || val === '') return '';
  if (typeof val === 'number') {
    const utc_days = Math.floor(val - 25569);
    const date = new Date(utc_days * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }
  const parts = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (parts) {
    const day = parts[1].padStart(2, '0');
    const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    const m = months[parts[2].toLowerCase()];
    let yr = parts[3];
    if (yr.length === 2) yr = '20' + yr;
    if (m) return `${yr}-${m}-${day}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return str;
}

function toNumberOrRaw(v) {
  if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * Read a plant's sheet and derive, per section_utility_source key:
 *   - lastReadings:          the present reading from the most recent date
 *                            strictly BEFORE targetDate (chronological
 *                            inheritance, not "last appended row")
 *   - existingDailyReadings: rows already recorded ON targetDate (the daily lock)
 *
 * Shared by /api/previous-readings and /api/submit-data so both agree on what
 * "previous" means and the server never has to trust a client-supplied prev.
 */
async function readSheetState(sheetName, plant, isOvertime, targetDateIso) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:U`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const data = response.data.values || [];

  const lastReadings = {};
  const existingDailyReadings = {};
  const lastBeforeTarget = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === undefined || row[0] === null || String(row[0]).trim() === '') continue;
    const rowDateIso = formatDateIso(row[0]);

    // The Overtime sheet holds every plant, with Plant in column D, so each
    // field sits one column to the right of the per-plant sheets.
    let key, presNum, prevNum, diffNum, remarks;
    if (isOvertime) {
      if (row[3] !== plant) continue;
      key = row[4] + '_' + row[5] + '_' + row[6];
      prevNum = toNumberOrRaw(row[9]);
      presNum = toNumberOrRaw(row[10]);
      diffNum = Number(row[11]) || 0;
      remarks = row[20] || '';
    } else {
      key = row[3] + '_' + row[4] + '_' + row[5];
      prevNum = toNumberOrRaw(row[8]);
      presNum = toNumberOrRaw(row[9]);
      diffNum = Number(row[10]) || 0;
      remarks = '';
    }

    if (targetDateIso && rowDateIso === targetDateIso) {
      const entry = { submitted: true, prev: prevNum, pres: presNum, diff: diffNum };
      if (isOvertime) entry.remarks = remarks;
      existingDailyReadings[key] = entry;
    } else if (!targetDateIso || (rowDateIso && rowDateIso < targetDateIso)) {
      if (!lastBeforeTarget[key] || rowDateIso >= lastBeforeTarget[key].date) {
        lastBeforeTarget[key] = { date: rowDateIso, reading: presNum };
      }
    }
  }

  for (const k in lastBeforeTarget) {
    lastReadings[k] = lastBeforeTarget[k].reading;
  }

  return { lastReadings, existingDailyReadings };
}

/**
 * Append one row to the Logs sheet. IP and plant come from the server's own
 * view of the request, never from the request body.
 */
async function appendLog(req, entry) {
  try {
    const bd = getBDTime();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CONFIG.LOGS_SHEET_NAME}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          bd.dateStr,
          bd.timeStr,
          sec.sanitizeCell(entry.plant || ''),
          sec.sanitizeCell(entry.entryDate || bd.dateStr),
          sec.sanitizeCell(entry.action || 'Activity'),
          sec.sanitizeCell(entry.details || ''),
          entry.records !== undefined && entry.records !== null ? entry.records : '',
          entry.duration !== undefined && entry.duration !== null ? entry.duration : '',
          sec.getClientIp(req),
          sec.sanitizeCell(entry.location || 'Unknown'),
          sec.sanitizeCell(entry.device || 'Desktop'),
          sec.sanitizeCell(entry.browser || 'Unknown'),
          sec.sanitizeCell(entry.os || 'Unknown'),
          sec.sanitizeCell(entry.userAgent || String(req.headers['user-agent'] || ''))
        ]]
      }
    });
  } catch (logErr) {
    console.warn('Logging to sheet failed:', logErr.message);
  }
}

// ============================================================================
// 3. AUTHENTICATION
// ============================================================================

// Brute-force brake on the login endpoint, keyed by client IP. Only rejected
// codes count, so a plant signing in repeatedly during a handover is never
// locked out by its own successful logins.
const loginLimiter = rateLimit.failuresOnly({
  max: 10,
  windowSec: 15 * 60,
  keyFn: (req) => `login:${sec.getClientIp(req)}`,
  message: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { plant, code } = req.body || {};
    const identity = sec.authenticate(plant, code);

    if (!identity) {
      if (!sec.hasAnyAccessCodeConfigured()) {
        return res.status(401).json({
          error: 'No access codes are configured in the server environment. Please set PLANT_CODE_<PLANT> or ADMIN_CODE in your environment variables.'
        });
      }
      await loginLimiter.countFailure(req);
      await appendLog(req, {
        plant: registers.isKnownPlant(plant) ? plant : 'Unknown',
        action: 'Sign-in Failed',
        details: `Rejected access code for ${registers.isKnownPlant(plant) ? plant : 'unrecognised plant'}`
      });
      return res.status(401).json({ error: 'That access code was not recognised.' });
    }

    const token = sec.signSession({ plant: identity.plant, role: identity.role });
    sec.setSessionCookie(req, res, token);

    await appendLog(req, {
      plant: identity.plant === sec.ADMIN_PLANT ? 'ALL (Admin)' : identity.plant,
      action: 'Sign-in',
      details: `Session opened (${identity.role})`
    });

    res.json({
      plant: identity.plant,
      role: identity.role,
      plants: identity.plant === sec.ADMIN_PLANT ? registers.PLANTS : [identity.plant],
      expiresInSeconds: sec.SESSION_TTL_SEC
    });
  } catch (err) {
    return sec.failSafely(res, err, 'POST /api/auth/login');
  }
});

app.post('/api/auth/logout', (req, res) => {
  sec.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  const session = sec.readSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in.', code: 'AUTH_REQUIRED' });
  res.json({
    plant: session.plant,
    role: session.role || (session.plant === sec.ADMIN_PLANT ? 'admin' : 'plant'),
    plants: session.plant === sec.ADMIN_PLANT ? registers.PLANTS : [session.plant],
    expiresAt: session.exp
  });
});

// ============================================================================
// 4. API ENDPOINTS
// ============================================================================

// Health: the public form is a liveness probe only. The detailed telemetry
// (spreadsheet id, cache internals) is administrator-only.
app.get('/api/health', (req, res) => {
  const bd = getBDTime();
  const session = sec.readSession(req);

  if (!session || session.plant !== sec.ADMIN_PLANT) {
    return res.json({ status: 'healthy', timestamp: bd.fullStr });
  }

  res.json({
    status: 'healthy',
    timestamp: bd.fullStr,
    timezone: 'Asia/Dhaka (BST, UTC+6)',
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    version: '3.0.0-secure',
    caching: {
      provider: redisConnected ? 'Redis' : 'High-Speed In-Memory Cache',
      connected: redisConnected,
      inMemoryCachedEntries: memoryCache.size
    },
    googleSheets: {
      connected: !!sheets,
      spreadsheetId: SPREADSHEET_ID
    }
  });
});

app.post('/api/cache/clear', sec.requireAdmin, async (req, res) => {
  try {
    await cacheFlush();
    res.json({ success: true, message: 'All caches (Redis & In-Memory) flushed successfully.' });
  } catch (err) {
    return sec.failSafely(res, err, 'POST /api/cache/clear');
  }
});

// Endpoint: Fetch Previous Readings & Daily Locked State (With Cache)
app.post('/api/previous-readings',
  sec.requireAuth,
  rateLimit({
    max: 120,
    windowSec: 60 * 60,
    keyFn: (req) => `reads:${sec.readSession(req)?.plant || sec.getClientIp(req)}`
  }),
  async (req, res) => {
    try {
      const { plant, isOvertime, targetDate } = req.body || {};

      // Validate the plant BEFORE branching on isOvertime. The old code let
      // isOvertime:true skip validation entirely, so an arbitrary string
      // reached the sheet and became an unbounded cache key.
      if (!registers.isKnownPlant(plant)) {
        return res.status(400).json({ error: 'Invalid Plant selected.' });
      }
      if (!sec.sessionCanAccessPlant(req.session, plant)) {
        return res.status(403).json({ error: 'Your access code is not valid for that plant.' });
      }

      const isOT = isOvertime === true;
      const sheetName = isOT ? 'Overtime' : getSheetName(plant);
      const targetDateIso = targetDate ? formatDateIso(targetDate) : '';
      if (targetDateIso && !sec.isSaneEntryDate(targetDateIso)) {
        return res.status(400).json({ error: 'Requested date is out of range.' });
      }

      const cacheKey = `readings:${plant}:${isOT ? 'ot' : 'reg'}:${targetDateIso}`;
      const cached = await cacheGet(cacheKey);
      if (cached) {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
        return res.json(cached);
      }

      const payloadResult = await readSheetState(sheetName, plant, isOT, targetDateIso);
      await cacheSet(cacheKey, payloadResult, 300);

      res.set('X-Cache', 'MISS');
      res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
      res.json(payloadResult);
    } catch (err) {
      return sec.failSafely(res, err, 'POST /api/previous-readings');
    }
  }
);

// Endpoint: Submit Bulk Data (Enforces single daily entry, invalidates relevant cache)
app.post('/api/submit-data',
  sec.requireAuth,
  rateLimit({
    max: 30,
    windowSec: 60 * 60,
    keyFn: (req) => `submit:${sec.readSession(req)?.plant || sec.getClientIp(req)}`,
    message: 'Submission limit reached for this hour. Contact Central Engineering if this is unexpected.'
  }),
  async (req, res) => {
    try {
      // Validation rejects unknown registers, out-of-range readings, oversized
      // batches and mismatched dates, and returns only fields we will act on.
      const v = sec.validateSubmission(req.body);
      if (!v.ok) return res.status(400).json({ message: v.error });

      if (!sec.sessionCanAccessPlant(req.session, v.plant)) {
        return res.status(403).json({ message: 'Your access code is not valid for that plant.' });
      }

      const sheetName = v.isOvertime ? 'Overtime' : getSheetName(v.plant);
      const targetDateIso = formatDateIso(v.date);

      // Read fresh (not cached): a stale previous reading would be written into
      // the permanent record, and another operator may have just submitted.
      const { lastReadings, existingDailyReadings } = await readSheetState(
        sheetName, v.plant, v.isOvertime, targetDateIso
      );

      const newRecords = v.records.filter(rec => {
        const key = `${rec.section}_${rec.utility}_${rec.source}`;
        return !existingDailyReadings[key];
      });

      if (newRecords.length === 0) {
        return res.json({
          message: `Notice: all ${v.records.length} submitted registers are already recorded for ${targetDateIso}. Duplicate entries are restricted. Use Request Adjustment to correct a saved reading.`
        });
      }

      if (v.isOvertime && !v.remarks && !newRecords.some(r => r.remarks)) {
        return res.status(400).json({ message: 'Overtime entries require a reason or a per-register remark.' });
      }

      const dateObj = new Date(`${v.date}T00:00:00Z`);
      const month = dateObj.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      const year = dateObj.getUTCFullYear();

      const rowsToAppend = newRecords.map(rec => {
        const key = `${rec.section}_${rec.utility}_${rec.source}`;

        // Authoritative values. rec.cost and rec.unit came from
        // config/registers.js during validation, and prev is derived from the
        // sheet here -- the browser's numbers are never written.
        const prevReading = Number(lastReadings[key]) || 0;
        const presReading = rec.pres;
        const difference = presReading - prevReading;
        const unit = rec.unit;
        const unitCost = rec.cost;
        const totalBdt = difference * unitCost;
        const totalUsd = totalBdt / CONFIG.USD_CONVERSION_RATE;

        const kwh = (unit === 'kWh') ? difference : '';
        const m3 = (unit === 'M3') ? difference : '';
        const ltr = (unit === 'Ltr') ? difference : '';
        const kg = (unit === 'Kg') ? difference : '';

        const rowRemark = sec.sanitizeCell(rec.remarks || v.remarks || '');

        if (v.isOvertime) {
          return [
            v.date, month, year, v.plant,
            rec.section, rec.utility, rec.source, rec.equip, unit,
            prevReading, presReading, difference,
            kwh, m3, ltr, kg,
            difference, unitCost, totalBdt, totalUsd, rowRemark
          ];
        }
        return [
          v.date, month, year,
          rec.section, rec.utility, rec.source, rec.equip, unit,
          prevReading, presReading, difference,
          kwh, m3, ltr, kg,
          difference, unitCost, totalBdt, totalUsd
        ];
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAppend }
      });

      await cacheDel(`readings:${v.plant}`);

      const duplicateSkipped = v.records.length - newRecords.length;
      await appendLog(req, {
        plant: v.plant,
        entryDate: v.date,
        action: v.isOvertime ? 'Overtime Data Submitted' : 'Data Submitted',
        details: `Saved ${rowsToAppend.length} records (${duplicateSkipped} already submitted previously)`,
        records: rowsToAppend.length,
        duration: Number(req.body?.clientInfo?.duration) || '',
        device: sec.cleanText(req.body?.clientInfo?.device, 40),
        browser: sec.cleanText(req.body?.clientInfo?.browser, 40),
        os: sec.cleanText(req.body?.clientInfo?.os, 40)
      });

      let message = `Successfully saved ${rowsToAppend.length} ${v.isOvertime ? 'overtime ' : ''}records for ${v.plant}!`;
      if (duplicateSkipped > 0) {
        message = `Saved ${rowsToAppend.length} new ${v.isOvertime ? 'overtime ' : ''}records for ${v.plant}! (${duplicateSkipped} duplicates skipped).`;
      }
      res.json({ message });
    } catch (err) {
      return sec.failSafely(res, err, 'POST /api/submit-data');
    }
  }
);

// Endpoint: Adjustment / Correction Request
app.post('/api/adjustment',
  sec.requireAuth,
  rateLimit({
    max: 10,
    windowSec: 60 * 60,
    keyFn: (req) => `adjust:${sec.readSession(req)?.plant || sec.getClientIp(req)}`,
    message: 'Adjustment request limit reached for this hour.'
  }),
  async (req, res) => {
    try {
      const v = sec.validateAdjustment(req.body);
      if (!v.ok) return res.status(400).json({ success: false, message: v.error });

      if (!sec.sessionCanAccessPlant(req.session, v.plant)) {
        return res.status(403).json({ success: false, message: 'Your access code is not valid for that plant.' });
      }

      const bd = getBDTime();
      const requestId = `REQ-${bd.dateCompact}-${Math.floor(1000 + Math.random() * 9000)}`;
      const targetDate = v.targetDate || bd.dateStr;

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${CONFIG.ADJUSTMENT_SHEET_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            requestId,
            bd.fullStr,
            sec.sanitizeCell(v.plant),
            sec.sanitizeCell(v.shiftType),
            sec.sanitizeCell(targetDate),
            sec.sanitizeCell(v.register),
            sec.sanitizeCell(v.wrongValue),
            sec.sanitizeCell(v.correctValue),
            sec.sanitizeCell(v.reason),
            sec.sanitizeCell(v.staffName),
            sec.sanitizeCell(v.phone),
            'Pending Review',
            '', '', ''
          ]]
        }
      });

      await appendLog(req, {
        plant: v.plant,
        entryDate: targetDate,
        action: 'Adjustment Request Submitted',
        details: `[${requestId}] Register: ${v.register} | Wrong: ${v.wrongValue || 'N/A'} | Correct: ${v.correctValue || 'N/A'} | Reason: ${v.reason} | Staff: ${v.staffName} (${v.phone})`,
        records: 0
      });

      res.json({
        success: true,
        requestId,
        timestamp: bd.fullStr,
        message: `Adjustment request [${requestId}] has been successfully saved to the "Adjustment/Correction Record" sheet. Central Engineering Admin will review and contact you.`
      });
    } catch (err) {
      return sec.failSafely(res, err, 'POST /api/adjustment');
    }
  }
);

// Endpoint: Activity Logging
app.post('/api/log-activity',
  sec.requireAuth,
  rateLimit({
    max: 300,
    windowSec: 60 * 60,
    keyFn: (req) => `log:${sec.readSession(req)?.plant || sec.getClientIp(req)}`
  }),
  async (req, res) => {
    try {
      const logData = req.body || {};
      const sessionPlant = req.session.plant === sec.ADMIN_PLANT
        ? sec.cleanText(logData.plant, 40)
        : req.session.plant;

      await appendLog(req, {
        plant: sessionPlant,
        entryDate: sec.cleanText(logData.entryDate, 20),
        action: sec.cleanText(logData.action, 80) || 'Activity',
        details: sec.cleanText(logData.details, 500),
        records: Number.isFinite(Number(logData.records)) ? Number(logData.records) : '',
        duration: Number.isFinite(Number(logData.duration)) ? Number(logData.duration) : '',
        device: sec.cleanText(logData.device, 40),
        browser: sec.cleanText(logData.browser, 40),
        os: sec.cleanText(logData.os, 40)
      });
      res.json({ success: true });
    } catch (err) {
      return sec.failSafely(res, err, 'POST /api/log-activity');
    }
  }
);

// Endpoint: Export Full Consumption Audit CSV (administrator only -- this is
// every plant's consumption and cost history in one file)
app.get('/api/export-csv',
  sec.requireAdmin,
  rateLimit({
    max: 5,
    windowSec: 60 * 60,
    keyFn: (req) => `export:${sec.getClientIp(req)}`,
    message: 'Export limit reached for this hour.'
  }),
  async (req, res) => {
    try {
      const rows = [
        ['Plant', 'Date', 'Month', 'Year', 'Section', 'Utility Category', 'Source', 'Equipment', 'Unit', 'Previous Reading', 'Present Reading', 'Difference', 'kWh', 'M3', 'Ltr', 'Kg', 'Unit Cost (BDT)', 'Total Cost (BDT)', 'Total Cost (USD)']
      ];

      for (const plant of registers.PLANTS) {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${registers.PLANT_SHEET_MAP[plant]}!A:S`,
            valueRenderOption: 'UNFORMATTED_VALUE'
          });
          const data = response.data.values || [];
          for (let i = 1; i < data.length; i++) {
            const r = data[i];
            if (!r[0]) continue;
            rows.push([
              plant, formatDateIso(r[0]), r[1] || '', r[2] || '', r[3] || '',
              r[4] || '', r[5] || '', r[6] || '', r[7] || '',
              r[8] || 0, r[9] || 0, r[10] || 0,
              r[11] || '', r[12] || '', r[13] || '', r[14] || '',
              r[16] || 0, r[17] || 0, r[18] || 0
            ]);
          }
        } catch (e) {
          console.warn('Error reading for export:', e.message);
        }
      }

      // sanitizeCell neutralises cells that Excel would otherwise execute as
      // formulas when the downloaded file is opened.
      const csvContent = rows
        .map(r => r.map(val => `"${String(sec.sanitizeCell(val)).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
      const todayStr = getBDTime().dateStr;

      await appendLog(req, {
        plant: 'ALL (Admin)',
        action: 'Audit CSV Exported',
        details: `Exported ${rows.length - 1} consolidated rows`,
        records: rows.length - 1
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="EPIC_Utility_Consumption_Audit_${todayStr}.csv"`);
      res.send(csvContent);
    } catch (err) {
      return sec.failSafely(res, err, 'GET /api/export-csv');
    }
  }
);

// ============================================================================
// 5. STATIC PAGE & FALLBACKS
// ============================================================================
const INDEX_PATH = path.join(__dirname, 'Index.html');
let indexHtmlCache = null;

function serveIndexHtml(res) {
  try {
    if (!indexHtmlCache) {
      indexHtmlCache = fs.readFileSync(INDEX_PATH, 'utf8');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(indexHtmlCache);
  } catch (err) {
    console.error('Failed to load Index.html:', err);
    return res.status(500).send('Unable to load application interface. Please verify Index.html exists.');
  }
}

app.get('/', (req, res) => serveIndexHtml(res));

// Unmatched /api/* must 404 as JSON rather than fall through to the SPA.
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

// Everything else renders the SPA, which routes on the URL hash. Paths that
// look like a file request (.json, .js, .gs, .xlsx ...) get an honest 404
// instead of the page, so a probe for credentials.json is answered plainly.
const LOOKS_LIKE_FILE = /\.[a-z0-9]{1,8}$/i;

app.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).json({ error: 'Not found.' });
  if (LOOKS_LIKE_FILE.test(req.path) && req.path.toLowerCase() !== '/index.html') {
    return res.status(404).json({ error: 'Not found.' });
  }
  return serveIndexHtml(res);
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Using Google Sheets API with Spreadsheet ID: ${SPREADSHEET_ID}`);
    console.log(`[Cache] ${redisConnected ? 'Redis' : 'High-Speed In-Memory'} Caching: ACTIVE`);

    const configured = sec.configuredPlants();
    if (configured.length === 0 && !process.env.ADMIN_CODE) {
      console.warn('[Auth] WARNING: no access codes configured. Set PLANT_CODE_<PLANT> and/or ADMIN_CODE -- nobody can sign in until you do.');
    } else {
      console.log(`[Auth] Access codes configured for: ${configured.join(', ') || '(none)'}${process.env.ADMIN_CODE ? ' + ADMIN_CODE' : ''}`);
    }
    if (sec.usingEphemeralSecret) {
      console.warn('[Auth] WARNING: SESSION_SECRET is not set. Using a random secret for this process only -- everyone is signed out when the server restarts.');
    }
  });
}
