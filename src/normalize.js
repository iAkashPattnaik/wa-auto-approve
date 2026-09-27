'use strict';

/**
 * Normalize phone numbers so mixed sheet formats match WhatsApp JIDs.
 *
 * Sheet examples: "+91 98765 43210", "09876543210", "919876543210",
 *   "98765-43210", "+91-9876543210"
 * JID examples: "919876543210@s.whatsapp.net", "919876543210:12@s.whatsapp.net"
 */

function digitsOnly(input) {
  return String(input == null ? '' : input).replace(/\D/g, '');
}

/**
 * Normalize any phone-ish string to E.164 digits without '+'.
 * Returns null if unusable.
 */
function normalizePhone(raw, defaultCountryCode = '91') {
  let d = digitsOnly(raw);
  if (!d) return null;

  // International prefix 00 -> drop it, e.g. 0091... -> 91...
  if (d.length > 10 && d.startsWith('00')) {
    d = d.slice(2);
  }

  // Strip trunk-zero(s): 09876543210 -> 9876543210 (only when longer than 10)
  while (d.length > 10 && d.startsWith('0')) {
    d = d.slice(1);
  }

  // Bare 10-digit national number -> prepend default country code
  if (d.length === 10) {
    d = `${defaultCountryCode}${d}`;
  }

  // E.164 is max 15 digits; require at least 10 to avoid junk matches
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/** Extract phone from a WhatsApp JID, e.g. "9198...@s.whatsapp.net" -> "9198..." */
function jidToPhone(jid) {
  if (!jid) return null;
  const bare = String(jid).split('@')[0].split(':')[0];
  return bare || null;
}

function jidToNormalized(jid, defaultCountryCode = '91') {
  const phone = jidToPhone(jid);
  if (!phone) return null;
  // JIDs already carry full country code, but run through normalizer anyway
  return normalizePhone(phone, defaultCountryCode);
}

function last10(normalized) {
  if (!normalized) return null;
  const d = digitsOnly(normalized);
  if (d.length < 10) return null;
  return d.slice(-10);
}

module.exports = { digitsOnly, normalizePhone, jidToPhone, jidToNormalized, last10 };
