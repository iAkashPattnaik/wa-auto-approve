'use strict';

/**
 * send-msg — bulk WhatsApp sender for rows NOT yet in the group.
 *
 * Source of truth: Google Sheet tab.
 *   Eligible  = in_grp is NOT "YES" (empty, NO, anything else).
 *   NEVER sends to a row whose in_grp is "YES" — checked twice:
 *     1) at list-building time, 2) fresh re-check just before sending
 *     (guards against the auto-approve daemon marking YES in between).
 *
 * Flow:
 *   1. Load message template (file or env).
 *   2. Load sheet, build eligible list (skips YES + already-sent unless --resend).
 *   3. Ask on stdin how many to send (or --limit N).
 *   4. Confirm, connect WhatsApp, re-verify statuses, send with delay.
 *   5. Mark `sent_msg` = TRUE only for delivered messages.
 *
 * Usage:
 *   node src/send-msg.js [--limit 20] [--message ./message.txt] [--resend] [--yes]
 *
 * Env (.env):
 *   SPREADSHEET_ID, SHEET_TAB, PHONE_COL, STATUS_COL,
 *   SENT_MSG_COL (default "sent_msg"), SENT_MSG_VALUE (default "TRUE"),
 *   GOOGLE_CREDENTIALS_PATH, DEFAULT_COUNTRY_CODE,
 *   MESSAGE_FILE (default "./message.txt"), MSG_TEXT (inline fallback),
 *   MSG_DELAY_MS (default 3500), DRY_RUN (true = log only)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');
const { connectOnce, sleep, bareJid } = require('./whatsapp');
const { normalizePhone } = require('./normalize');
const {
  getSheetGrid,
  ensureColumn,
  findHeaderIndex,
  markColumn,
} = require('./sheets');

const ROOT = path.join(__dirname, '..');

const cfg = {
  spreadsheetId: (process.env.SPREADSHEET_ID || '').trim(),
  tab: process.env.SHEET_TAB || 'Technical',
  phoneCol: process.env.PHONE_COL || 'Phone Number',
  statusCol: process.env.STATUS_COL || 'in_grp',
  sentCol: process.env.SENT_MSG_COL || 'sent_msg',
  sentValue: process.env.SENT_MSG_VALUE || 'TRUE',
  credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
  defaultCc: process.env.DEFAULT_COUNTRY_CODE || '91',
  messageFile: process.env.MESSAGE_FILE || './message.txt',
  msgText: process.env.MSG_TEXT || '',
  delayMs: Number(process.env.MSG_DELAY_MS || 3500),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
};

const LOG_FILE = path.join(ROOT, 'send-msg.log');

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

function log(line, colorFn) {
  const ts = new Date().toISOString();
  const plain = stripAnsi(line);
  console.log(chalk.gray(`[${ts}]`) + ' ' + (colorFn ? colorFn(plain) : plain));
  try {
    fs.appendFileSync(LOG_FILE, `[${ts}] ${plain}\n`);
  } catch { /* log file optional */ }
}

function parseArgs(argv) {
  const out = { limit: null, message: null, resend: false, yes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1] != null) out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.split('=')[1]);
    else if (a === '--message' && argv[i + 1] != null) out.message = argv[++i];
    else if (a.startsWith('--message=')) out.message = a.slice('--message='.length);
    else if (a === '--resend') out.resend = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function resolvePath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function loadMessage(cliPath) {
  const candidates = [cliPath, cfg.messageFile].filter(Boolean);
  for (const c of candidates) {
    const abs = resolvePath(c);
    if (abs && fs.existsSync(abs)) {
      const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').trim();
      if (text) return { text, source: abs };
    }
  }
  if (cfg.msgText && cfg.msgText.trim()) return { text: cfg.msgText.trim(), source: 'MSG_TEXT env' };
  return { text: '', source: null };
}

/** Replace {{Header Name}} tokens with the row's cell values (case-insensitive). */
function renderTemplate(template, headers, row) {
  const map = new Map();
  headers.forEach((h, i) => {
    map.set(String(h).trim().toLowerCase(), row[i] == null ? '' : String(row[i]));
  });
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, name) => {
    const v = map.get(String(name).trim().toLowerCase());
    return v == null ? m : v;
  });
}

const isYes = (v) => String(v == null ? '' : v).trim().toUpperCase() === 'YES';
const isSent = (v) => ['TRUE', 'YES', '1', 'SENT', 'DONE'].includes(String(v == null ? '' : v).trim().toUpperCase());

function buildEligible(values, headers, phoneIdx, statusIdx, sentIdx) {
  const eligible = [];
  const seenPhone = new Map(); // norm -> rowNumber (dedupe: one message per person)
  const duplicateRows = [];
  let alreadyYes = 0;
  let alreadySent = 0;
  let invalid = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowNumber = i + 1;
    const raw = row[phoneIdx];

    // HARD RULE: never queue a YES row — check first, before anything else.
    if (isYes(row[statusIdx])) {
      alreadyYes++;
      continue;
    }

    if (raw == null || String(raw).trim() === '') {
      invalid++;
      continue;
    }
    const norm = normalizePhone(raw, cfg.defaultCc);
    if (!norm) {
      invalid++;
      continue;
    }
    if (!args.resend && isSent(row[sentIdx])) {
      alreadySent++;
      continue;
    }
    if (seenPhone.has(norm)) {
      duplicateRows.push({ normalized: norm, rowNumber, keptRow: seenPhone.get(norm) });
      continue;
    }
    seenPhone.set(norm, rowNumber);
    eligible.push({ rowNumber, norm, raw: String(raw).trim(), row: [...row] });
  }
  return { eligible, alreadyYes, alreadySent, invalid, duplicateRows };
}

const args = parseArgs(process.argv);

async function main() {
  if (args.help) {
    console.log(`
send-msg — message sheet rows where in_grp is NOT YES.

Usage: node src/send-msg.js [--limit N] [--message ./message.txt] [--resend] [--yes]

  --limit N     Send at most N (else asks on stdin).
  --message P   Message template file (else MESSAGE_FILE / MSG_TEXT env).
  --resend      Include rows already marked sent (default: skip them).
  --yes, -y     Skip the final confirmation prompt.

Safety: rows with in_grp=YES are NEVER messaged (double-checked before send).
`);
    process.exit(0);
  }

  if (!cfg.spreadsheetId) {
    console.error('Missing SPREADSHEET_ID in .env. Copy .env.example to .env first.');
    process.exit(1);
  }
  if (!fs.existsSync(cfg.credentialsPath)) {
    console.error(`Credentials file not found at ${cfg.credentialsPath} (GOOGLE_CREDENTIALS_PATH).`);
    process.exit(1);
  }

  // 1. Message template
  const { text: message, source } = loadMessage(args.message);
  if (!message) {
    console.error(
      `No message text found. Create ${cfg.messageFile} (or pass --message <file>) ` +
      `or set MSG_TEXT in .env, then retry.`
    );
    process.exit(1);
  }
  log(`Message loaded from ${source} (${message.length} chars). DRY_RUN=${cfg.dryRun}`, chalk.yellow);
  console.log(chalk.cyan('─'.repeat(50)));
  console.log(message.slice(0, 800) + (message.length > 800 ? '\n…(truncated preview)' : ''));
  console.log(chalk.cyan('─'.repeat(50)));

  // 2. Sheet
  log(`Loading sheet "${cfg.tab}"...`, chalk.yellow);
  const { values } = await getSheetGrid({
    spreadsheetId: cfg.spreadsheetId,
    tab: cfg.tab,
    credentialsPath: cfg.credentialsPath,
  });
  let headers = values[0];
  const phoneIdx = findHeaderIndex(headers, cfg.phoneCol);
  const statusIdx = findHeaderIndex(headers, cfg.statusCol);
  if (phoneIdx === -1) {
    console.error(`Column "${cfg.phoneCol}" not found. Headers: [${headers.join(' | ')}]`);
    process.exit(1);
  }
  if (statusIdx === -1) {
    console.error(`Column "${cfg.statusCol}" not found. Headers: [${headers.join(' | ')}]`);
    process.exit(1);
  }
  const ensured = await ensureColumn({
    spreadsheetId: cfg.spreadsheetId,
    tab: cfg.tab,
    headers,
    wanted: cfg.sentCol,
    credentialsPath: cfg.credentialsPath,
  });
  headers = ensured.headers;
  if (ensured.created) log(`Column "${cfg.sentCol}" did not exist — created it.`, chalk.green);
  const sentIdx = ensured.colIdx;

  const { eligible, alreadyYes, alreadySent, invalid, duplicateRows } = buildEligible(
    values, headers, phoneIdx, statusIdx, sentIdx
  );
  log(
    `Sheet rows=${values.length - 1} eligible=${eligible.length} ` +
    `skippedYES=${alreadyYes} skippedSent=${alreadySent} invalid=${invalid}` +
    (duplicateRows.length ? ` dupPhones=${duplicateRows.length}` : ''),
    eligible.length ? chalk.green : chalk.yellow
  );
  if (!eligible.length) {
    log('Nothing to send. ✅');
    process.exit(0);
  }

  // 3. How many? (stdin — the requested input)
  let limit = args.limit;
  if (limit == null || Number.isNaN(limit)) {
    const ans = await ask(
      `\nHow many messages to send? (eligible ${eligible.length}, 0/Enter = all): `
    );
    const t = String(ans).trim();
    limit = t === '' || t === '0' ? eligible.length : Number(t);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    log('Cancelled (non-positive count).');
    process.exit(0);
  }
  limit = Math.min(Math.floor(limit), eligible.length);
  const batch = eligible.slice(0, limit);
  log(`Selected ${batch.length} recipient(s).`, chalk.green);

  if (!args.yes) {
    const confirm = await ask(
      `Send the above message to ${batch.length} people? ` +
      (cfg.dryRun ? '(DRY-RUN, nothing will send) ' : '(LIVE send!) ') +
      `Type YES to proceed: `
    );
    if (String(confirm).trim().toUpperCase() !== 'YES') {
      log('Aborted by user.');
      process.exit(0);
    }
  }

  if (cfg.delayMs < 2000) {
    log('Warning: MSG_DELAY_MS < 2000ms risks a WhatsApp ban. Consider >= 3000.', chalk.yellow);
  }

  if (cfg.dryRun) {
    for (const b of batch) log(`DRY-RUN would message +${b.norm} (row ${b.rowNumber})`, chalk.yellow);
    log(`DRY-RUN would mark "${cfg.sentCol}"=${cfg.sentValue} on ${batch.length} row(s). Sheet untouched.`, chalk.yellow);
    process.exit(0);
  }

  // 4. Connect WhatsApp
  log('Connecting to WhatsApp (scan QR if first time)...');
  const { sock, loggedOut } = await connectOnce();
  if (loggedOut) {
    console.error('Logged out. Delete ./auth_state/ and retry.');
    process.exit(2);
  }

  // 5. FRESH re-check: re-fetch statuses so a row that flipped to YES is NEVER messaged.
  log('Re-checking in_grp statuses fresh before sending (NEVER-YES guard)...', chalk.yellow);
  const fresh = await getSheetGrid({
    spreadsheetId: cfg.spreadsheetId,
    tab: cfg.tab,
    credentialsPath: cfg.credentialsPath,
  });
  const fStatusIdx = findHeaderIndex(fresh.headers, cfg.statusCol);
  const fPhoneIdx = findHeaderIndex(fresh.headers, cfg.phoneCol);
  const byRow = new Map();
  for (let i = 1; i < fresh.values.length; i++) byRow.set(i + 1, fresh.values[i]);

  const toSend = [];
  let flippedYes = 0;
  for (const b of batch) {
    const fRow = byRow.get(b.rowNumber);
    if (!fRow) continue; // row deleted → skip
    // Match by phone too: if the row now holds a different number, skip (sheet shifted).
    const fNorm = normalizePhone(fRow[fPhoneIdx], cfg.defaultCc);
    if (fNorm !== b.norm || isYes(fRow[fStatusIdx])) {
      flippedYes++;
      log(`SKIP row ${b.rowNumber} (+${b.norm}): now YES/changed — NEVER messaging.`, chalk.red);
      continue;
    }
    toSend.push({ ...b, row: [...fRow], headers: [...fresh.headers] });
  }
  log(`Guard result: sending=${toSend.length} blocked=${flippedYes}`, toSend.length ? chalk.green : chalk.yellow);
  if (!toSend.length) {
    try { sock.end?.(); } catch { /* noop */ }
    process.exit(0);
  }

  // 6. Optional: verify numbers exist on WhatsApp (skip landlines / invalid).
  let existence = null;
  if (typeof sock.onWhatsApp === 'function') {
    try {
      const res = await sock.onWhatsApp(...toSend.map((t) => `${t.norm}@s.whatsapp.net`));
      existence = new Map((res || []).map((r) => [bareJid(r.jid), !!r.exists]));
    } catch (e) {
      log(`onWhatsApp check failed (${e.message}) — proceeding anyway.`, chalk.yellow);
    }
  }

  // 7. Send loop
  log(`Sending ${toSend.length} message(s), ~${cfg.delayMs}ms apart...`, chalk.green);
  const okRows = [];
  let failed = 0;
  let skippedNoWA = 0;
  for (let i = 0; i < toSend.length; i++) {
    const t = toSend[i];
    const tag = `[${i + 1}/${toSend.length}]`;
    if (existence && existence.get(t.norm) === false) {
      skippedNoWA++;
      log(`${tag} +${t.norm} (row ${t.rowNumber}) → not on WhatsApp, skipped`, chalk.yellow);
      continue;
    }
    // Last-moment guard (paranoia, cheap): never send if YES.
    const cur = byRow.get(t.rowNumber);
    if (cur && isYes(cur[fStatusIdx])) {
      log(`${tag} +${t.norm} → flipped YES mid-run, skipped`, chalk.red);
      continue;
    }
    const text = renderTemplate(message, t.headers, t.row);
    const jid = `${t.norm}@s.whatsapp.net`;
    try {
      await sock.sendMessage(jid, { text });
      okRows.push(t.rowNumber);
      log(`${tag} SENT +${t.norm} (row ${t.rowNumber})`, chalk.green);
    } catch (e) {
      failed++;
      log(`${tag} FAILED +${t.norm} (row ${t.rowNumber}): ${e.message}`, chalk.red);
    }
    if (i + 1 < toSend.length) await sleep(cfg.delayMs + Math.floor(Math.random() * 1000));
  }

  // 8. Mark sent_msg=TRUE only for delivered messages (single source of truth update).
  if (okRows.length) {
    const { updated } = await markColumn({
      spreadsheetId: cfg.spreadsheetId,
      tab: cfg.tab,
      colIdx: sentIdx,
      rowNumbers: okRows,
      value: cfg.sentValue,
      credentialsPath: cfg.credentialsPath,
    });
    log(`Sheet updated: ${updated} row(s) set ${cfg.sentCol}=${cfg.sentValue}.`, chalk.green);
  }
  log(`Done: sent=${okRows.length} failed=${failed} notOnWA=${skippedNoWA} blockedYES=${flippedYes}.`);
  try { sock.end?.(); } catch { /* noop */ }
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
