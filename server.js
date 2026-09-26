require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

const SPREADSHEET_ID = '1dfY5fkCvrgFTkGxH8ozSUhmct7q5oL6gCSWnpwUV7LY';
const CONFIG = {
  USD_CONVERSION_RATE: 123,
  LOGS_SHEET_NAME: 'Logs',
  ADJUSTMENT_SHEET_NAME: 'Adjustment/Correction Record'
};

// --- Google Sheets Auth ---
let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
  console.log("Google Sheets API client initialized.");
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

function formatDateIso(val) {
  if (!val) return '';
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
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

// Endpoint: Fetch Previous Readings
app.post('/api/previous-readings', async (req, res) => {
  try {
    const { plant, isOvertime, targetDate } = req.body;
    const sheetName = isOvertime ? 'Overtime' : getSheetName(plant);
    if (!sheetName) return res.status(400).json({ error: 'Invalid Plant selected.' });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:U`
    });
    const data = response.data.values || [];
    
    const lastReadings = {};
    const existingDailyReadings = {};
    const targetDateIso = targetDate ? formatDateIso(targetDate) : '';

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue;
      const rowDateIso = formatDateIso(row[0]);

      if (isOvertime) {
        if (row[3] === plant) {
          const key = row[4] + '_' + row[5] + '_' + row[6];
          if (targetDateIso && rowDateIso === targetDateIso) {
            existingDailyReadings[key] = {
              submitted: true,
              prev: row[9],
              pres: row[10],
              diff: row[11],
              remarks: row[20] || ''
            };
          } else {
            lastReadings[key] = row[10];
          }
        }
      } else {
        const key = row[3] + '_' + row[4] + '_' + row[5];
        if (targetDateIso && rowDateIso === targetDateIso) {
          existingDailyReadings[key] = {
            submitted: true,
            prev: row[8],
            pres: row[9],
            diff: row[10]
          };
        } else {
          lastReadings[key] = row[9];
        }
      }
    }
    res.json({ lastReadings, existingDailyReadings });
  } catch (err) {
    console.error('Error in /api/previous-readings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Submit Bulk Data
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
      range: `${sheetName}!A:G`
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
        return [rec.date, month, year, plant, rec.section, rec.utility, rec.source, rec.equip, unit, prevReading, presReading, difference, kwh, m3, ltr, kg, difference, unitCost, totalBdt, totalUsd, rowRemark];
      } else {
        return [rec.date, month, year, rec.section, rec.utility, rec.source, rec.equip, unit, prevReading, presReading, difference, kwh, m3, ltr, kg, difference, unitCost, totalBdt, totalUsd];
      }
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowsToAppend }
    });

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

// Endpoint: Dashboard Data
app.get('/api/dashboard', async (req, res) => {
  try {
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
          range: `${sheetName}!A:R`
        });
        const data = response.data.values || [];
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (!row[0]) continue;
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
        range: '01_Records!A:Q'
      });
      const bData = bRes.data.values || [];
      const months = ['Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27', 'Apr-27', 'May-27', 'Jun-27'];
      for (let i = 1; i < bData.length; i++) {
        const row = bData[i];
        if (!row[0]) continue;
        const monthlyObj = {};
        for (let m = 0; m < months.length; m++) {
          const cellVal = row[4 + m];
          monthlyObj[months[m]] = typeof cellVal === 'number' ? cellVal : (parseFloat(String(cellVal || 0).replace(/,/g, '')) || 0);
        }
        const totalCell = row[16];
        const parsedTotal = typeof totalCell === 'number' ? totalCell : (parseFloat(String(totalCell || 0).replace(/,/g, '')) || 0);
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

    res.json({
      records: actualRecords,
      budgetRecords: budgetRecords,
      plants: ['CIPL', 'EGMCL 1', 'EGMCL 2', 'PGCL', 'EGMCL 7', 'GTL']
    });
  } catch (err) {
    console.error('Dashboard fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`Using Google Sheets API with Spreadsheet ID: ${SPREADSHEET_ID}`);
});
