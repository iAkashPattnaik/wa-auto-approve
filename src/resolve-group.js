'use strict';

/** Helper: list all groups the logged-in number participates in. Prints name -> JID. */
require('dotenv').config();
const { connectOnce } = require('./whatsapp');

(async () => {
  console.log('Connecting to WhatsApp (scan QR if first time)...');
  const { sock, loggedOut } = await connectOnce();
  if (loggedOut) {
    console.error('Logged out. Delete ./auth_state/ and retry.');
    process.exit(2);
  }
  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups).map((g) => ({
    subject: g.subject,
    id: g.id,
    size: g.size,
    approval: g.joinApprovalMode ?? g.approvalMode ?? 'unknown',
  }));
  console.log(`\nFound ${list.length} group(s):\n`);
  for (const g of list) {
    console.log(`- "${g.subject}"  size=${g.size}  approval=${g.approval}\n  ${g.id}\n`);
  }
  console.log('Copy the target group id into .env as GROUP_JID.');
  process.exit(0);
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
