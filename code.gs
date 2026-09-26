/*******************************************************
 * EPIC UTILITY HUB - BULK ENTRY & DASHBOARD
 * Google Apps Script Backend
 * Central Engineering - EPIC Group
 *******************************************************/

const CONFIG = {
  USD_CONVERSION_RATE: 123,
  LOGS_SHEET_NAME: 'Logs',
  ADJUSTMENT_SHEET_NAME: 'Adjustment/Correction Record'
};

/* =====================================================
   WEB APP ENTRY POINT
   ===================================================== */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Epic Utility Hub')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* =====================================================
   PLANT -> DATA SHEET MAPPING
   ===================================================== */
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

/* =====================================================
   DATE NORMALIZER HELPER
   ===================================================== */
function formatDateIso(val, tz) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, tz || Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, tz || Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return str;
}

/* =====================================================
   FETCH PREVIOUS READINGS & DAILY LOCK STATE
   Checks which registers have already been recorded for targetDate
   ===================================================== */
function fetchAllPreviousReadings(plant, isOvertime = false, targetDate = '') {
  const sheetName = isOvertime ? 'Overtime' : getSheetName(plant);
  if (!sheetName) throw new Error('Invalid Plant selected.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheetSafely(ss, sheetName);
  if (!sheet) return { lastReadings: {}, existingDailyReadings: {} }; 

  const tz = Session.getScriptTimeZone();
  const data = sheet.getDataRange().getValues();
  const lastReadings = {};
  const existingDailyReadings = {};
  const targetDateIso = targetDate ? formatDateIso(targetDate, tz) : '';

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowDateIso = formatDateIso(row[0], tz);

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

  return {
    lastReadings: lastReadings,
    existingDailyReadings: existingDailyReadings
  };
}

/* =====================================================
   ACTIVITY LOGGING TO "Logs" SHEET
   ===================================================== */
function logActivity(logData) {
  try {
    if (!logData) return false;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = CONFIG.LOGS_SHEET_NAME || 'Logs';
    let sheet = ss.getSheetByName(sheetName);
    
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow([
        'Date', 'Time', 'Plant', 'Entry Date', 'Action', 'Details', 
        'Records', 'Duration (s)', 'IP Address', 'Location', 'Device', 'Browser', 'OS', 'User Agent'
      ]);
    }
    
    const tz = 'Asia/Dhaka';
    const now = new Date();
    const dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const timeStr = Utilities.formatDate(now, tz, 'HH:mm:ss');
    
    sheet.appendRow([
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
    ]);
    return true;
  } catch(e) {
    console.error('Error logging to sheet:', e);
    return false;
  }
}

/* =====================================================
   SUBMIT BULK DATA
   Enforces single entry per day per register.
   Allows entering remaining registers on the same day.
   ===================================================== */
function submitBulkData(payload, clientInfo) {
  const records = payload.records;
  if (!records || records.length === 0) return 'No data submitted.';

  const plant = records[0].plant;
  const isOvertime = payload.isOvertime;
  const remarks = payload.remarks || '';
  
  const sheetName = isOvertime ? 'Overtime' : getSheetName(plant);
  if (!sheetName) return 'Error: Invalid Plant selected.';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheetSafely(ss, sheetName);
  if (!sheet) return 'Error: Sheet "' + sheetName + '" not found. Please create it.';

  const tz = Session.getScriptTimeZone();
  const targetDateIso = formatDateIso(records[0].date, tz);

  // Check for already-submitted registers for this date to prevent duplicate entry
  const data = sheet.getDataRange().getValues();
  const alreadyRecordedKeys = new Set();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowDateIso = formatDateIso(row[0], tz);
    if (rowDateIso === targetDateIso) {
      if (isOvertime) {
        if (row[3] === plant) {
          alreadyRecordedKeys.add(row[4] + '_' + row[5] + '_' + row[6]);
        }
      } else {
        alreadyRecordedKeys.add(row[3] + '_' + row[4] + '_' + row[5]);
      }
    }
  }

  // Filter out any record that was already submitted for this date
  const newRecordsToSave = records.filter(rec => {
    const key = rec.section + '_' + rec.utility + '_' + rec.source;
    return !alreadyRecordedKeys.has(key);
  });

  if (newRecordsToSave.length === 0) {
    return `Notice: All ${records.length} submitted registers have already been recorded for ${targetDateIso}. Duplicate entries are restricted. To request adjustments, please submit a comment for the admin.`;
  }

  const rowsToAppend = newRecordsToSave.map(rec => {
    const dateObj = new Date(rec.date);
    const month = Utilities.formatDate(dateObj, tz, 'MMMM');
    const year = dateObj.getFullYear();

    const prevReading = parseFloat(rec.prev) || 0;
    const presReading = parseFloat(rec.pres) || 0;
    const difference = presReading - prevReading;

    const unit = rec.unit;
    const kwh  = (unit === 'kWh') ? difference : '';
    const m3   = (unit === 'M3')  ? difference : '';
    const ltr  = (unit === 'Ltr') ? difference : '';
    const kg   = (unit === 'Kg')  ? difference : '';

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

  sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);

  // Automatically record to Logs sheet
  logActivity({
    plant: plant,
    entryDate: records[0].date,
    action: isOvertime ? 'Overtime Data Submitted' : 'Data Submitted',
    details: `Saved ${rowsToAppend.length} records (${alreadyRecordedKeys.size} already submitted previously)`,
    records: rowsToAppend.length,
    duration: clientInfo ? clientInfo.duration : '',
    ip: clientInfo ? clientInfo.ip : 'Unknown',
    location: clientInfo ? clientInfo.location : 'Unknown',
    device: clientInfo ? clientInfo.device : 'Desktop',
    browser: clientInfo ? clientInfo.browser : 'Unknown',
    os: clientInfo ? clientInfo.os : 'Unknown',
    userAgent: clientInfo ? clientInfo.userAgent : ''
  });

  const duplicateSkipped = records.length - newRecordsToSave.length;
  if (duplicateSkipped > 0) {
    return `Saved ${rowsToAppend.length} new ${isOvertime ? 'overtime ' : ''}records for ${plant}! (${duplicateSkipped} already-recorded registers were preserved without duplicate entries).`;
  }
  return `Successfully saved ${rowsToAppend.length} ${isOvertime ? 'overtime ' : ''}records for ${plant}!`;
}

/* =====================================================
   SUBMIT ADJUSTMENT / CORRECTION REQUEST
   Saves to "Adjustment/Correction Record" Sheet
   Creates sheet with audit-ready formatting if not existing
   ===================================================== */
function submitAdjustmentRequest(payload) {
  try {
    if (!payload) return { success: false, message: 'Error: Empty adjustment payload received.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = CONFIG.ADJUSTMENT_SHEET_NAME || 'Adjustment/Correction Record';
    let sheet = getSheetSafely(ss, sheetName);

    const headers = [
      'Request ID',
      'Request Timestamp',
      'Plant',
      'Shift Type',
      'Target Date',
      'Register / Utility Name',
      'Existing / Wrong Reading',
      'Proposed / Correct Reading',
      'Adjustment Reason / Note to Admin',
      'Requested By (Staff Name)',
      'Contact Phone / Ext',
      'Status',
      'Admin Remarks / Action Taken',
      'Reviewed By',
      'Review Date'
    ];

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(headers);
      
      // Professional styling for header row
      const headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setBackground('#1E293B');
      headerRange.setFontColor('#FFFFFF');
      headerRange.setFontWeight('bold');
      headerRange.setHorizontalAlignment('center');
      sheet.setFrozenRows(1);
      
      // Auto configure column widths for optimal readability
      sheet.setColumnWidth(1, 140); // Request ID
      sheet.setColumnWidth(2, 160); // Request Timestamp
      sheet.setColumnWidth(3, 110); // Plant
      sheet.setColumnWidth(4, 110); // Shift Type
      sheet.setColumnWidth(5, 120); // Target Date
      sheet.setColumnWidth(6, 220); // Register / Utility Name
      sheet.setColumnWidth(7, 160); // Existing / Wrong Reading
      sheet.setColumnWidth(8, 160); // Proposed / Correct Reading
      sheet.setColumnWidth(9, 280); // Adjustment Reason / Note to Admin
      sheet.setColumnWidth(10, 160); // Requested By (Staff Name)
      sheet.setColumnWidth(11, 150); // Contact Phone / Ext
      sheet.setColumnWidth(12, 130); // Status
      sheet.setColumnWidth(13, 240); // Admin Remarks
      sheet.setColumnWidth(14, 140); // Reviewed By
      sheet.setColumnWidth(15, 120); // Review Date
    }

    const tz = 'Asia/Dhaka';
    const now = new Date();
    const timestampStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const dateCompact = Utilities.formatDate(now, tz, 'yyyyMMdd');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const requestId = 'REQ-' + dateCompact + '-' + randomSuffix;

    const plant = payload.plant || 'Unknown';
    const shiftType = payload.shiftType || (payload.isOvertime ? 'Overtime' : 'Regular');
    const targetDate = payload.targetDate || payload.entryDate || Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const register = payload.register || payload.registerName || 'General / All Registers';
    const wrongVal = payload.wrongValue !== undefined && payload.wrongValue !== null ? String(payload.wrongValue).trim() : (payload.existingReading || '');
    const correctVal = payload.correctValue !== undefined && payload.correctValue !== null ? String(payload.correctValue).trim() : (payload.proposedReading || '');
    const reason = payload.reason || payload.comment || 'Correction requested by plant operator.';
    const staffName = payload.staffName || payload.requesterName || 'Plant Operator';
    const phone = payload.phone || payload.contact || 'N/A';
    const status = 'Pending Review';

    sheet.appendRow([
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
      '', // Admin Remarks
      '', // Reviewed By
      ''  // Review Date
    ]);

    // Format new row status tag
    const newRowNum = sheet.getLastRow();
    const statusCell = sheet.getRange(newRowNum, 12);
    statusCell.setBackground('#FEF3C7');
    statusCell.setFontColor('#92400E');
    statusCell.setFontWeight('bold');

    // Also record event to central audit Logs sheet
    logActivity({
      plant: plant,
      entryDate: targetDate,
      action: 'Adjustment Request Submitted',
      details: `[${requestId}] Plant: ${plant} | Register: ${register} | Wrong: ${wrongVal || 'N/A'} | Correct: ${correctVal || 'N/A'} | Reason: ${reason} | By: ${staffName} (${phone})`,
      records: 0
    });

    return {
      success: true,
      requestId: requestId,
      timestamp: timestampStr,
      message: `Adjustment request [${requestId}] has been successfully saved to the "Adjustment/Correction Record" sheet. Central Engineering Admin will review and contact you.`
    };
  } catch (err) {
    console.error('Error submitting adjustment request:', err);
    return {
      success: false,
      message: 'Failed to record adjustment request: ' + err.message
    };
  }
}

/* =====================================================
   SUBMIT USER COMMENT / EDIT REQUEST TO ADMIN (BACKWARD COMPATIBLE)
   ===================================================== */
function submitAdminComment(commentData) {
  const res = submitAdjustmentRequest(commentData);
  return res.message || 'Your adjustment request has been recorded in the Adjustment/Correction Record sheet.';
}

/* =====================================================
   HELPER: SAFE SHEET RETRIEVAL (Tolerates extra spaces/casing)
   ===================================================== */
function getSheetSafely(ss, targetName) {
  if (!targetName) return null;
  let sheet = ss.getSheetByName(targetName);
  if (sheet) return sheet;
  
  const targetClean = targetName.trim().toLowerCase();
  const allSheets = ss.getSheets();
  for (let i = 0; i < allSheets.length; i++) {
    if (allSheets[i].getName().trim().toLowerCase() === targetClean) {
      return allSheets[i];
    }
  }
  return null;
}

/* =====================================================
   FETCH DASHBOARD DATA:
   1. Actual Consumption Records from Plant Sheets + Overtime
   2. Allocated Budget Records from "01_Records"
   ===================================================== */
function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  const actualRecords = [];

  const plantSheetMap = {
    'CIPL': 'CIPL-Data Sheet',
    'EGMCL 1': 'EGMCL 1 -Data Sheet',
    'EGMCL 7': 'EGMCL 7 -Data Sheet',
    'GTL': 'GTL -Data Sheet',
    'PGCL': 'PGCL -Data Sheet',
    'EGMCL 2': 'EGMCL 2 -Data Sheet ' 
  };

  // 1. Gather actual records from each plant's data sheet
  for (const plant in plantSheetMap) {
    const sheetName = plantSheetMap[plant];
    const sheet = getSheetSafely(ss, sheetName);
    if (!sheet) continue;

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) continue;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let rowDate = row[0];
      if (!rowDate || String(rowDate).trim() === '') continue;

      if (rowDate instanceof Date) {
        rowDate = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
      } else {
        try {
          const parsed = new Date(rowDate);
          if (!isNaN(parsed.getTime())) {
            rowDate = Utilities.formatDate(parsed, tz, 'yyyy-MM-dd');
          }
        } catch(e) {}
      }

      actualRecords.push({
        date: rowDate,
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
  }

  // 2. Also check Overtime sheet for actual overtime records
  const otSheet = getSheetSafely(ss, 'Overtime');
  if (otSheet) {
    const otData = otSheet.getDataRange().getValues();
    if (otData.length > 1) {
      for (let i = 1; i < otData.length; i++) {
        const row = otData[i];
        let rowDate = row[0];
        if (!rowDate || String(rowDate).trim() === '') continue;
        if (rowDate instanceof Date) {
          rowDate = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
        }
        actualRecords.push({
          date: rowDate,
          plant: row[3] ? String(row[3]).trim() : 'Unknown',
          section: row[4] ? String(row[4]).trim() : '',
          utility: row[5] ? String(row[5]).trim() : '',
          source: row[6] ? String(row[6]).trim() : '',
          equip: row[7] ? String(row[7]).trim() : '',
          unit: row[8] ? String(row[8]).trim() : '',
          kwh: parseFloat(row[12]) || 0,
          m3: parseFloat(row[13]) || 0,
          ltr: parseFloat(row[14]) || 0,
          kg: parseFloat(row[15]) || 0,
          cost: parseFloat(row[18]) || 0,
          isOvertime: true
        });
      }
    }
  }

  // 3. Fetch Allocated Budget records from "01_Records"
  const budgetRecords = [];
  const bSheet = getSheetSafely(ss, '01_Records');
  if (bSheet) {
    const bData = bSheet.getDataRange().getValues();
    if (bData.length > 1) {
      const months = ['Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27', 'Apr-27', 'May-27', 'Jun-27'];
      for (let i = 1; i < bData.length; i++) {
        const row = bData[i];
        if (!row[0] || String(row[0]).trim() === '') continue;

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
    }
  }

  return {
    records: actualRecords,
    budgetRecords: budgetRecords,
    plants: ['CIPL', 'EGMCL 1', 'EGMCL 2', 'PGCL', 'EGMCL 7', 'GTL']
  };
}