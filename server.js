require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  Redis = null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1dfY5fkCvrgFTkGxH8ozSUhmct7q5oL6gCSWnpwUV7LY';
const CONFIG = {
  USD_CONVERSION_RATE: 123,
  LOGS_SHEET_NAME: 'Logs',
  ADJUSTMENT_SHEET_NAME: 'Adjustment/Correction Record'
};

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
        console.log('⚡ Redis Cache connected successfully.');
      })
      .catch(err => {
        console.warn('⚠️ Redis connection failed, using In-Memory Cache fallback:', err.message);
        redisConnected = false;
      });

    redisClient.on('error', (err) => {
      if (redisConnected) {
        console.warn('⚠️ Redis runtime error, falling back to In-Memory:', err.message);
      }
      redisConnected = false;
    });

    redisClient.on('ready', () => {
      redisConnected = true;
    });
  } catch (err) {
    console.warn('⚠️ Could not initialize Redis client, using In-Memory Cache:', err.message);
  }
}

// In-Memory LRU/TTL Cache Fallback
const memoryCache = new Map();

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
  memoryCache.set(key, {
    data: value,
    expiry: Date.now() + (ttlSeconds * 1000)
  });
}

async function cacheDel(patternOrPrefix) {
  if (redisConnected && redisClient) {
    try {
      const keys = await redisClient.keys(`*${patternOrPrefix}*`);
      if (keys && keys.length) {
        await redisClient.del(...keys);
      }
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
function getSheetName(plant) {
  const plantMap = {
    'CIPL': 'CIPL-Data Sheet',
    'EGMCL 1': 'EGMCL 1 -Data Sheet',
    'EGMCL 7': 'EGMCL 7 -Data Sheet',
    'GTL': 'GTL -Data Sheet',
    'PGCL': 'PGCL -Data Sheet',
    'EGMCL 2': 'EGMCL 2 -Data Sheet ' 
  };
  return plantMap[plant] || null;
}

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

// Serve Index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Index.html'));
});

// ============================================================================
// 3. API ENDPOINTS
// ============================================================================

// Endpoint: Health & System Diagnostics (Redis, Sheets, Uptime, Cache stats)
app.get('/api/health', (req, res) => {
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: uptimeSec,
    version: '2.0.0-pro',
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

// Endpoint: Clear Cache manually
app.post('/api/cache/clear', async (req, res) => {
  try {
    await cacheFlush();
    res.json({ success: true, message: 'All caches (Redis & In-Memory) flushed successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Fetch Previous Readings & Daily Locked State (With Cache)
app.post('/api/previous-readings', async (req, res) => {
  try {
    const { plant, isOvertime, targetDate } = req.body;
    const sheetName = isOvertime ? 'Overtime' : getSheetName(plant);
    if (!sheetName) return res.status(400).json({ error: 'Invalid Plant selected.' });

    const targetDateIso = targetDate ? formatDateIso(targetDate) : '';
    const cacheKey = `readings:${plant}:${isOvertime ? 'ot' : 'reg'}:${targetDateIso}`;

    // Check Cache First
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
      return res.json(cached);
    }

    // Fetch from Google Sheets API
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

      if (isOvertime) {
        if (row[3] === plant) {
          const key = row[4] + '_' + row[5] + '_' + row[6];
          const presNum = row[10] !== undefined && row[10] !== null && row[10] !== '' && !isNaN(Number(row[10])) ? Number(row[10]) : row[10];
          const prevNum = row[9] !== undefined && row[9] !== null && row[9] !== '' && !isNaN(Number(row[9])) ? Number(row[9]) : row[9];
          const diffNum = row[11] !== undefined && row[11] !== null && row[11] !== '' && !isNaN(Number(row[11])) ? Number(row[11]) : 0;

          if (targetDateIso && rowDateIso === targetDateIso) {
            existingDailyReadings[key] = {
              submitted: true,
              prev: prevNum,
              pres: presNum,
              diff: diffNum,
              remarks: row[20] || ''
            };
          } else if (!targetDateIso || (rowDateIso && rowDateIso < targetDateIso)) {
            if (!lastBeforeTarget[key] || rowDateIso >= lastBeforeTarget[key].date) {
              lastBeforeTarget[key] = { date: rowDateIso, reading: presNum };
            }
          }
        }
      } else {
        const key = row[3] + '_' + row[4] + '_' + row[5];
        const presNum = row[9] !== undefined && row[9] !== null && row[9] !== '' && !isNaN(Number(row[9])) ? Number(row[9]) : row[9];
        const prevNum = row[8] !== undefined && row[8] !== null && row[8] !== '' && !isNaN(Number(row[8])) ? Number(row[8]) : row[8];
        const diffNum = row[10] !== undefined && row[10] !== null && row[10] !== '' && !isNaN(Number(row[10])) ? Number(row[10]) : 0;

        if (targetDateIso && rowDateIso === targetDateIso) {
          existingDailyReadings[key] = {
            submitted: true,
            prev: prevNum,
            pres: presNum,
            diff: diffNum
          };
        } else if (!targetDateIso || (rowDateIso && rowDateIso < targetDateIso)) {
          if (!lastBeforeTarget[key] || rowDateIso >= lastBeforeTarget[key].date) {
            lastBeforeTarget[key] = { date: rowDateIso, reading: presNum };
          }
        }
      }
    }

    // Populate lastReadings with the exact reading from the previous entry date
    for (const k in lastBeforeTarget) {
      lastReadings[k] = lastBeforeTarget[k].reading;
    }

    const payloadResult = { lastReadings, existingDailyReadings };
    
    // Save to Cache (TTL: 5 minutes)
    await cacheSet(cacheKey, payloadResult, 300);

    res.set('X-Cache', 'MISS');
    res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
    res.json(payloadResult);
  } catch (err) {
    console.error('Error in /api/previous-readings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Submit Bulk Data (Enforces single daily entry, invalidates relevant cache)
app.post('/api/submit-data', async (req, res) => {
  try {
    const { payload, clientInfo } = req.body;
    const records = payload.records;
    if (!records || records.length === 0) return res.status(400).json({ message: 'No data submitted.' });

    const plant = records[0].plant;
    const isOvertime = payload.isOvertime;
    const remarks = payload.remarks || '';
    const sheetName = isOvertime ? 'Overtime' : getSheetName(plant);
    if (!sheetName) return res.status(400).json({ message: 'Invalid Plant selected.' });

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:G`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const data = getRes.data.values || [];
    const targetDateIso = formatDateIso(records[0].date);
    const alreadyRecordedKeys = new Set();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (formatDateIso(row[0]) === targetDateIso) {
        if (isOvertime) {
          if (row[3] === plant) alreadyRecordedKeys.add(row[4] + '_' + row[5] + '_' + row[6]);
        } else {
          alreadyRecordedKeys.add(row[3] + '_' + row[4] + '_' + row[5]);
        }
      }
    }

    const newRecordsToSave = records.filter(rec => !alreadyRecordedKeys.has(rec.section + '_' + rec.utility + '_' + rec.source));
    if (newRecordsToSave.length === 0) {
      return res.json({ message: `Notice: All ${records.length} submitted registers have already been recorded for ${targetDateIso}. Duplicate entries are restricted. To request adjustments, please submit a comment for the admin.` });
    }

    const rowsToAppend = newRecordsToSave.map(rec => {
      const dateObj = new Date(rec.date);
      const month = dateObj.toLocaleString('en-US', { month: 'long' });
      const year = dateObj.getFullYear();
      const prevReading = parseFloat(rec.prev) || 0;
      const presReading = parseFloat(rec.pres) || 0;
      const difference = presReading - prevReading;
      const unit = rec.unit;
      const kwh = (unit === 'kWh') ? difference : '';
      const m3 = (unit === 'M3') ? difference : '';
      const ltr = (unit === 'Ltr') ? difference : '';
      const kg = (unit === 'Kg') ? difference : '';
      const unitCost = parseFloat(rec.cost) || 0;
      const totalBdt = difference * unitCost;
      const totalUsd = totalBdt / CONFIG.USD_CONVERSION_RATE;
      const rowRemark = (rec.remarks && String(rec.remarks).trim() !== '') ? String(rec.remarks).trim() : (remarks || '');

      if (isOvertime) {
        return [
          rec.date, month, year, plant,
          rec.section, rec.utility, rec.source, rec.equip, unit,
          prevReading, presReading, difference,
          kwh, m3, ltr, kg,
          difference, unitCost, totalBdt, totalUsd, rowRemark
        ];
      } else {
        return [
          rec.date, month, year,
          rec.section, rec.utility, rec.source, rec.equip, unit,
          prevReading, presReading, difference,
          kwh, m3, ltr, kg,
          difference, unitCost, totalBdt, totalUsd
        ];
      }
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowsToAppend }
    });

    // Invalidate affected cache keys
    await cacheDel(`readings:${plant}`);
    await cacheDel('dashboard');

    // Also record activity to Logs sheet
    try {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toTimeString().split(' ')[0];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${CONFIG.LOGS_SHEET_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            dateStr,
            timeStr,
            plant,
            records[0].date,
            isOvertime ? 'Overtime Data Submitted' : 'Data Submitted',
            `Saved ${rowsToAppend.length} records (${alreadyRecordedKeys.size} already submitted previously)`,
            rowsToAppend.length,
            clientInfo ? clientInfo.duration : '',
            clientInfo ? clientInfo.ip : 'Unknown',
            clientInfo ? clientInfo.location : 'Unknown',
            clientInfo ? clientInfo.device : 'Desktop',
            clientInfo ? clientInfo.browser : 'Unknown',
            clientInfo ? clientInfo.os : 'Unknown',
            clientInfo ? clientInfo.userAgent : ''
          ]]
        }
      });
    } catch (logErr) {
      console.warn('Logging to sheet failed:', logErr.message);
    }

    const duplicateSkipped = records.length - newRecordsToSave.length;
    let message = `Successfully saved ${rowsToAppend.length} ${isOvertime ? 'overtime ' : ''}records for ${plant}!`;
    if (duplicateSkipped > 0) message = `Saved ${rowsToAppend.length} new ${isOvertime ? 'overtime ' : ''}records for ${plant}! (${duplicateSkipped} duplicates skipped).`;
    
    res.json({ message });
  } catch (err) {
    console.error('Error in /api/submit-data:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Adjustment / Correction Request
app.post('/api/adjustment', async (req, res) => {
  try {
    const payload = req.body || {};
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateCompact = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const timestampStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${timeStr}`;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const requestId = `REQ-${dateCompact}-${randomSuffix}`;

    const plant = payload.plant || 'Unknown';
    const shiftType = payload.shiftType || (payload.isOvertime ? 'Overtime' : 'Regular');
    const targetDate = payload.targetDate || payload.entryDate || dateCompact;
    const register = payload.register || payload.registerName || 'General / All Registers';
    const wrongVal = payload.wrongValue !== undefined && payload.wrongValue !== null ? String(payload.wrongValue).trim() : (payload.existingReading || '');
    const correctVal = payload.correctValue !== undefined && payload.correctValue !== null ? String(payload.correctValue).trim() : (payload.proposedReading || '');
    const reason = payload.reason || payload.comment || 'Correction requested by plant operator.';
    const staffName = payload.staffName || payload.requesterName || 'Plant Operator';
    const phone = payload.phone || payload.contact || 'N/A';
    const status = 'Pending Review';

    // Append to Adjustment/Correction Record sheet in Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CONFIG.ADJUSTMENT_SHEET_NAME}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          requestId,
          timestampStr,
          plant,
          shiftType,
          targetDate,
          register,
          wrongVal,
          correctVal,
          reason,
          staffName,
          phone,
          status,
          '', '', ''
        ]]
      }
    });

    // Invalidate dashboard cache
    await cacheDel('dashboard');

    // Also record event to central audit Logs sheet
    try {
      const dateStr = now.toISOString().split('T')[0];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${CONFIG.LOGS_SHEET_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            dateStr,
            timeStr,
            plant,
            targetDate,
            'Adjustment Request Submitted',
            `[${requestId}] Register: ${register} | Wrong: ${wrongVal || 'N/A'} | Correct: ${correctVal || 'N/A'} | Reason: ${reason} | Staff: ${staffName} (${phone})`,
            0, '', 'Unknown', 'Unknown', 'Desktop', 'Unknown', 'Unknown', ''
          ]]
        }
      });
    } catch (e) {
      console.warn('Logging adjustment failed:', e.message);
    }

    res.json({
      success: true,
      requestId: requestId,
      timestamp: timestampStr,
      message: `Adjustment request [${requestId}] has been successfully saved to the "Adjustment/Correction Record" sheet. Central Engineering Admin will review and contact you.`
    });
  } catch (err) {
    console.error('Error submitting adjustment:', err);
    res.status(500).json({ success: false, message: 'Failed to record adjustment request: ' + err.message });
  }
});

// Endpoint: Activity Logging
app.post('/api/log-activity', async (req, res) => {
  try {
    const logData = req.body || {};
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CONFIG.LOGS_SHEET_NAME}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          dateStr,
          timeStr,
          logData.plant || '',
          logData.entryDate || dateStr,
          logData.action || 'Activity',
          logData.details || '',
          (logData.records !== undefined && logData.records !== null) ? logData.records : '',
          (logData.duration !== undefined && logData.duration !== null) ? logData.duration : '',
          logData.ip || 'Unknown',
          logData.location || 'Unknown',
          logData.device || 'Desktop',
          logData.browser || 'Unknown',
          logData.os || 'Unknown',
          logData.userAgent || ''
        ]]
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Logging failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Dashboard Data (With High-Speed Caching)
app.get('/api/dashboard', async (req, res) => {
  try {
    const cacheKey = 'dashboard:all_data';
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
      return res.json(cached);
    }

    const plantSheetMap = {
      'CIPL': 'CIPL-Data Sheet',
      'EGMCL 1': 'EGMCL 1 -Data Sheet',
      'EGMCL 7': 'EGMCL 7 -Data Sheet',
      'GTL': 'GTL -Data Sheet',
      'PGCL': 'PGCL -Data Sheet',
      'EGMCL 2': 'EGMCL 2 -Data Sheet ' 
    };

    const actualRecords = [];

    // Query each plant sheet
    for (const plant in plantSheetMap) {
      try {
        const sheetName = plantSheetMap[plant];
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A:R`,
          valueRenderOption: 'UNFORMATTED_VALUE'
        });
        const data = response.data.values || [];
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (row[0] === undefined || row[0] === null || String(row[0]).trim() === '') continue;
          actualRecords.push({
            date: formatDateIso(row[0]),
            plant: plant,
            section: row[3] ? String(row[3]).trim() : '',
            utility: row[4] ? String(row[4]).trim() : '',
            source: row[5] ? String(row[5]).trim() : '',
            equip: row[6] ? String(row[6]).trim() : '',
            unit: row[7] ? String(row[7]).trim() : '',
            kwh: parseFloat(row[11]) || 0,
            m3: parseFloat(row[12]) || 0,
            ltr: parseFloat(row[13]) || 0,
            kg: parseFloat(row[14]) || 0,
            cost: parseFloat(row[17]) || 0
          });
        }
      } catch (sheetErr) {
        console.warn(`Could not read sheet for ${plant}:`, sheetErr.message);
      }
    }

    // Read 01_Records for Budget
    const budgetRecords = [];
    try {
      const bRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: '01_Records!A:Q',
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      const bData = bRes.data.values || [];
      const months = ['Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27', 'Apr-27', 'May-27', 'Jun-27'];
      for (let i = 1; i < bData.length; i++) {
        const row = bData[i];
        if (!row[0]) continue;
        const monthlyObj = {};
        for (let m = 0; m < months.length; m++) {
          const cellVal = row[4 + m];
          monthlyObj[months[m]] = typeof cellVal === 'number' ? cellVal : (parseFloat(String(cellVal || 0).replace(/[^0-9.-]+/g, '')) || 0);
        }
        const totalCell = row[16];
        const parsedTotal = typeof totalCell === 'number' ? totalCell : (parseFloat(String(totalCell || 0).replace(/[^0-9.-]+/g, '')) || 0);
        budgetRecords.push({
          plant: String(row[0]).trim(),
          section: row[1] ? String(row[1]).trim() : '',
          utility: row[2] ? String(row[2]).trim() : '',
          source: row[3] ? String(row[3]).trim() : '',
          months: monthlyObj,
          total: parsedTotal
        });
      }
    } catch (bErr) {
      console.warn('Could not read 01_Records:', bErr.message);
    }

    const payloadResult = {
      records: actualRecords,
      budgetRecords: budgetRecords,
      plants: ['CIPL', 'EGMCL 1', 'EGMCL 2', 'PGCL', 'EGMCL 7', 'GTL']
    };

    // Cache dashboard data for 180 seconds (3 mins)
    await cacheSet(cacheKey, payloadResult, 180);

    res.set('X-Cache', 'MISS');
    res.set('X-Cache-Backend', redisConnected ? 'Redis' : 'Memory');
    res.json(payloadResult);
  } catch (err) {
    console.error('Dashboard fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Export Full Consumption Audit CSV
app.get('/api/export-csv', async (req, res) => {
  try {
    const plantSheetMap = {
      'CIPL': 'CIPL-Data Sheet',
      'EGMCL 1': 'EGMCL 1 -Data Sheet',
      'EGMCL 7': 'EGMCL 7 -Data Sheet',
      'GTL': 'GTL -Data Sheet',
      'PGCL': 'PGCL -Data Sheet',
      'EGMCL 2': 'EGMCL 2 -Data Sheet ' 
    };

    const rows = [
      ['Plant', 'Date', 'Month', 'Year', 'Section', 'Utility Category', 'Source', 'Equipment', 'Unit', 'Previous Reading', 'Present Reading', 'Difference', 'kWh', 'M3', 'Ltr', 'Kg', 'Unit Cost (BDT)', 'Total Cost (BDT)', 'Total Cost (USD)']
    ];

    for (const plant in plantSheetMap) {
      try {
        const sheetName = plantSheetMap[plant];
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A:S`,
          valueRenderOption: 'UNFORMATTED_VALUE'
        });
        const data = response.data.values || [];
        for (let i = 1; i < data.length; i++) {
          const r = data[i];
          if (!r[0]) continue;
          rows.push([
            plant,
            formatDateIso(r[0]),
            r[1] || '',
            r[2] || '',
            r[3] || '',
            r[4] || '',
            r[5] || '',
            r[6] || '',
            r[7] || '',
            r[8] || 0,
            r[9] || 0,
            r[10] || 0,
            r[11] || '',
            r[12] || '',
            r[13] || '',
            r[14] || '',
            r[16] || 0,
            r[17] || 0,
            r[18] || 0
          ]);
        }
      } catch (e) {
        console.warn('Error reading for export:', e.message);
      }
    }

    const csvContent = rows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const todayStr = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="EPIC_Utility_Consumption_Audit_${todayStr}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('CSV Export Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export app for serverless platforms like Vercel
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Using Google Sheets API with Spreadsheet ID: ${SPREADSHEET_ID}`);
    if (redisConnected) {
      console.log('⚡ Redis Caching: ACTIVE');
    } else {
      console.log('⚡ High-Speed In-Memory Caching: ACTIVE');
    }
  });
}
