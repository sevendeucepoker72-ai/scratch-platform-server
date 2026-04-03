import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as dns from 'dns/promises';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  validateTicketId,
  hashClaimCode,
  generateClaimCode,
  escapeHtml,
  TIER_LIMITS,
  type SubscriptionTier,
} from '../lib/helpers.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';

export const miscRouter = Router();

// ── POST /resend-claim-code — Resend claim code email (authenticated) ──

miscRouter.post('/resend-claim-code', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { ticketId } = req.body;
    const validId = validateTicketId(ticketId);

    checkRateLimit(`resend:${user.id}`, 3);

    const ticket = await prisma.ticket.findUnique({ where: { id: validId } });
    if (!ticket) throw new HttpError(404, 'Ticket not found.');

    // Only the ticket owner or staff/admin can resend
    if (ticket.playerId !== user.id && !['staff', 'admin', 'super_admin'].includes(user.role)) {
      throw new HttpError(403, 'You do not have access to this ticket.');
    }

    if (!ticket.claimCodeHash) {
      throw new HttpError(400, 'No claim code exists for this ticket.');
    }

    // Generate a new claim code and update the hash
    const newClaimCode = generateClaimCode();
    const newHash = hashClaimCode(newClaimCode);

    await prisma.ticket.update({
      where: { id: validId },
      data: {
        claimCodeHash: newHash,
        claimCodeEmailSentAt: new Date(),
      },
    });

    // Determine recipient email
    const recipientEmail = ticket.playerId
      ? (await prisma.appUser.findUnique({ where: { id: ticket.playerId } }))?.email
      : (typeof ticket.anonymousPlayer === 'string' ? JSON.parse(ticket.anonymousPlayer) : ticket.anonymousPlayer)?.email;

    if (!recipientEmail) {
      throw new HttpError(400, 'No email address associated with this ticket.');
    }

    // In production, integrate with email provider (SendGrid, SES, etc.)
    // For development, log and include in response
    console.log(`[misc] Claim code for ticket ${validId}: ${newClaimCode} -> ${recipientEmail}`);

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'claim_code_resent',
      targetType: 'ticket',
      targetId: validId,
      details: { recipientEmail },
    });

    res.json({
      success: true,
      message: 'Claim code has been resent.',
      ...(process.env.NODE_ENV !== 'production' ? { claimCode: newClaimCode } : {}),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] resend-claim-code error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /referral/create — Create a referral code (authenticated) ──

miscRouter.post('/referral/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, creditAmountCents, maxUsages } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify ownership
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');
    if (org.ownerId !== user.id && user.role !== 'super_admin') {
      throw new HttpError(403, 'Only the org owner can create referral codes.');
    }

    // Limit active referral codes per org
    const activeCount = await prisma.referralCode.count({
      where: { orgId: validOrgId, isActive: true },
    });
    if (activeCount >= 10) {
      throw new HttpError(400, 'Maximum of 10 active referral codes per organization.');
    }

    // Generate unique code
    const code = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const referralCode = await prisma.referralCode.create({
      data: {
        orgId: validOrgId,
        code,
        creditAmountCents: typeof creditAmountCents === 'number' && creditAmountCents > 0
          ? Math.min(creditAmountCents, 50000)  // cap at $500
          : 1000, // default $10
        maxUsages: typeof maxUsages === 'number' && maxUsages > 0 ? maxUsages : null,
        isActive: true,
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'referral_code_created',
      targetType: 'referral_code',
      targetId: referralCode.id,
      details: { code, creditAmountCents: referralCode.creditAmountCents },
    });

    res.json({ referralCode });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] referral/create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /referral/apply — Apply a referral code (authenticated) ──

miscRouter.post('/referral/apply', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { code, orgId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!code || typeof code !== 'string') {
      throw new HttpError(400, 'Referral code is required.');
    }

    const referralCode = await prisma.referralCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!referralCode) throw new HttpError(404, 'Referral code not found.');
    if (!referralCode.isActive) throw new HttpError(400, 'This referral code is no longer active.');

    // Can't use your own referral code
    if (referralCode.orgId === validOrgId) {
      throw new HttpError(400, 'You cannot use your own referral code.');
    }

    // Check max usages
    if (referralCode.maxUsages !== null && referralCode.usageCount >= referralCode.maxUsages) {
      throw new HttpError(400, 'This referral code has reached its maximum number of uses.');
    }

    // Check if org already used a referral code
    const existingConversion = await prisma.referralConversion.findFirst({
      where: { convertedOrgId: validOrgId },
    });
    if (existingConversion) {
      throw new HttpError(400, 'Your organization has already applied a referral code.');
    }

    // Verify the applying user owns the org
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');
    if (org.ownerId !== user.id && user.role !== 'super_admin') {
      throw new HttpError(403, 'Only the org owner can apply referral codes.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.referralConversion.create({
        data: {
          referralCodeId: referralCode.id,
          referringOrgId: referralCode.orgId,
          convertedOrgId: validOrgId,
          creditAppliedCents: referralCode.creditAmountCents,
        },
      });

      await tx.referralCode.update({
        where: { id: referralCode.id },
        data: { usageCount: { increment: 1 } },
      });
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'referral_code_applied',
      targetType: 'referral_code',
      targetId: referralCode.id,
      details: {
        code: referralCode.code,
        creditAmountCents: referralCode.creditAmountCents,
        referringOrgId: referralCode.orgId,
      },
    });

    res.json({
      success: true,
      creditAppliedCents: referralCode.creditAmountCents,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] referral/apply error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /referral/stats — Get referral stats (authenticated) ──

miscRouter.post('/referral/stats', requireAuth, async (req: Request, res: Response) => {
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

    const referralCodes = await prisma.referralCode.findMany({
      where: { orgId: validOrgId },
      include: {
        conversions: {
          select: {
            id: true,
            convertedOrgId: true,
            creditAppliedCents: true,
            convertedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalConversions = referralCodes.reduce((sum, rc) => sum + rc.conversions.length, 0);
    const totalCreditsCents = referralCodes.reduce(
      (sum, rc) => sum + rc.conversions.reduce((s, c) => s + c.creditAppliedCents, 0),
      0
    );

    res.json({
      referralCodes: referralCodes.map(rc => ({
        id: rc.id,
        code: rc.code,
        creditAmountCents: rc.creditAmountCents,
        usageCount: rc.usageCount,
        maxUsages: rc.maxUsages,
        isActive: rc.isActive,
        conversions: rc.conversions,
        createdAt: rc.createdAt,
      })),
      totalConversions,
      totalCreditsCents,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] referral/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /custom-domain/register — Register a custom domain ──

miscRouter.post('/custom-domain/register', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, hostname } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!hostname || typeof hostname !== 'string') {
      throw new HttpError(400, 'Hostname is required.');
    }

    // Validate hostname format
    const hostnameRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
    const normalizedHostname = hostname.toLowerCase().trim();
    if (!hostnameRegex.test(normalizedHostname)) {
      throw new HttpError(400, 'Invalid hostname format.');
    }

    // Verify ownership and tier
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can manage custom domains.');
    }

    const tier = org.subscriptionTier as SubscriptionTier;
    if (!TIER_LIMITS[tier].customDomain && req.user!.role !== 'super_admin') {
      throw new HttpError(403, 'Custom domains are not available on your plan. Upgrade to Business or above.');
    }

    // Check if hostname is already taken
    const existing = await prisma.customDomain.findUnique({ where: { hostname: normalizedHostname } });
    if (existing) {
      throw new HttpError(409, 'This hostname is already registered.');
    }

    // Limit domains per org (max 5)
    const domainCount = await prisma.customDomain.count({ where: { orgId: validOrgId } });
    if (domainCount >= 5) {
      throw new HttpError(400, 'Maximum of 5 custom domains per organization.');
    }

    // Generate TXT record for verification
    const txtRecord = `scratch-verify=${crypto.randomBytes(16).toString('hex')}`;

    const domain = await prisma.customDomain.create({
      data: {
        orgId: validOrgId,
        hostname: normalizedHostname,
        verified: false,
        txtRecord,
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'custom_domain_registered',
      targetType: 'custom_domain',
      targetId: domain.id,
      details: { hostname: normalizedHostname },
    });

    res.json({
      domain: {
        id: domain.id,
        hostname: domain.hostname,
        verified: domain.verified,
        txtRecord: domain.txtRecord,
        createdAt: domain.createdAt,
      },
      instructions: `Add a TXT record to your DNS: _scratch-verify.${normalizedHostname} -> ${txtRecord}`,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] custom-domain/register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /custom-domain/verify — Verify a custom domain via DNS TXT lookup ──

miscRouter.post('/custom-domain/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, domainId, hostname } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Support lookup by domainId or hostname
    let domain;
    if (domainId && typeof domainId === 'string') {
      domain = await prisma.customDomain.findUnique({ where: { id: domainId } });
    } else if (hostname && typeof hostname === 'string') {
      domain = await prisma.customDomain.findUnique({ where: { hostname: hostname.toLowerCase() } });
    } else {
      throw new HttpError(400, 'Either domainId or hostname is required.');
    }

    if (!domain) throw new HttpError(404, 'Custom domain not found.');
    if (domain.orgId !== validOrgId) throw new HttpError(403, 'Domain does not belong to this organization.');
    if (domain.verified) {
      res.json({ verified: true, message: 'Domain is already verified.' });
      return;
    }

    // Verify membership
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }

    // DNS TXT lookup
    const lookupHostname = `_scratch-verify.${domain.hostname}`;
    let txtRecords: string[][];
    try {
      txtRecords = await dns.resolveTxt(lookupHostname);
    } catch {
      throw new HttpError(400, `DNS lookup failed for ${lookupHostname}. Ensure the TXT record is configured.`);
    }

    const flatRecords = txtRecords.map(r => r.join(''));
    const expectedTxt = domain.txtRecord;

    if (!expectedTxt || !flatRecords.includes(expectedTxt)) {
      throw new HttpError(400, 'TXT record not found or does not match. Please check your DNS settings.');
    }

    await prisma.customDomain.update({
      where: { id: domain.id },
      data: {
        verified: true,
        verifiedAt: new Date(),
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'custom_domain_verified',
      targetType: 'custom_domain',
      targetId: domain.id,
      details: { hostname: domain.hostname },
    });

    res.json({ verified: true, message: 'Domain verified successfully.' });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] custom-domain/verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /custom-domain/remove — Remove a custom domain ──

miscRouter.post('/custom-domain/remove', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, domainId, hostname } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify membership and admin role
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only owners and admins can manage custom domains.');
    }

    // Support lookup by domainId or hostname
    let domain;
    if (domainId && typeof domainId === 'string') {
      domain = await prisma.customDomain.findUnique({ where: { id: domainId } });
    } else if (hostname && typeof hostname === 'string') {
      domain = await prisma.customDomain.findUnique({ where: { hostname: hostname.toLowerCase() } });
    } else {
      throw new HttpError(400, 'Either domainId or hostname is required.');
    }

    if (!domain) throw new HttpError(404, 'Custom domain not found.');
    if (domain.orgId !== validOrgId) throw new HttpError(403, 'Domain does not belong to this organization.');

    await prisma.customDomain.delete({ where: { id: domain.id } });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'custom_domain_removed',
      targetType: 'custom_domain',
      targetId: domain.id,
      details: { hostname: domain.hostname },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] custom-domain/remove error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /custom-domain/list — List custom domains for an org ──

miscRouter.post('/custom-domain/list', requireAuth, async (req: Request, res: Response) => {
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

    const domains = await prisma.customDomain.findMany({
      where: { orgId: validOrgId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ domains });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] custom-domain/list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /resolve-org-by-hostname — Resolve org by custom domain (no auth) ──

miscRouter.post('/resolve-org-by-hostname', async (req: Request, res: Response) => {
  try {
    const { hostname } = req.body;

    if (!hostname || typeof hostname !== 'string') {
      throw new HttpError(400, 'Hostname is required.');
    }

    const domain = await prisma.customDomain.findUnique({
      where: { hostname: hostname.toLowerCase().trim() },
    });

    if (!domain || !domain.verified) {
      throw new HttpError(404, 'No organization found for this hostname.');
    }

    const org = await prisma.organization.findUnique({
      where: { id: domain.orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        primaryColor: true,
        isActive: true,
      },
    });

    if (!org || !org.isActive) {
      throw new HttpError(404, 'Organization not found or inactive.');
    }

    res.json({ org });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] resolve-org-by-hostname error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /refresh-claims — No-op; Better Auth handles sessions natively ──

miscRouter.post('/refresh-claims', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    res.json({
      success: true,
      message: 'Session is managed by Better Auth. No manual refresh needed.',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        orgId: user.orgId,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[misc] refresh-claims error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /email-batch — Send a batch of emails (admin+) ──

miscRouter.post(
  '/email-batch',
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { recipients, subject, htmlBody, textBody, templateId } = req.body;

      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new HttpError(400, 'Recipients array is required.');
      }

      if (recipients.length > 500) {
        throw new HttpError(400, 'Maximum 500 recipients per batch.');
      }

      if (!subject || typeof subject !== 'string') {
        throw new HttpError(400, 'Email subject is required.');
      }

      // Validate all recipient emails
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalidEmails = recipients.filter(
        (r: any) => typeof r !== 'string' || !emailRegex.test(r)
      );
      if (invalidEmails.length > 0) {
        throw new HttpError(400, `Invalid email addresses found in batch.`);
      }

      // In production, integrate with email provider (SendGrid, SES, etc.)
      // For now, log the batch and return success
      const batchId = crypto.randomBytes(8).toString('hex');

      console.log(`[misc] Email batch ${batchId}: ${recipients.length} recipients, subject: "${escapeHtml(subject)}"`);

      await writeAuditLog({
        actorUserId: user.id,
        actorRole: user.role,
        actionType: 'email_batch_sent',
        targetType: 'email_batch',
        targetId: batchId,
        details: {
          recipientCount: recipients.length,
          subject,
          templateId: templateId ?? null,
        },
      });

      res.json({
        batchId,
        recipientCount: recipients.length,
        status: 'queued',
        message: 'Email batch has been queued for delivery.',
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[misc] email-batch error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── Admin campaign routes ──

miscRouter.post('/admin/campaigns', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { venueId, name, oddsProfileId, isActive, ticketPrice, orgId } = req.body;
    if (!venueId || !name || !oddsProfileId) throw new HttpError(400, 'venueId, name, oddsProfileId required.');
    const campaign = await prisma.campaign.create({
      data: { orgId: orgId ?? null, venueId, name, oddsProfileId, isActive: isActive ?? true, ticketPrice: ticketPrice ?? 0, createdBy: req.user!.id },
    });
    res.json({ campaign });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[misc] admin/campaigns error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

miscRouter.post('/admin/campaigns/update', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { campaignId, isActive, name } = req.body;
    if (!campaignId) throw new HttpError(400, 'campaignId required.');
    const data: Record<string, unknown> = {};
    if (isActive !== undefined) data.isActive = isActive;
    if (name !== undefined) data.name = name;
    const campaign = await prisma.campaign.update({ where: { id: campaignId }, data });
    res.json({ campaign });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[misc] admin/campaigns/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Super admin routes ──

miscRouter.post('/superadmin/users/update', requireAuth, requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const { userId, role, isActive, venueIds } = req.body;
    if (!userId) throw new HttpError(400, 'userId required.');
    const data: Record<string, unknown> = {};
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.isActive = isActive;
    if (venueIds !== undefined) data.venueIds = JSON.stringify(venueIds);
    const user = await prisma.appUser.update({ where: { id: userId }, data });
    res.json({ user });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[misc] superadmin/users/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

miscRouter.post('/superadmin/venues/create', requireAuth, requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const { name, address, orgId } = req.body;
    if (!name) throw new HttpError(400, 'Venue name required.');
    const venue = await prisma.venue.create({ data: { name: name.trim(), address: address ?? '', orgId: orgId ?? null } });
    res.json({ venue, venueId: venue.id });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[misc] superadmin/venues/create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

miscRouter.post('/superadmin/venues/update', requireAuth, requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const { venueId, isActive, name, address } = req.body;
    if (!venueId) throw new HttpError(400, 'venueId required.');
    const data: Record<string, unknown> = {};
    if (isActive !== undefined) data.isActive = isActive;
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    const venue = await prisma.venue.update({ where: { id: venueId }, data });
    res.json({ venue });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[misc] superadmin/venues/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
