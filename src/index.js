'use strict';

/**
 * wa-auto-approve daemon
 * Polls WhatsApp group join requests, approves numbers present in Google Sheet,
 * marks `in_grp = YES` for matched rows. Non-matches are left pending.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const {
  connectOnce,
  resolveGroupJid,
  getPendingRequests,
  buildLidMap,
  approveWithDelay,
  isLidJid,
  bareJid,
  sleep,
} = require('./whatsapp');
const { loadSheetMap, lookupNumber, markApproved } = require('./sheets');
const { jidToNormalized, normalizePhone, digitsOnly } = require('./normalize');

const cfg = {
  groupJid: (process.env.GROUP_JID || '').trim(),
  groupName: (process.env.GROUP_NAME || '').trim(),
  spreadsheetId: (process.env.SPREADSHEET_ID || '').trim(),
  tab: process.env.SHEET_TAB || 'Technical',
  phoneCol: process.env.PHONE_COL || 'Phone Number',
  statusCol: process.env.STATUS_COL || 'in_grp',
  credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
  defaultCc: process.env.DEFAULT_COUNTRY_CODE || '91',
  pollMs: Number(process.env.POLL_INTERVAL_MS || 90000),
  approveDelayMs: Number(process.env.APPROVE_DELAY_MS || 2500),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
  lidCacheTtlMin: Number(process.env.LID_CACHE_TTL_MIN || 30),
};

const LOG_FILE = path.join(__dirname, '..', 'approval.log');

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

// Console gets colors (yellow/red/green); log file always gets plain text.
function log(line, colorFn) {
  const ts = new Date().toISOString();
  const plain = stripAnsi(line);
  console.log(chalk.gray(`[${ts}]`) + ' ' + (colorFn ? colorFn(plain) : plain));
  try {
    fs.appendFileSync(LOG_FILE, `[${ts}] ${plain}\n`);
  } catch { /* log file optional */ }
}

// LID -> phone reverse map, cached (WhatsApp LIDs are stable; sheet rarely changes).
let lidCache = { at: 0, key: '', map: new Map() };

async function getLidMap(sock, sheet) {
  const key = `${sheet.rowCount}:${sheet.usable}`;
  const ttlMs = cfg.lidCacheTtlMin * 60 * 1000;
  if (lidCache.map.size && lidCache.key === key && Date.now() - lidCache.at < ttlMs) {
    log(`Using cached LID map (${lidCache.map.size} entries).`);
    return lidCache.map;
  }
  const phones = [...sheet.byFull.keys()];
  const map = await buildLidMap(sock, phones, {
    chunkSize: 50,
    delayMs: 800,
    onProgress: ({ done, total, error }) => {
      if (error) log(`LID lookup chunk failed (${done}/${total}): ${error}`, chalk.yellow);
    },
  });
  lidCache = { at: Date.now(), key, map };
  log(`LID map ready: ${map.size}/${phones.length} sheet numbers resolved.`);
  return map;
}

/** Resolve a pending request to a real phone number. Never treats a LID as a phone. */
function resolvePendingPhone(req, lidMap) {
  const { jid, attrs } = req;
  if (!isLidJid(jid)) {
    const norm = jidToNormalized(jid, cfg.defaultCc);
    return { phone: norm ? `+${norm}` : bareJid(jid), normalized: norm, via: 'direct' };
  }
  // @lid path: prefer server-provided phone attr, else reverse LID map
  const rawPn = attrs.phone_number || attrs.phoneNumber || attrs.pn || null;
  if (rawPn) {
    const norm = normalizePhone(rawPn, cfg.defaultCc);
    if (norm) return { phone: `+${norm}`, normalized: norm, via: 'server-attr' };
  }
  const mapped = lidMap.get(bareJid(jid));
  if (mapped) {
    const norm = normalizePhone(mapped, cfg.defaultCc);
    if (norm) return { phone: `+${norm}`, normalized: norm, via: 'lid-map' };
  }
  return { phone: null, normalized: null, via: null };
}

function validateConfig() {
  const missing = [];
  if (!cfg.spreadsheetId) missing.push('SPREADSHEET_ID');
  if (!cfg.groupJid && !cfg.groupName) missing.push('GROUP_JID (or GROUP_NAME)');
  if (!fs.existsSync(cfg.credentialsPath)) {
    missing.push(`credentials file not found at ${cfg.credentialsPath} (set GOOGLE_CREDENTIALS_PATH)`);
  }
  if (missing.length) {
    console.error('\nMissing config:\n - ' + missing.join('\n - '));
    console.error('\nCopy .env.example to .env and fill values. Then: npm start\n');
    process.exit(1);
  }
  if (cfg.pollMs < 30000) console.warn(chalk.yellow('Warning: POLL_INTERVAL_MS < 30s risks rate limits.'));
  if (cfg.approveDelayMs < 2000) console.warn(chalk.yellow('Warning: APPROVE_DELAY_MS < 2000ms risks rate limits.'));
}

async function pollOnce(sock, groupJid) {
  log('━━━ New poll ━━━');

  // Phase 1: fetch ALL pending requests first
  log('① Fetching all join requests...', chalk.yellow);
  let pending;
  try {
    pending = await getPendingRequests(sock, groupJid);
  } catch (e) {
    log(`WhatsApp fetch failed: ${e.message}`, chalk.red);
    return;
  }
  if (!pending.length) {
    log('No pending requests. ✅', chalk.green);
    return;
  }
  log(`Found ${pending.length} pending request(s).`, chalk.yellow);

  // Phase 2: load sheet
  log(`② Loading sheet "${cfg.tab}"...`, chalk.yellow);
  let sheet;
  try {
    sheet = await loadSheetMap({
      spreadsheetId: cfg.spreadsheetId,
      tab: cfg.tab,
      phoneCol: cfg.phoneCol,
      statusCol: cfg.statusCol,
      defaultCountryCode: cfg.defaultCc,
      credentialsPath: cfg.credentialsPath,
    });
  } catch (e) {
    log(`Sheet load failed: ${e.message}`, chalk.red);
    return;
  }
  log(`Sheet: ${sheet.usable}/${sheet.rowCount} usable phones` +
    (sheet.duplicates.length ? `, ${sheet.duplicates.length} duplicate(s) (first kept).` : '.'));

  // Phase 3: resolve @lid IDs to real phone numbers (reverse lookup)
  let lidMap = new Map();
  const needsLid = pending.some((r) => isLidJid(r.jid));
  if (needsLid) {
    log('③ Resolving @lid IDs to phone numbers...', chalk.yellow);
    try {
      lidMap = await getLidMap(sock, sheet);
    } catch (e) {
      log(`LID resolution failed: ${e.message}. @lid requests will be left pending.`, chalk.red);
    }
  }

  // Phase 4: check each request against the sheet
  log('④ Checking each request against sheet...', chalk.yellow);
  const toApprove = []; // { jid, phone, rowNumber, via }
  let notInSheet = 0;
  let alreadyYes = 0;
  let unresolved = 0;

  pending.forEach((req, idx) => {
    const tag = `[${idx + 1}/${pending.length}]`;
    const { phone, normalized, via } = resolvePendingPhone(req, lidMap);
    const who = `${phone || 'phone unknown'}  (${req.jid})`;
    if (!normalized) {
      unresolved++;
      log(`${tag} ${who} → UNRESOLVED, left pending`, chalk.yellow);
      return;
    }
    const { hit, via: matchVia } = lookupNumber(sheet, normalized, digitsOnly(normalized));
    if (!hit) {
      notInSheet++;
      log(`${tag} ${who} → NOT IN SHEET, left pending`, chalk.red);
      return;
    }
    if (hit.status === 'YES') {
      alreadyYes++;
      log(`${tag} ${who} → sheet row ${hit.rowNumber} already YES, skipped`, chalk.yellow);
      return;
    }
    toApprove.push({ jid: req.jid, phone, rowNumber: hit.rowNumber, via: `${via}+${matchVia}` });
    log(`${tag} ${who} → MATCH row ${hit.rowNumber} (${via}), queued`, chalk.green);
  });

  log(
    `Summary: pending=${pending.length} matched=${toApprove.length} ` +
    `alreadyYES=${alreadyYes} notInSheet=${notInSheet} unresolved=${unresolved}`,
    toApprove.length ? chalk.green : chalk.yellow
  );

  if (!toApprove.length) return;

  if (cfg.dryRun) {
    for (const t of toApprove) {
      log(`DRY-RUN would approve ${t.phone} (${t.jid}) → row ${t.rowNumber}`, chalk.yellow);
    }
    return;
  }

  // Phase 5: approve + mark sheet
  log(`⑤ Approving ${toApprove.length}...`, chalk.green);
  const phoneByJid = new Map(toApprove.map((t) => [t.jid, t.phone]));
  const results = await approveWithDelay(
    sock, groupJid, toApprove.map((t) => t.jid), cfg.approveDelayMs, { dryRun: false }
  );
  const okJids = new Set(results.filter((r) => r.ok).map((r) => r.jid));
  for (const r of results) {
    const who = `${phoneByJid.get(r.jid) || '?'} (${r.jid})`;
    log(r.ok ? `APPROVED ${who}` : `FAILED ${who}: ${r.error}`, r.ok ? chalk.green : chalk.red);
  }
  const rowsOk = toApprove.filter((t) => okJids.has(t.jid)).map((t) => t.rowNumber);
  if (rowsOk.length) {
    const { updated } = await markApproved({
      spreadsheetId: cfg.spreadsheetId,
      tab: cfg.tab,
      statusColIdx: sheet.statusColIdx,
      rowNumbers: rowsOk,
      credentialsPath: cfg.credentialsPath,
    });
    log(`Sheet updated: ${updated} row(s) set to YES.`, chalk.green);
  }
}

async function run() {
  validateConfig();
  log(`Starting. DRY_RUN=${cfg.dryRun} tab="${cfg.tab}" poll=${cfg.pollMs}ms`, chalk.yellow);
  log('Login persists in ./auth_state/. First run will print a QR to scan.');

  // Outer reconnect loop
  for (;;) {
    let sock;
    try {
      const { sock: s, loggedOut } = await connectOnce();
      if (loggedOut) {
        log('Logged out from WhatsApp. Delete ./auth_state/ and restart to re-scan. Exiting.');
        process.exit(2);
      }
      sock = s;
    } catch (e) {
      log(`WhatsApp connect failed: ${e.message}. Retrying in 15s...`);
      await sleep(15000);
      continue;
    }

    let groupJid;
    try {
      groupJid = await resolveGroupJid(sock, { groupJid: cfg.groupJid, groupName: cfg.groupName });
      log(`Connected. Group: ${groupJid}`, chalk.green);
    } catch (e) {
      log(e.message, chalk.red);
      log('Fix GROUP_JID (hint: npm run resolve-group) then restart.', chalk.yellow);
      process.exit(1);
    }

    // Connection watcher -> break inner loop on close so outer reconnects
    let connClosed = false;
    let loggedOut = false;
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'close') {
        connClosed = true;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        loggedOut = code === DisconnectReason.loggedOut;
      }
    });

    for (;;) {
      if (connClosed) {
        if (loggedOut) {
          log('Logged out. Delete ./auth_state/ and restart. Exiting.');
          process.exit(2);
        }
        log('Connection lost. Reconnecting in 10s...');
        try { sock.end?.(); } catch { /* noop */ }
        await sleep(10000);
        break; // -> outer reconnect
      }
      try {
        await pollOnce(sock, groupJid);
      } catch (e) {
        log(`Cycle error: ${e.message}`, chalk.red);
      }
      await sleep(cfg.pollMs);
    }
  }
}

process.on('SIGINT', () => {
  log('Interrupted (SIGINT). Bye.');
  process.exit(0);
});

run().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
