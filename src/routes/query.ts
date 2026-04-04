// Query routes — replaces src/services/firestore.ts read operations
// All GET endpoints for data retrieval.

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { HttpError } from '../lib/helpers.js';
import { parseJsonFields } from '../index.js';

export const queryRouter = Router();

// Never return deck or claimCodeHash from tickets
const TICKET_SAFE_SELECT = {
  id: true, playerId: true, venueId: true, campaignId: true, orgId: true,
  revealedCardIds: true, scratchLimit: true, gameType: true, status: true,
  isFrozen: true, freezeReason: true, frozenAt: true, frozenBy: true,
  prizeSnapshot: true, bestHandAtScratch: true, allowAnonymous: true,
  distributionBatch: true, issuedBy: true, anonymousPlayer: true,
  payoutOverride: true, payoutOverrideNote: true, payoutOverrideBy: true,
  payoutOverrideAt: true, createdAt: true, finalizedAt: true,
  claimSubmittedAt: true, approvedAt: true, redeemedAt: true,
  // deck: false, claimCodeHash: false — intentionally excluded
};

// ── Tickets ──────────────────────────────────────────────────

queryRouter.get('/tickets', requireAuth, async (req, res) => {
  try {
    const { playerId, venueId, status, venueIds, limit: lim } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (playerId) where.playerId = playerId;
    if (venueId) where.venueId = venueId;
    if (status) where.status = status;
    if (venueIds) where.venueId = { in: venueIds.split(',') };

    const tickets = await prisma.ticket.findMany({
      where, select: TICKET_SAFE_SELECT,
      orderBy: { createdAt: 'desc' }, take: parseInt(lim ?? '50', 10),
    });
    res.json(tickets.map(t => ({ ...parseJsonFields(t as unknown as Record<string, unknown>), ticketId: t.id })));
  } catch (err: any) {
    console.error('[query] tickets error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/tickets/:id', requireAuth, async (req, res) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id }, select: TICKET_SAFE_SELECT,
    });
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    res.json({ ...parseJsonFields(ticket as unknown as Record<string, unknown>), ticketId: ticket.id });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Ticket Summaries ─────────────────────────────────────────

queryRouter.get('/ticket-summaries', requireAuth, async (req, res) => {
  try {
    const { playerId, status, venueIds, limit: lim } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (playerId) where.playerId = playerId;
    if (status) where.status = status;
    if (venueIds) where.venueId = { in: venueIds.split(',') };

    const tickets = await prisma.ticket.findMany({
      where,
      select: {
        id: true, playerId: true, venueId: true, campaignId: true,
        status: true, isFrozen: true, freezeReason: true, scratchLimit: true,
        revealedCardIds: true, prizeSnapshot: true,
        createdAt: true, finalizedAt: true, claimSubmittedAt: true,
        approvedAt: true, redeemedAt: true, frozenAt: true, payoutOverride: true,
      },
      orderBy: { createdAt: 'desc' }, take: parseInt(lim ?? '50', 10),
    });

    const summaries = tickets.map(t => {
      const revealedCardIds = typeof t.revealedCardIds === 'string' ? JSON.parse(t.revealedCardIds) : t.revealedCardIds;
      const prizeSnapshot = typeof t.prizeSnapshot === 'string' ? JSON.parse(t.prizeSnapshot) : t.prizeSnapshot;
      return {
        ticketId: t.id, playerId: t.playerId, venueId: t.venueId,
        campaignId: t.campaignId, status: t.status, isFrozen: t.isFrozen,
        freezeReason: t.freezeReason, scratchLimit: t.scratchLimit,
        revealedCount: (revealedCardIds as string[])?.length ?? 0,
        prizeSnapshot, createdAt: t.createdAt,
        finalizedAt: t.finalizedAt, claimSubmittedAt: t.claimSubmittedAt,
        approvedAt: t.approvedAt, redeemedAt: t.redeemedAt, payoutOverride: t.payoutOverride,
      };
    });
    res.json(summaries);
  } catch (err: any) {
    console.error('[query] ticket-summaries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Claims ───────────────────────────────────────────────────

queryRouter.get('/claims', requireAuth, async (req, res) => {
  try {
    const { playerId, status, venueId, venueIds } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (playerId) where.playerId = playerId;
    if (status) where.status = status;
    if (venueId) where.venueId = venueId;
    if (venueIds) where.venueId = { in: venueIds.split(',') };
    if (req.query.campaignId) where.campaignId = req.query.campaignId;

    const claims = await prisma.claim.findMany({
      where, orderBy: { submittedAt: 'desc' }, take: 100,
    });
    res.json(claims.map(c => ({ ...parseJsonFields(c as unknown as Record<string, unknown>), claimId: c.id })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Drawing entries — claims qualifying for monthly drawing ──

queryRouter.get('/drawing-entries', requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query as Record<string, string>;
    if (!campaignId) { res.status(400).json({ error: 'campaignId required' }); return; }

    const claims = await prisma.claim.findMany({
      where: {
        campaignId,
        status: { in: ['pending_staff_approval', 'approved', 'redeemed'] },
      },
      orderBy: { submittedAt: 'desc' },
    });

    // Filter to claims where prizeLabel contains "drawing" (case-insensitive)
    const entries = claims
      .map(c => {
        const ps = typeof c.prizeSnapshot === 'string' ? JSON.parse(c.prizeSnapshot) : c.prizeSnapshot;
        return {
          claimId: c.id,
          ticketId: c.ticketId,
          playerName: c.playerName ?? 'Unknown',
          playerEmail: c.playerEmail ?? '',
          playerPhone: c.playerPhone ?? '',
          handRank: (ps as any)?.handRank ?? '',
          prizeLabel: (ps as any)?.prizeLabel ?? '',
          status: c.status,
          submittedAt: c.submittedAt,
        };
      })
      .filter(e => e.prizeLabel.toLowerCase().includes('drawing'));

    res.json(entries);
  } catch (err: any) {
    console.error('[query] drawing-entries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Drawing results history ──

queryRouter.get('/drawing-results', requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query as Record<string, string>;
    if (!campaignId) { res.status(400).json({ error: 'campaignId required' }); return; }
    const results = await prisma.drawingResult.findMany({
      where: { campaignId },
      orderBy: { drawnAt: 'desc' },
    });
    res.json(results.map(r => ({
      ...r,
      allEntrants: typeof r.allEntrants === 'string' ? JSON.parse(r.allEntrants) : r.allEntrants,
    })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.post('/drawing-results', requireAuth, async (req, res) => {
  try {
    const user = req.user!;
    const { campaignId, orgId, winnerClaimId, winnerName, winnerEmail, winnerHand, winnerPrize, placement, totalEntries, allEntrants, note } = req.body;
    if (!campaignId || !winnerClaimId || !winnerName) {
      res.status(400).json({ error: 'campaignId, winnerClaimId, winnerName required' }); return;
    }
    const result = await prisma.drawingResult.create({
      data: {
        campaignId, orgId: orgId ?? user.orgId ?? null,
        winnerClaimId, winnerName, winnerEmail: winnerEmail ?? '',
        winnerHand: winnerHand ?? '', winnerPrize: winnerPrize ?? '',
        placement: placement ?? 1, totalEntries: totalEntries ?? 0,
        allEntrants: JSON.stringify(allEntrants ?? []),
        drawnBy: user.id, note: note ?? null,
      },
    });
    res.json(result);
  } catch (err: any) {
    console.error('[query] save drawing result error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Past drawing winners (for exclusion) ──

queryRouter.get('/drawing-winners', requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query as Record<string, string>;
    if (!campaignId) { res.status(400).json({ error: 'campaignId required' }); return; }
    const results = await prisma.drawingResult.findMany({
      where: { campaignId },
      select: { winnerClaimId: true, winnerName: true, drawnAt: true },
    });
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/claims/:id', requireAuth, async (req, res) => {
  try {
    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) throw new HttpError(404, 'Claim not found.');
    res.json(parseJsonFields(claim as unknown as Record<string, unknown>));
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Audit Logs ───────────────────────────────────────────────

queryRouter.get('/audit-logs', requireAuth, requireRole('admin', 'finance', 'super_admin'), async (req, res) => {
  try {
    const { targetId, venueId, limit: lim } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (targetId) where.targetId = targetId;
    if (venueId) where.venueId = venueId;

    const logs = await prisma.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take: parseInt(lim ?? '100', 10),
    });
    res.json(logs.map(l => parseJsonFields(l as unknown as Record<string, unknown>)));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Fraud Events ─────────────────────────────────────────────

queryRouter.get('/fraud-events', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { ticketId, venueId, limit: lim } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (ticketId) where.ticketId = ticketId;
    if (venueId) where.venueId = venueId;

    const events = await prisma.fraudEvent.findMany({
      where, orderBy: { createdAt: 'desc' }, take: parseInt(lim ?? '100', 10),
    });
    res.json(events.map(e => parseJsonFields(e as unknown as Record<string, unknown>)));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Risk Scores ──────────────────────────────────────────────

queryRouter.get('/risk-scores', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { severity, limit: lim } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (severity) where.severity = severity;

    const scores = await prisma.riskScore.findMany({
      where, orderBy: { lastEventAt: 'desc' }, take: parseInt(lim ?? '100', 10),
    });
    res.json(scores);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/risk-scores/:ticketId', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const score = await prisma.riskScore.findUnique({ where: { ticketId: req.params.ticketId } });
    if (!score) throw new HttpError(404, 'Risk score not found.');
    res.json(score);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Campaigns ────────────────────────────────────────────────

queryRouter.get('/campaigns', requireAuth, async (req, res) => {
  try {
    const { venueId, orgId, isActive } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (venueId) where.venueId = venueId;
    if (orgId) where.orgId = orgId;
    if (isActive === 'true') where.isActive = true;

    const campaigns = await prisma.campaign.findMany({
      where, orderBy: { createdAt: 'desc' },
    });
    res.json(campaigns.map(c => ({ ...c, campaignId: c.id, oddsProfileId: c.oddsProfileId })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    res.json({ ...campaign, campaignId: campaign.id });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Odds Profiles ────────────────────────────────────────────

queryRouter.get('/odds-profiles', requireAuth, async (req, res) => {
  try {
    const { orgId } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (orgId) where.orgId = orgId;
    const profiles = await prisma.oddsProfile.findMany({ where });
    res.json(profiles.map(p => ({ ...parseJsonFields(p as unknown as Record<string, unknown>), profileId: p.id })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/odds-profiles/:id', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.oddsProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) throw new HttpError(404, 'Odds profile not found.');
    res.json({ ...parseJsonFields(profile as unknown as Record<string, unknown>), profileId: profile.id });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Venues ───────────────────────────────────────────────────

queryRouter.get('/venues', requireAuth, async (_req, res) => {
  try {
    const venues = await prisma.venue.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(venues.map(v => ({ ...v, venueId: v.id })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Users ────────────────────────────────────────────────────

queryRouter.get('/users', requireAuth, requireRole('staff', 'admin', 'finance', 'super_admin'), async (_req, res) => {
  try {
    const users = await prisma.appUser.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(users.map(u => {
      const parsed = parseJsonFields(u as unknown as Record<string, unknown>);
      return { ...parsed, uid: parsed.id }; // frontend expects uid
    }));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Organizations ────────────────────────────────────────────

queryRouter.get('/organizations/:id', requireAuth, async (req, res) => {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!org) throw new HttpError(404, 'Organization not found.');
    res.json(org);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Finance ──────────────────────────────────────────────────

queryRouter.get('/payout-batches', requireAuth, requireRole('finance', 'super_admin'), async (_req, res) => {
  try {
    const batches = await prisma.payoutBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(batches);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/storage-exports', requireAuth, requireRole('finance', 'super_admin'), async (_req, res) => {
  try {
    const exports = await prisma.storageExport.findMany({ orderBy: { generatedAt: 'desc' }, take: 50 });
    res.json(exports);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

queryRouter.get('/reconciliations', requireAuth, requireRole('finance', 'super_admin'), async (_req, res) => {
  try {
    const recs = await prisma.reconciliation.findMany({ orderBy: { generatedAt: 'desc' }, take: 50 });
    res.json(recs);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
