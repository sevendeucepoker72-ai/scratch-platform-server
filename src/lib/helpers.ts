// Shared helpers — ported from functions/src/helpers.ts
// Replaced Firestore ops with Prisma, removed Firebase dependencies.

import * as crypto from 'crypto';
import { prisma } from '../db.js';

// ── HMAC claim code hashing ─────────────────────────────────

function getClaimCodeSecret(): string {
  const secret = process.env.CLAIM_CODE_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CLAIM_CODE_SECRET must be set in production');
    }
    return crypto.createHash('sha256').update('claim-code-key-dev-fallback').digest('hex');
  }
  return secret;
}

export function hashClaimCode(plain: string): string {
  return crypto.createHmac('sha256', getClaimCodeSecret()).update(plain).digest('hex');
}

export function generateClaimCode(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// ── Input validators ─────────────────────────────────────────

const POKER_CARD_RE = /^(10|[2-9JQKA])[SHDC]$/;
const GAME_ITEM_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function validateCardId(cardId: unknown): string {
  if (typeof cardId !== 'string') throw new HttpError(400, 'Invalid item ID.');
  if (!POKER_CARD_RE.test(cardId) && !GAME_ITEM_RE.test(cardId)) {
    throw new HttpError(400, 'Invalid item ID format.');
  }
  return cardId;
}

export function validateTicketId(ticketId: unknown): string {
  if (typeof ticketId !== 'string' || ticketId.length < 10 || ticketId.length > 128 || /[^a-zA-Z0-9_-]/.test(ticketId)) {
    throw new HttpError(400, 'Invalid ticket ID format.');
  }
  return ticketId;
}

export function validateOrgId(orgId: unknown): string {
  if (typeof orgId !== 'string' || orgId.length < 10 || orgId.length > 128 || /[^a-zA-Z0-9_-]/.test(orgId)) {
    throw new HttpError(400, 'Invalid org ID format.');
  }
  return orgId;
}

// ── Audit log sanitization ───────────────────────────────────

export function sanitizeDetails(
  obj: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  if (depth > 2) return { '[truncated]': 'max depth reached' };
  const out: Record<string, unknown> = {};
  let keyCount = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('__')) continue;
    if (++keyCount > 30) { out['[truncated]'] = 'max keys reached'; break; }
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === 'string') out[k] = v.length > 500 ? v.slice(0, 500) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) {
      const capped = v.slice(0, 20);
      out[k] = capped.map(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? sanitizeDetails(item as Record<string, unknown>, depth + 1)
          : typeof item === 'string' && item.length > 200 ? item.slice(0, 200) + '...' : item
      );
    } else if (typeof v === 'object') {
      out[k] = sanitizeDetails(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = String(v).slice(0, 200);
    }
  }
  return out;
}

// ── Audit log writer ─────────────────────────────────────────

export async function writeAuditLog(params: {
  actorUserId: string;
  actorRole: string;
  actionType: string;
  targetType: string;
  targetId: string;
  venueId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      actionType: params.actionType,
      targetType: params.targetType,
      targetId: params.targetId,
      venueId: params.venueId ?? null,
      details: JSON.stringify(sanitizeDetails(params.details ?? {})),
    },
  });
}

// ── Fraud event writer ───────────────────────────────────────

export async function writeFraudEvent(params: {
  ticketId: string;
  playerId: string;
  venueId?: string;
  signal: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.fraudEvent.create({
      data: {
        ticketId: params.ticketId,
        playerId: params.playerId,
        venueId: params.venueId ?? null,
        signal: params.signal,
        details: JSON.stringify(params.details ?? {}),
      },
    });

    const existing = await tx.riskScore.findUnique({
      where: { ticketId: params.ticketId },
    });

    const currentScore = existing?.score ?? 0;
    const newScore = Math.min(currentScore + 25, 100);
    const severity = newScore >= 75 ? 'critical' : newScore >= 50 ? 'high' : newScore >= 25 ? 'medium' : 'low';

    await tx.riskScore.upsert({
      where: { ticketId: params.ticketId },
      update: {
        score: newScore,
        severity,
        requiresManualReview: newScore >= 50,
        lastEventAt: new Date(),
      },
      create: {
        id: params.ticketId,
        ticketId: params.ticketId,
        playerId: params.playerId,
        venueId: params.venueId ?? null,
        score: newScore,
        severity,
        requiresManualReview: newScore >= 50,
        status: 'open',
        lastEventAt: new Date(),
      },
    });
  });
}

// ── Idempotency check (atomic — fixes the race condition) ────

export async function checkIdempotency(key: string): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: { id: key },
    });
    return true; // first time
  } catch {
    return false; // already exists (unique constraint violation)
  }
}

// ── HTTP Error helper ────────────────────────────────────────

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

// ── Webhook secret encryption ────────────────────────────────

function getWebhookSigningKey(): string {
  return process.env.CLAIM_CODE_SECRET ??
    crypto.createHash('sha256').update(`webhook-signing-dev`).digest('hex');
}

export function encryptWebhookSecret(secret: string): string {
  const key = Buffer.from(getWebhookSigningKey().slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${encrypted.toString('hex')}.${tag.toString('hex')}`;
}

export function decryptWebhookSecret(stored: string): string {
  const [ivHex, encHex, tagHex] = stored.split('.');
  const key = Buffer.from(getWebhookSigningKey().slice(0, 64), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Global rate limiter (DB-backed) ──────────────────────────

export async function checkGlobalRateLimit(uid: string, maxPerHour: number): Promise<void> {
  const windowHour = Math.floor(Date.now() / 3_600_000);
  const key = `issue_rate:${uid}:${windowHour}`;

  await prisma.$transaction(async (tx) => {
    const bucket = await tx.rateLimitBucket.findUnique({ where: { id: key } });
    const count = bucket?.count ?? 0;
    if (count >= maxPerHour) {
      throw new HttpError(429, 'You have issued too many tickets this hour.');
    }
    await tx.rateLimitBucket.upsert({
      where: { id: key },
      update: { count: { increment: 1 } },
      create: { id: key, uid, windowHour, count: 1, expiresAt: new Date((windowHour + 1) * 3_600_000 + 300_000) },
    });
  });
}

// ── Tier limits ──────────────────────────────────────────────

export type SubscriptionTier = 'starter' | 'growth' | 'business' | 'enterprise';

export const TIER_LIMITS = {
  starter:    { maxActiveCampaigns: 1,  maxTicketsPerMonth: 500,   maxVenues: 1,  maxStaffUsers: 2,  cardDesigner: false, whiteLabelBranding: false, customDomain: false, apiAccess: false, webhooks: false, advancedAnalytics: false },
  growth:     { maxActiveCampaigns: 5,  maxTicketsPerMonth: 5000,  maxVenues: 5,  maxStaffUsers: 10, cardDesigner: true,  whiteLabelBranding: false, customDomain: false, apiAccess: false, webhooks: false, advancedAnalytics: true  },
  business:   { maxActiveCampaigns: -1, maxTicketsPerMonth: 25000, maxVenues: -1, maxStaffUsers: -1, cardDesigner: true,  whiteLabelBranding: true,  customDomain: true,  apiAccess: true,  webhooks: true,  advancedAnalytics: true  },
  enterprise: { maxActiveCampaigns: -1, maxTicketsPerMonth: -1,    maxVenues: -1, maxStaffUsers: -1, cardDesigner: true,  whiteLabelBranding: true,  customDomain: true,  apiAccess: true,  webhooks: true,  advancedAnalytics: true  },
} as const;

export const OVERAGE_RATE_CENTS: Record<SubscriptionTier, number> = {
  starter: 15, growth: 8, business: 4, enterprise: 2,
};

// ── Quota check ──────────────────────────────────────────────

export async function checkTicketQuota(orgId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const orgRecord = await tx.organization.findUnique({ where: { id: orgId } });
    if (!orgRecord) throw new HttpError(404, 'Organization not found.');
    const org = orgRecord;

    const limits = TIER_LIMITS[org.subscriptionTier as SubscriptionTier];
    const monthlyLimit = limits?.maxTicketsPerMonth ?? 100;
    if (monthlyLimit === -1) return;

    const used = org.ticketsIssuedThisMonth ?? 0;
    const overageRate = OVERAGE_RATE_CENTS[org.subscriptionTier as SubscriptionTier] ?? 15;

    if (used >= monthlyLimit) {
      await tx.organization.update({
        where: { id: orgId },
        data: {
          overageTickets: { increment: 1 },
          overageAmountCents: { increment: overageRate },
        },
      });
    } else {
      await tx.organization.update({
        where: { id: orgId },
        data: { ticketsIssuedThisMonth: { increment: 1 } },
      });
    }
  });
}

// ── HTML escape for email templates ──────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
