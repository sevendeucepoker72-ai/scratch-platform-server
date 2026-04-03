import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  encryptWebhookSecret,
  TIER_LIMITS,
  type SubscriptionTier,
} from '../lib/helpers.js';

export const webhookRouter = Router();

// ── SSRF protection: blocked hosts ──

const SSRF_BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '169.254.',
  'metadata.google.internal',
  'metadata.google',
  '100.100.100.200',
];

function isBlockedUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // Block non-HTTPS in production
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      return true;
    }

    for (const blocked of SSRF_BLOCKED_HOSTS) {
      if (hostname === blocked || hostname.startsWith(blocked) || hostname.endsWith(`.${blocked}`)) {
        return true;
      }
    }

    // Block IPs that look like private ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 127) return true;
      if (a === 0) return true;
    }

    return false;
  } catch {
    return true; // Invalid URL is blocked
  }
}

// ── POST /register — Register a webhook endpoint ──

webhookRouter.post('/register', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, url, events, description } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify membership and admin role
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can manage webhooks.');
    }

    // Check tier
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    const tier = org.subscriptionTier as SubscriptionTier;
    const limits = TIER_LIMITS[tier];
    if (!limits.webhooks) {
      throw new HttpError(403, 'Webhooks are not available on your plan. Upgrade to Business or above.');
    }

    // Validate URL
    if (!url || typeof url !== 'string') {
      throw new HttpError(400, 'Webhook URL is required.');
    }

    if (isBlockedUrl(url)) {
      throw new HttpError(400, 'Webhook URL is not allowed. Must be a public HTTPS endpoint.');
    }

    // Validate events
    const VALID_EVENTS = [
      'ticket.issued',
      'ticket.finalized',
      'ticket.claimed',
      'ticket.expired',
      'claim.submitted',
      'claim.approved',
      'claim.denied',
      'claim.redeemed',
      'payout.created',
      'payout.processed',
    ];

    if (!Array.isArray(events) || events.length === 0) {
      throw new HttpError(400, 'At least one event type is required.');
    }

    const invalidEvents = events.filter((e: string) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      throw new HttpError(400, `Invalid event types: ${invalidEvents.join(', ')}`);
    }

    // Check max endpoints (limit 10 per org)
    const endpointCount = await prisma.webhookEndpoint.count({ where: { orgId: validOrgId } });
    if (endpointCount >= 10) {
      throw new HttpError(400, 'Maximum of 10 webhook endpoints per organization.');
    }

    // Generate and encrypt signing secret
    const rawSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const encryptedSecret = encryptWebhookSecret(rawSecret);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        orgId: validOrgId,
        url,
        description: description ?? null,
        events,
        secret: encryptedSecret,
        isActive: true,
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'webhook_registered',
      targetType: 'webhook_endpoint',
      targetId: endpoint.id,
      details: { url, events },
    });

    res.json({
      endpoint: {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        description: endpoint.description,
        isActive: endpoint.isActive,
        createdAt: endpoint.createdAt,
      },
      // Return the raw secret only on creation — never again
      secret: rawSecret,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[webhooks] register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /delete — Delete a webhook endpoint ──

webhookRouter.post('/delete', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, endpointId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!endpointId || typeof endpointId !== 'string') {
      throw new HttpError(400, 'Endpoint ID is required.');
    }

    // Verify membership and admin role
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can manage webhooks.');
    }

    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new HttpError(404, 'Webhook endpoint not found.');
    if (endpoint.orgId !== validOrgId) throw new HttpError(403, 'Endpoint does not belong to this organization.');

    // Delete deliveries first, then endpoint
    await prisma.$transaction(async (tx) => {
      await tx.webhookDelivery.deleteMany({ where: { endpointId } });
      await tx.webhookEndpoint.delete({ where: { id: endpointId } });
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'webhook_deleted',
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      details: { url: endpoint.url },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[webhooks] delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /list — List webhook endpoints for an org ──

webhookRouter.post('/list', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify membership
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { orgId: validOrgId },
      select: {
        id: true,
        url: true,
        description: true,
        events: true,
        isActive: true,
        consecutiveFailures: true,
        lastDeliveryAt: true,
        lastDeliveryStatus: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ endpoints });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[webhooks] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
