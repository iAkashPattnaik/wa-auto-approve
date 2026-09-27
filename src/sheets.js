'use strict';

const { google } = require('googleapis');
const { normalizePhone, last10, digitsOnly } = require('./normalize');

let cachedAuth = null;

function getAuth(credentialsPath) {
  if (cachedAuth) return cachedAuth;
  cachedAuth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return cachedAuth;
}

function getSheetsClient(credentialsPath) {
  return google.sheets({ version: 'v4', auth: getAuth(credentialsPath) });
}

function colToLetter(idx0) {
  let n = idx0 + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function findHeaderIndex(headers, wanted) {
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const w = norm(wanted);
  let idx = headers.findIndex((h) => String(h).trim() === String(wanted).trim());
  if (idx !== -1) return idx;
  return headers.findIndex((h) => norm(h) === w);
}

/**
 * Load sheet and build lookup maps.
 * Returns { headers, phoneColIdx, statusColIdx, byFull: Map, byLast10: Map, rowCount, duplicates }
 * byFull: normalizedFull -> { rowNumber, raw, status }
 */
async function loadSheetMap({ spreadsheetId, tab, phoneCol, statusCol, defaultCountryCode, credentialsPath }) {
  const sheets = getSheetsClient(credentialsPath);
  const range = `${tab}!A:Z`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  if (values.length < 2) {
    throw new Error(`Sheet "${tab}" has no data rows (need header + at least 1 row). Range tried: ${range}`);
  }
  const headers = values[0];
  const phoneColIdx = findHeaderIndex(headers, phoneCol);
  const statusColIdx = findHeaderIndex(headers, statusCol);
  if (phoneColIdx === -1) {
    throw new Error(`Column "${phoneCol}" not found. Headers: [${headers.join(' | ')}]`);
  }
  if (statusColIdx === -1) {
    throw new Error(`Column "${statusCol}" not found. Headers: [${headers.join(' | ')}]`);
  }

  const byFull = new Map();
  const byLast10 = new Map();
  const duplicates = [];
  let usable = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowNumber = i + 1; // 1-based incl. header
    const raw = row[phoneColIdx];
    if (raw == null || String(raw).trim() === '') continue;
    const norm = normalizePhone(raw, defaultCountryCode);
    if (!norm) continue;
    usable++;
    const status = String(row[statusColIdx] == null ? '' : row[statusColIdx]).trim().toUpperCase();
    if (!byFull.has(norm)) {
      byFull.set(norm, { rowNumber, raw: String(raw), status });
    } else {
      duplicates.push({ normalized: norm, raw: String(raw), rowNumber });
    }
    const l10 = last10(norm);
    if (l10 && !byLast10.has(l10)) {
      byLast10.set(l10, { normalized: norm, rowNumber, raw: String(raw), status });
    }
  }

  return { headers, phoneColIdx, statusColIdx, byFull, byLast10, rowCount: values.length - 1, usable, duplicates };
}

/** Look up a normalized phone: exact full match first, then last-10 fallback. */
function lookupNumber(sheetMap, normalized, digitsRaw) {
  if (!normalized) return { hit: null, via: null };
  const exact = sheetMap.byFull.get(normalized);
  if (exact) return { hit: exact, via: 'full' };
  const l10 = last10(normalized) || last10(digitsRaw);
  if (l10) {
    const fb = sheetMap.byLast10.get(l10);
    if (fb) return { hit: fb, via: 'last10' };
  }
  return { hit: null, via: null };
}

/** Batch-write YES into the status column for given row numbers. */
async function markApproved({ spreadsheetId, tab, statusColIdx, rowNumbers, statusValue = 'YES', credentialsPath }) {
  return markColumn({ spreadsheetId, tab, colIdx: statusColIdx, rowNumbers, value: statusValue, credentialsPath });
}

/** Generic batch-write of a single value into one column for given 1-based row numbers. */
async function markColumn({ spreadsheetId, tab, colIdx, rowNumbers, value, credentialsPath }) {
  const sheets = getSheetsClient(credentialsPath);
  const col = colToLetter(colIdx);
  const data = [...new Set(rowNumbers)].map((r) => ({
    range: `${tab}!${col}${r}`,
    values: [[value]],
  }));
  if (data.length === 0) return { updated: 0 };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return { updated: data.length };
}

/** Fetch raw grid (header + rows) for a tab. Returns { sheets, values, headers }. */
async function getSheetGrid({ spreadsheetId, tab, credentialsPath }) {
  const sheets = getSheetsClient(credentialsPath);
  const range = `${tab}!A:Z`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  if (values.length < 1) {
    throw new Error(`Sheet "${tab}" is empty. Range tried: ${range}`);
  }
  return { sheets, values, headers: values[0] };
}

/**
 * Ensure a column header exists; if missing, append it to the end of the header row.
 * Returns { headers, colIdx, created }.
 */
async function ensureColumn({ spreadsheetId, tab, headers, wanted, credentialsPath }) {
  let idx = findHeaderIndex(headers, wanted);
  if (idx !== -1) return { headers, colIdx: idx, created: false };
  const sheets = getSheetsClient(credentialsPath);
  const newIdx = headers.length;
  const col = colToLetter(newIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!${col}1`,
    requestBody: { values: [[wanted]] },
    valueInputOption: 'RAW',
  });
  const nextHeaders = [...headers];
  // Fill gaps (if sheet narrower than expected) then push.
  while (nextHeaders.length < newIdx) nextHeaders.push('');
  nextHeaders.push(wanted);
  return { headers: nextHeaders, colIdx: newIdx, created: true };
}

module.exports = { loadSheetMap, lookupNumber, markApproved, markColumn, getSheetGrid, ensureColumn, findHeaderIndex, colToLetter, digitsOnly };
