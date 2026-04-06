// Email service — ported from functions/src/email.ts
// Removed Firebase logger, uses console.log. Fixed XSS with escapeHtml.

import sgMail from '@sendgrid/mail';
import { escapeHtml } from './helpers.js';

let sgInitialised = false;

function getSgMail() {
  if (!sgInitialised) {
    const key = process.env.SENDGRID_API_KEY;
    if (!key) {
      console.warn('[email] SENDGRID_API_KEY not set — emails will be skipped');
      return sgMail;
    }
    sgMail.setApiKey(key);
    sgInitialised = true;
  }
  return sgMail;
}

const FROM_EMAIL  = () => process.env.FROM_EMAIL  ?? 'noreply@scratchpoker.com';
const FROM_NAME   = () => process.env.FROM_NAME   ?? 'ScratchPoker';
const APP_URL     = () => process.env.APP_URL     ?? 'https://scratchpoker.com';
const SUPPORT_URL = () => `${APP_URL()}/support`;

async function sendEmail(msg: sgMail.MailDataRequired): Promise<void> {
  try {
    if (!process.env.SENDGRID_API_KEY) {
      console.info('[email] Skipping send (no API key)', { to: msg.to, subject: msg.subject });
      return;
    }
    await getSgMail().send(msg);
    console.info('[email] Sent', { to: msg.to, subject: msg.subject });
  } catch (err) {
    console.error('[email] Send failed', { error: err, to: msg.to, subject: msg.subject });
  }
}

function wrapHtml(body: string, title: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title>
<style>body{margin:0;padding:0;background:#0a0c0f;font-family:Arial,sans-serif;color:#e6edf3}.wrap{max-width:560px;margin:40px auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}.header{background:linear-gradient(135deg,#1c2128,#0a0c0f);padding:32px;text-align:center;border-bottom:1px solid #30363d}.logo{font-size:40px;margin-bottom:8px}.brand{font-size:24px;font-weight:700;color:#e3b341;letter-spacing:1px}.body{padding:32px}h2{margin:0 0 16px;font-size:20px;color:#e6edf3}p{margin:0 0 16px;font-size:15px;line-height:1.6;color:#8b949e}.code-box{background:#0a0c0f;border:2px solid #e3b341;border-radius:8px;padding:20px;text-align:center;margin:24px 0}.code{font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#e3b341}.code-label{font-size:12px;color:#484f58;margin-top:8px;text-transform:uppercase;letter-spacing:1px}.btn{display:inline-block;background:#58a6ff;color:#000;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;margin:8px 0}.btn-success{background:#3fb950}.btn-danger{background:#f85149;color:#fff}.alert{padding:14px 18px;border-radius:8px;margin:16px 0;font-size:14px}.alert-success{background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);color:#3fb950}.alert-danger{background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#f85149}.alert-info{background:rgba(88,166,255,0.1);border:1px solid rgba(88,166,255,0.3);color:#58a6ff}.divider{height:1px;background:#21262d;margin:24px 0}.footer{padding:20px 32px;text-align:center;font-size:12px;color:#484f58;border-top:1px solid #21262d}.footer a{color:#484f58}</style>
</head><body><div class="wrap"><div class="header"><div class="logo">&#127183;</div><div class="brand">ScratchPoker</div></div><div class="body">${body}</div><div class="footer"><p>&copy; ScratchPoker &middot; <a href="${SUPPORT_URL()}">Support</a></p><p>This is an automated message. Do not reply to this email.</p></div></div></body></html>`;
}

export async function sendClaimCodeEmail(params: {
  toEmail: string; displayName: string; ticketId: string;
  claimCode: string; campaignName: string; scratchLimit: number;
}): Promise<void> {
  const { toEmail, displayName, ticketId, claimCode, campaignName, scratchLimit } = params;
  const body = `<h2>Your Scratch Ticket is Ready!</h2>
<p>Hi ${escapeHtml(displayName)},</p>
<p>Your ticket for <strong>${escapeHtml(campaignName)}</strong> has been issued. Reveal ${scratchLimit} cards to discover your hand and see if you've won.</p>
<div class="alert alert-info"><strong>Important:</strong> Keep your claim code safe. You'll need it to submit a winning claim.</div>
<div class="code-box"><div class="code">${escapeHtml(claimCode)}</div><div class="code-label">Your Claim Code</div></div>
<p>Ticket ID: <code style="color:#58a6ff;font-size:13px">${escapeHtml(ticketId)}</code></p>
<div style="text-align:center;margin-top:24px"><a href="${APP_URL()}/player/tickets/${escapeHtml(ticketId)}" class="btn">Open Your Ticket</a></div>
<div class="divider"></div><p style="font-size:13px">If you did not request this ticket, please contact support immediately.</p>`;

  await sendEmail({
    to: { email: toEmail, name: displayName },
    from: { email: FROM_EMAIL(), name: FROM_NAME() },
    subject: 'Your ScratchPoker ticket is ready',
    html: wrapHtml(body, 'Your Ticket is Ready'),
    text: `Your ScratchPoker ticket has been issued.\n\nClaim Code: ${claimCode}\nTicket ID: ${ticketId}\n\nOpen: ${APP_URL()}/player/tickets/${ticketId}`,
  });
}

export async function sendClaimSubmittedEmail(params: {
  toEmail: string; displayName: string; ticketId: string;
  claimId: string; handRank: string; prizeAmount: number;
}): Promise<void> {
  const { toEmail, displayName, ticketId, claimId, handRank, prizeAmount } = params;
  const prizeFormatted = `$${(prizeAmount / 100).toFixed(2)}`;
  const body = `<h2>Claim Submitted</h2><p>Hi ${escapeHtml(displayName)},</p>
<p>Your claim has been received and is now pending staff review.</p>
<div class="alert alert-info"><strong>${escapeHtml(handRank)}</strong> — Prize: <strong>${prizeFormatted}</strong></div>
<p><strong>Claim ID:</strong> <code style="color:#58a6ff">${escapeHtml(claimId)}</code></p>
<div style="text-align:center;margin-top:24px"><a href="${APP_URL()}/player/claims" class="btn">View Your Claims</a></div>`;
  await sendEmail({
    to: { email: toEmail, name: displayName },
    from: { email: FROM_EMAIL(), name: FROM_NAME() },
    subject: `Claim received — ${handRank} (${prizeFormatted})`,
    html: wrapHtml(body, 'Claim Submitted'),
    text: `Claim submitted.\nHand: ${handRank}\nPrize: ${prizeFormatted}\nClaim ID: ${claimId}`,
  });
}

export async function sendClaimApprovedEmail(params: {
  toEmail: string; displayName: string; claimId: string;
  handRank: string; prizeAmount: number; approvalNote?: string;
}): Promise<void> {
  const { toEmail, displayName, claimId, handRank, prizeAmount, approvalNote } = params;
  const prizeFormatted = `$${(prizeAmount / 100).toFixed(2)}`;
  const body = `<h2>Your Claim Has Been Approved!</h2><p>Hi ${escapeHtml(displayName)},</p>
<p>Great news — your claim has been approved and is ready for redemption.</p>
<div class="alert alert-success"><strong>${escapeHtml(handRank)}</strong> — Approved prize: <strong>${prizeFormatted}</strong></div>
${approvalNote ? `<p><strong>Note from staff:</strong> ${escapeHtml(approvalNote)}</p>` : ''}
<p>Please visit the venue or contact staff to arrange your payout.</p>
<div style="text-align:center;margin-top:24px"><a href="${APP_URL()}/player/claims" class="btn btn-success">View Approved Claim</a></div>`;
  await sendEmail({
    to: { email: toEmail, name: displayName },
    from: { email: FROM_EMAIL(), name: FROM_NAME() },
    subject: `Your claim has been approved — ${prizeFormatted} ready for payout`,
    html: wrapHtml(body, 'Claim Approved'),
    text: `Claim approved!\nHand: ${handRank}\nPrize: ${prizeFormatted}\nClaim ID: ${claimId}`,
  });
}

export async function sendClaimDeniedEmail(params: {
  toEmail: string; displayName: string; claimId: string;
  handRank: string; denialReason: string;
}): Promise<void> {
  const { toEmail, displayName, claimId, handRank, denialReason } = params;
  const body = `<h2>Claim Update</h2><p>Hi ${escapeHtml(displayName)},</p>
<p>After review, your claim for a <strong>${escapeHtml(handRank)}</strong> hand was not approved.</p>
<div class="alert alert-danger"><strong>Reason:</strong> ${escapeHtml(denialReason)}</div>
<p>If you believe this is an error, please contact support with your Claim ID.</p>
<div style="text-align:center;margin-top:24px"><a href="${SUPPORT_URL()}" class="btn btn-danger">Contact Support</a></div>
<p style="font-size:13px">Claim ID: <code>${escapeHtml(claimId)}</code></p>`;
  await sendEmail({
    to: { email: toEmail, name: displayName },
    from: { email: FROM_EMAIL(), name: FROM_NAME() },
    subject: 'Claim update — action may be required',
    html: wrapHtml(body, 'Claim Update'),
    text: `Claim not approved.\nHand: ${handRank}\nReason: ${denialReason}\nClaim ID: ${claimId}`,
  });
}

export async function sendClaimRedeemedEmail(params: {
  toEmail: string; displayName: string; claimId: string;
  handRank: string; prizeAmount: number; redemptionNote?: string; venueName?: string;
}): Promise<void> {
  const { toEmail, displayName, claimId, handRank, prizeAmount, redemptionNote, venueName } = params;
  const prizeFormatted = `$${(prizeAmount / 100).toFixed(2)}`;
  const body = `<h2>Your Prize Has Been Paid Out!</h2><p>Hi ${escapeHtml(displayName)},</p>
<p>Your prize has been officially redeemed and paid out.</p>
<div class="alert alert-success"><strong>${escapeHtml(handRank)}</strong> — Paid out: <strong>${prizeFormatted}</strong></div>
${venueName ? `<p><strong>Redeemed at:</strong> ${escapeHtml(venueName)}</p>` : ''}
${redemptionNote ? `<p><strong>Staff note:</strong> ${escapeHtml(redemptionNote)}</p>` : ''}
<div class="alert alert-info" style="margin-top:20px;font-size:13px"><strong>Receipt</strong><br/>Claim ID: <code>${escapeHtml(claimId)}</code><br/>Amount: ${prizeFormatted}<br/>Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
<div style="text-align:center;margin-top:24px"><a href="${APP_URL()}/player/claims" class="btn btn-success">View Claim History</a></div>`;
  await sendEmail({
    to: { email: toEmail, name: displayName },
    from: { email: FROM_EMAIL(), name: FROM_NAME() },
    subject: `Prize paid out — ${prizeFormatted} receipt`,
    html: wrapHtml(body, 'Prize Paid Out'),
    text: `Prize paid out!\nHand: ${handRank}\nAmount: ${prizeFormatted}\nClaim ID: ${claimId}`,
  });
}

// ── Distribution ticket email (bulk distribution) ──

export async function sendDistributionTicketEmail(params: {
  toEmail: string;
  toName: string;
  scratchUrl: string;
  campaignName: string;
  orgName: string;
  orgLogo: string | null;
}): Promise<void> {
  const { toEmail, toName, scratchUrl, campaignName, orgName, orgLogo } = params;
  const greeting = toName ? `Hi ${escapeHtml(toName)},` : 'Hi there,';

  const body = `
    ${orgLogo ? `<div style="text-align:center;margin-bottom:16px"><img src="${escapeHtml(orgLogo)}" alt="${escapeHtml(orgName)}" style="max-height:60px"/></div>` : ''}
    <h2 style="text-align:center">You have a scratch ticket!</h2>
    <p>${greeting}</p>
    <p><strong>${escapeHtml(orgName)}</strong> sent you a ScratchPoker ticket for <strong>${escapeHtml(campaignName)}</strong>.</p>
    <p>Tap the button below to scratch your card and see if you've won!</p>
    <div style="text-align:center;margin:32px 0">
      <a href="${escapeHtml(scratchUrl)}" class="btn btn-success" style="display:inline-block;background:#3fb950;color:#000;padding:16px 36px;border-radius:8px;font-weight:700;text-decoration:none;font-size:18px">
        🎴 Scratch Your Card
      </a>
    </div>
    <div class="alert alert-info">
      <strong>One-time use:</strong> This ticket is locked to the first device that opens it. Don't share the link.
    </div>
    <p style="font-size:12px;color:#8b949e;margin-top:24px">If the button doesn't work, copy this link: ${escapeHtml(scratchUrl)}</p>
  `;

  await sendEmail({
    to: { email: toEmail, name: toName || toEmail },
    from: { email: FROM_EMAIL(), name: orgName || FROM_NAME() },
    subject: `🎴 You have a scratch ticket from ${orgName}!`,
    html: wrapHtml(body, 'Your Scratch Ticket'),
    text: `${greeting}\n\n${orgName} sent you a scratch ticket for ${campaignName}.\n\nTap to play: ${scratchUrl}\n\nThis ticket is one-time use - don't share the link.`,
  });
}
