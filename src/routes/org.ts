import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  TIER_LIMITS,
  type SubscriptionTier,
} from '../lib/helpers.js';

export const orgRouter = Router();

// ── Venue CRUD ──

orgRouter.post('/venues/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, name, address } = req.body;
    if (!name || typeof name !== 'string') throw new HttpError(400, 'Venue name required.');
    const venue = await prisma.venue.create({
      data: { orgId: orgId ?? user.orgId ?? null, name: name.trim(), address: address ?? '' },
    });
    res.json({ venue, venueId: venue.id });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] venues/create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

orgRouter.post('/venues/update', requireAuth, async (req: Request, res: Response) => {
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
    console.error('[org] venues/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Campaign CRUD ──

orgRouter.post('/campaigns/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, venueId, name, description, gameType, isActive, ticketPrice, startDate, endDate,
            guidelines, guidelinesRequired, allowAnonymous, totalTicketsLimit,
            prizes, scratchLimit, oddsProfileName, oddsProfile: oddsProfileInput } = req.body;
    const validOrgId = orgId ?? user.orgId;

    // Support both flat fields and nested oddsProfile object from frontend
    const finalPrizes = prizes ?? oddsProfileInput?.prizes ?? [];
    const finalScratchLimit = scratchLimit ?? oddsProfileInput?.scratchLimit ?? 7;
    const finalOddsName = oddsProfileName ?? oddsProfileInput?.name ?? `${name} Prizes`;

    // Create odds profile first
    const oddsProfile = await prisma.oddsProfile.create({
      data: {
        orgId: validOrgId,
        name: finalOddsName,
        prizes: JSON.stringify(finalPrizes),
        scratchLimit: finalScratchLimit,
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        orgId: validOrgId, venueId, name: name.trim(), description: description ?? null,
        oddsProfileId: oddsProfile.id, gameType: gameType ?? 'poker',
        isActive: isActive ?? true, ticketPrice: ticketPrice ?? 0,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        guidelines: guidelines ?? null, guidelinesRequired: guidelinesRequired ?? false,
        allowAnonymous: allowAnonymous ?? false, totalTicketsLimit: totalTicketsLimit ?? null,
        createdBy: user.id,
      },
    });
    res.json({ campaign, campaignId: campaign.id, oddsProfileId: oddsProfile.id });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] campaigns/create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

orgRouter.post('/campaigns/update', requireAuth, async (req: Request, res: Response) => {
  try {
    const { campaignId, ...updateFields } = req.body;
    if (!campaignId) throw new HttpError(400, 'campaignId required.');
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updateFields)) {
      if (['name', 'description', 'isActive', 'ticketPrice', 'guidelines', 'guidelinesRequired',
           'allowAnonymous', 'totalTicketsLimit', 'gameType'].includes(k)) {
        data[k] = v;
      }
      if (k === 'startDate' || k === 'endDate') data[k] = v ? new Date(v as string) : null;
    }
    const campaign = await prisma.campaign.update({ where: { id: campaignId }, data });
    res.json({ campaign });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] campaigns/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

orgRouter.post('/odds-profiles/update', requireAuth, async (req: Request, res: Response) => {
  try {
    const { profileId, prizes, scratchLimit, name } = req.body;
    if (!profileId) throw new HttpError(400, 'profileId required.');
    const data: Record<string, unknown> = {};
    if (prizes !== undefined) data.prizes = JSON.stringify(prizes);
    if (scratchLimit !== undefined) data.scratchLimit = scratchLimit;
    if (name !== undefined) data.name = name;
    const profile = await prisma.oddsProfile.update({ where: { id: profileId }, data });
    res.json({ profile });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] odds-profiles/update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Onboarding shortcuts ──

orgRouter.post('/create-venue', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, address } = req.body;
    if (!name) throw new HttpError(400, 'Venue name required.');
    const venue = await prisma.venue.create({
      data: { orgId: user.orgId ?? null, name: name.trim(), address: address ?? '' },
    });
    res.json({ venueId: venue.id, venue });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] create-venue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

orgRouter.post('/create-default-campaign', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { venueId, name, prizes, scratchLimit } = req.body;
    if (!venueId || !name) throw new HttpError(400, 'venueId and name required.');
    const oddsProfile = await prisma.oddsProfile.create({
      data: { orgId: user.orgId, name: `${name} Prizes`, prizes: JSON.stringify(prizes ?? []), scratchLimit: scratchLimit ?? 7 },
    });
    const campaign = await prisma.campaign.create({
      data: { orgId: user.orgId, venueId, name: name.trim(), oddsProfileId: oddsProfile.id, isActive: true, createdBy: user.id },
    });
    res.json({ campaignId: campaign.id, campaign });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[org] create-default-campaign error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /create — Create a new organization ──

orgRouter.post('/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, slug } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new HttpError(400, 'Organization name must be at least 2 characters.');
    }

    // Validate and normalize slug
    const normalizedSlug = (slug ?? name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (normalizedSlug.length < 2 || normalizedSlug.length > 64) {
      throw new HttpError(400, 'Slug must be 2-64 characters (lowercase letters, numbers, hyphens).');
    }

    // Check slug uniqueness
    const existing = await prisma.organization.findUnique({ where: { slug: normalizedSlug } });
    if (existing) throw new HttpError(409, 'An organization with this slug already exists.');

    // Check if user already owns an org
    if (user.orgId) {
      throw new HttpError(400, 'You already belong to an organization.');
    }

    const org = await prisma.$transaction(async (tx) => {
      const newOrg = await tx.organization.create({
        data: {
          name: name.trim(),
          slug: normalizedSlug,
          ownerId: user.id,
          subscriptionTier: 'starter',
          subscriptionStatus: 'active',
        },
      });

      // Add owner as OrgMember
      await tx.orgMember.create({
        data: {
          orgId: newOrg.id,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          role: 'owner',
        },
      });

      // Update user with orgId and orgRole
      await tx.appUser.update({
        where: { id: user.id },
        data: {
          orgId: newOrg.id,
          orgRole: 'owner',
          orgName: newOrg.name,
        },
      });

      // Create onboarding record
      await tx.onboarding.create({
        data: {
          id: newOrg.id,
          completedSteps: JSON.stringify(['org_created']),
          currentStep: 'org_created',
        },
      });

      return newOrg;
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'org_created',
      targetType: 'organization',
      targetId: org.id,
      details: { name: org.name, slug: org.slug },
    });

    res.json({ org });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[org] create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /update — Update organization details (owner only) ──

orgRouter.post('/update', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, name, logoUrl, primaryColor } = req.body;
    const validOrgId = validateOrgId(orgId);

    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');
    if (org.ownerId !== user.id && user.role !== 'super_admin') {
      throw new HttpError(403, 'Only the owner can update this organization.');
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined && typeof name === 'string' && name.trim().length >= 2) {
      updateData.name = name.trim();
    }
    if (logoUrl !== undefined) {
      updateData.logoUrl = typeof logoUrl === 'string' ? logoUrl : null;
    }
    if (primaryColor !== undefined) {
      updateData.primaryColor = typeof primaryColor === 'string' ? primaryColor : null;
    }

    if (Object.keys(updateData).length === 0) {
      throw new HttpError(400, 'No valid fields to update.');
    }

    const updated = await prisma.organization.update({
      where: { id: validOrgId },
      data: updateData,
    });

    // Update orgName on user records if name changed
    if (updateData.name) {
      await prisma.appUser.updateMany({
        where: { orgId: validOrgId },
        data: { orgName: updateData.name as string },
      });
    }

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'org_updated',
      targetType: 'organization',
      targetId: validOrgId,
      details: updateData as Record<string, unknown>,
    });

    res.json({ org: updated });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[org] update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /usage — Get organization usage stats ──

orgRouter.post('/usage', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    // Verify membership
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }

    const tier = org.subscriptionTier as SubscriptionTier;
    const limits = TIER_LIMITS[tier] ?? TIER_LIMITS.starter;

    const [memberCount, venueCount, activeCampaignCount] = await Promise.all([
      prisma.orgMember.count({ where: { orgId: validOrgId } }),
      prisma.venue.count({ where: { orgId: validOrgId } }),
      prisma.campaign.count({ where: { orgId: validOrgId, isActive: true } }),
    ]);

    res.json({
      orgId: validOrgId,
      subscriptionTier: tier,
      subscriptionStatus: org.subscriptionStatus,
      ticketsIssuedThisMonth: org.ticketsIssuedThisMonth,
      maxTicketsPerMonth: limits.maxTicketsPerMonth,
      overageTickets: org.overageTickets,
      overageAmountCents: org.overageAmountCents,
      currentPeriodStart: org.currentPeriodStart,
      currentPeriodEnd: org.currentPeriodEnd,
      memberCount,
      maxStaffUsers: limits.maxStaffUsers,
      venueCount,
      maxVenues: limits.maxVenues,
      activeCampaignCount,
      maxActiveCampaigns: limits.maxActiveCampaigns,
      features: {
        cardDesigner: limits.cardDesigner,
        whiteLabelBranding: limits.whiteLabelBranding,
        customDomain: limits.customDomain,
        apiAccess: limits.apiAccess,
        webhooks: limits.webhooks,
        advancedAnalytics: limits.advancedAnalytics,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[org] usage error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /save-card-design — Save card design for org ──

orgRouter.post('/save-card-design', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, campaignId, name, design } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    // Verify membership
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (member && !['owner', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only admins can save card designs.');
    }

    // Check tier allows card designer
    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    const tier = org.subscriptionTier as SubscriptionTier;
    const limits = TIER_LIMITS[tier];
    if (!limits.cardDesigner) {
      throw new HttpError(403, 'Card designer is not available on your plan. Upgrade to Growth or above.');
    }

    if (!name || typeof name !== 'string') {
      throw new HttpError(400, 'Card design name is required.');
    }
    if (!design || typeof design !== 'object') {
      throw new HttpError(400, 'Card design data is required.');
    }

    const cardDesign = await prisma.cardDesign.upsert({
      where: {
        orgId_campaignId: {
          orgId: validOrgId,
          campaignId: campaignId ?? null,
        },
      },
      update: {
        name: name.trim(),
        design: JSON.stringify(design),
      },
      create: {
        orgId: validOrgId,
        campaignId: campaignId ?? null,
        name: name.trim(),
        design: JSON.stringify(design),
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'card_design_saved',
      targetType: 'card_design',
      targetId: cardDesign.id,
      details: { orgId: validOrgId, campaignId, name },
    });

    res.json({ cardDesign: { ...cardDesign, design: typeof cardDesign.design === 'string' ? JSON.parse(cardDesign.design) : cardDesign.design } });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[org] save-card-design error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /complete-onboarding — Mark an onboarding step as complete ──

orgRouter.post('/complete-onboarding', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, step } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!step || typeof step !== 'string') {
      throw new HttpError(400, 'Onboarding step name is required.');
    }

    const VALID_STEPS = [
      'org_created',
      'venue_added',
      'campaign_created',
      'odds_configured',
      'first_ticket_issued',
      'team_invited',
      'branding_configured',
      'completed',
    ];

    if (!VALID_STEPS.includes(step)) {
      throw new HttpError(400, `Invalid onboarding step: ${step}`);
    }

    // Verify membership
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!member && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }

    const onboarding = await prisma.onboarding.upsert({
      where: { id: validOrgId },
      update: {},
      create: {
        id: validOrgId,
        completedSteps: '[]',
        currentStep: 'org_created',
      },
    });

    const completedSteps = JSON.parse(onboarding.completedSteps as string) as string[];
    if (completedSteps.includes(step)) {
      res.json({ onboarding: { ...onboarding, completedSteps } });
      return;
    }

    const newSteps = [...completedSteps, step];
    const isFullyComplete = step === 'completed' || newSteps.length >= VALID_STEPS.length - 1;

    const updated = await prisma.onboarding.update({
      where: { id: validOrgId },
      data: {
        completedSteps: JSON.stringify(newSteps),
        currentStep: step,
        completedAt: isFullyComplete ? new Date() : undefined,
      },
    });

    res.json({ onboarding: { ...updated, completedSteps: newSteps } });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[org] complete-onboarding error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
