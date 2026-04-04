import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  TIER_LIMITS,
  type SubscriptionTier,
} from '../lib/helpers.js';

export const apiKeyRouter = Router();

// HMAC-SHA256 key hashing
function getApiKeySecret(): string {
  return process.env.API_KEY_SECRET
    ?? process.env.CLAIM_CODE_SECRET
    ?? crypto.createHash('sha256').update('api-key-dev-fallback').digest('hex');
}

function hashApiKey(rawKey: string): string {
  return crypto.createHmac('sha256', getApiKeySecret()).update(rawKey).digest('hex');
}

// Valid API key scopes
const VALID_SCOPES = [
  'tickets:read',
  'tickets:write',
  'campaigns:read',
  'campaigns:write',
  'claims:read',
  'claims:write',
  'analytics:read',
  'webhooks:manage',
];

// ── POST /create — Create a new API key (org owner/admin, Business+) ──

apiKeyRouter.post('/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, name, scopes, expiresInDays } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify membership and admin role
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can create API keys.');
    }

    // Check tier allows API access
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    const tier = org.subscriptionTier as SubscriptionTier;
    const limits = TIER_LIMITS[tier];
    if (!limits.apiAccess && user.role !== 'super_admin') {
      throw new HttpError(403, 'API access is not available on your plan. Upgrade to Business or above.');
    }

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new HttpError(400, 'API key name must be at least 2 characters.');
    }

    // Validate scopes
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new HttpError(400, 'At least one scope is required.');
    }
    const invalidScopes = scopes.filter((s: string) => !VALID_SCOPES.includes(s));
    if (invalidScopes.length > 0) {
      throw new HttpError(400, `Invalid scopes: ${invalidScopes.join(', ')}`);
    }

    // Limit number of active keys per org (max 20)
    const activeKeyCount = await prisma.apiKey.count({
      where: { orgId: validOrgId, isActive: true },
    });
    if (activeKeyCount >= 20) {
      throw new HttpError(400, 'Maximum of 20 active API keys per organization.');
    }

    // Generate the raw key
    const prefix = `sk_${tier === 'enterprise' ? 'ent' : 'biz'}_`;
    const rawKeyBody = crypto.randomBytes(32).toString('hex');
    const rawKey = `${prefix}${rawKeyBody}`;
    const keyPrefix = rawKey.slice(0, 12);
    const keyHash = hashApiKey(rawKey);

    // Calculate expiration
    let expiresAt: Date | null = null;
    if (typeof expiresInDays === 'number' && expiresInDays > 0) {
      expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    }

    const apiKey = await prisma.apiKey.create({
      data: {
        orgId: validOrgId,
        name: name.trim(),
        keyPrefix,
        keyHash,
        scopes: JSON.stringify(scopes),
        isActive: true,
        createdBy: user.id,
        expiresAt,
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'api_key_created',
      targetType: 'api_key',
      targetId: apiKey.id,
      details: { name: name.trim(), scopes, keyPrefix },
    });

    // Return the raw key ONLY on creation
    res.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        scopes: typeof apiKey.scopes === 'string' ? JSON.parse(apiKey.scopes) : apiKey.scopes,
        isActive: apiKey.isActive,
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      },
      rawKey,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[apiKeys] create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /revoke — Revoke an API key ──

apiKeyRouter.post('/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, keyId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!keyId || typeof keyId !== 'string') {
      throw new HttpError(400, 'API key ID is required.');
    }

    // Verify membership and admin role
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can revoke API keys.');
    }

    const apiKey = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!apiKey) throw new HttpError(404, 'API key not found.');
    if (apiKey.orgId !== validOrgId) throw new HttpError(403, 'API key does not belong to this organization.');
    if (!apiKey.isActive) throw new HttpError(400, 'API key is already revoked.');

    await prisma.apiKey.update({
      where: { id: keyId },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedBy: user.id,
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'api_key_revoked',
      targetType: 'api_key',
      targetId: keyId,
      details: { name: apiKey.name, keyPrefix: apiKey.keyPrefix },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[apiKeys] revoke error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /list — List API keys for an org ──

apiKeyRouter.post('/list', requireAuth, async (req: Request, res: Response) => {
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

    const apiKeys = await prisma.apiKey.findMany({
      where: { orgId: validOrgId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        isActive: true,
        lastUsedAt: true,
        createdBy: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedBy: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ apiKeys: apiKeys.map(k => ({
      ...k,
      scopes: typeof k.scopes === 'string' ? JSON.parse(k.scopes) : k.scopes,
    })) });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[apiKeys] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
