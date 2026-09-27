'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, '..', 'auth_state');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectOnce({ onQr } = {}) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version = undefined;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch {
    // offline-safe: Baileys falls back to built-in version
  }
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['WA-Auto-Approve', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    const done = { value: false };
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        console.log('\nScan this QR with WhatsApp (Linked devices):\n');
        qrcode.generate(qr, { small: true });
        if (onQr) onQr(qr);
      }
      if (connection === 'open') {
        if (!done.value) {
          done.value = true;
          resolve({ sock, loggedOut: false });
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!done.value) {
          done.value = true;
          if (loggedOut) resolve({ sock, loggedOut: true });
          else reject(new Error(`Connection closed before login (code ${code}). Retry.`));
        } else {
          sock.__closedCode = code;
          sock.__loggedOut = loggedOut;
        }
      }
    });
  });
}

async function resolveGroupJid(sock, { groupJid, groupName }) {
  if (groupJid && groupJid.trim()) return groupJid.trim();
  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups).map((g) => ({ id: g.id, subject: g.subject, size: g.size }));
  if (groupName && groupName.trim()) {
    const found = list.find((g) => g.subject.trim().toLowerCase() === groupName.trim().toLowerCase());
    if (!found) {
      throw new Error(
        `GROUP_NAME "${groupName}" not found. Available: ${list.map((g) => `"${g.subject}" (${g.id})`).join(', ')}`
      );
    }
    return found.id;
  }
  throw new Error(
    `Set GROUP_JID in .env. Your groups: ${list.map((g) => `"${g.subject}" -> ${g.id}`).join(' | ')}`
  );
}

/** True for WhatsApp privacy JIDs like "12345@lid" (no phone digits inside). */
function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

/** "9198...@s.whatsapp.net" -> "9198..."; "12345@lid" -> "12345" */
function bareJid(jid) {
  if (!jid) return null;
  return String(jid).split('@')[0].split(':')[0] || null;
}

/**
 * Fetch pending join requests.
 * Returns [{ jid, attrs }] — attrs is the raw server object, which may
 * already carry a phone_number field. jid is often "@lid" (unresolvable
 * directly), so callers must reverse-resolve via buildLidMap().
 */
async function getPendingRequests(sock, groupJid) {
  if (typeof sock.groupRequestParticipantsList === 'function') {
    const res = await sock.groupRequestParticipantsList(groupJid);
    const arr = Array.isArray(res) ? res : res.requesters || res.participants || res.jids || [];
    return arr
      .map((x) => {
        if (typeof x === 'string') return { jid: x, attrs: { jid: x } };
        const jid = x.jid || x.requester_jid || x.participant || x.id || null;
        return jid ? { jid, attrs: x } : null;
      })
      .filter(Boolean);
  }
  throw new Error(
    'Your Baileys version lacks groupRequestParticipantsList(). Run: npm i @whiskeysockets/baileys@latest'
  );
}

/**
 * Reverse-resolve sheet phone numbers (E.164 digits) to their WhatsApp LIDs
 * via onWhatsApp, which returns { jid, exists, lid }.
 * Returns Map<lidBare, normalizedPhone>. Numbers not on WhatsApp are skipped.
 */
async function buildLidMap(sock, normalizedPhones, { chunkSize = 50, delayMs = 1000, onProgress } = {}) {
  if (typeof sock.onWhatsApp !== 'function') {
    throw new Error('Baileys sock.onWhatsApp() not available. Run: npm i @whiskeysockets/baileys@latest');
  }
  const map = new Map();
  const uniq = [...new Set(normalizedPhones.filter(Boolean))];
  const total = uniq.length;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    try {
      const res = await sock.onWhatsApp(...chunk.map((p) => `${p}@s.whatsapp.net`));
      for (const r of res || []) {
        if (r && r.exists && r.lid) {
          const lidBare = bareJid(r.lid);
          const pnBare = bareJid(r.jid);
          if (lidBare && pnBare) map.set(lidBare, pnBare.replace(/^\+/, ''));
        }
      }
    } catch (e) {
      if (onProgress) onProgress({ done: Math.min(i + chunkSize, total), total, error: e.message });
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }
    if (onProgress) onProgress({ done: Math.min(i + chunkSize, total), total });
    if (delayMs > 0 && i + chunkSize < uniq.length) await sleep(delayMs);
  }
  return map;
}

async function approveOne(sock, groupJid, jid) {
  // Preferred modern API
  if (typeof sock.groupRequestParticipantsUpdate === 'function') {
    return sock.groupRequestParticipantsUpdate(groupJid, [jid], 'approve');
  }
  if (typeof sock.groupApproveRequest === 'function') {
    return sock.groupApproveRequest(groupJid, [jid]);
  }
  // Some forks expose generic participants update for join-requests
  if (typeof sock.groupParticipantsUpdate === 'function') {
    try {
      return await sock.groupParticipantsUpdate(groupJid, [jid], 'approve');
    } catch (e) {
      throw new Error(`No approve API available (${e.message}). Update Baileys.`);
    }
  }
  throw new Error('No group-approve API found. Run: npm i @whiskeysockets/baileys@latest');
}

async function approveWithDelay(sock, groupJid, jids, delayMs, { dryRun }) {
  const results = [];
  for (const jid of jids) {
    if (dryRun) {
      results.push({ jid, skipped: true });
      continue;
    }
    try {
      await approveOne(sock, groupJid, jid);
      results.push({ jid, ok: true });
    } catch (e) {
      results.push({ jid, ok: false, error: e.message });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return results;
}

module.exports = {
  connectOnce,
  resolveGroupJid,
  getPendingRequests,
  buildLidMap,
  approveWithDelay,
  isLidJid,
  bareJid,
  sleep,
};
