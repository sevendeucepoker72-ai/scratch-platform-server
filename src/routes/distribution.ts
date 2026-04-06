import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import {
  HttpError,
  writeAuditLog,
  hashClaimCode,
  generateClaimCode,
  validateTicketId,
  validateCardId,
  checkTicketQuota,
  escapeHtml,
} from '../lib/helpers.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { buildShuffledDeck, evaluateBestHand, buildPrizeSnapshot } from '../game/poker.js';
import {
  GAME_ENGINES,
  buildGamePrizeSnapshot,
  type GameType,
  type GenericOddsProfile,
} from '../game/gameEngines.js';

export const distributionRouter = Router();

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
}

// Generate a 6-char base62 short URL code
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateShortCode(): string {
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += BASE62[bytes[i] % 62];
  return code;
}

// Get or create a short URL for a target — returns the short URL string
async function getOrCreateShortUrl(targetUrl: string): Promise<string> {
  // Reuse existing short code for the same target if exists
  const existing = await prisma.shortUrl.findFirst({ where: { targetUrl } });
  if (existing) return `${APP_URL}/s/${existing.id}`;

  // Generate unique code (retry up to 5 times on collision)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    try {
      await prisma.shortUrl.create({ data: { id: code, targetUrl } });
      return `${APP_URL}/s/${code}`;
    } catch {
      // Collision, try again
    }
  }
  // Fallback to original URL if all attempts fail
  return targetUrl;
}

// Apply merge tag substitution: {{firstName}}, {{name}}, {{campaign}}, {{venue}}, {{url}}, {{org}}
function applyMergeTags(template: string, vars: {
  firstName?: string;
  name?: string;
  campaign?: string;
  venue?: string;
  url?: string;
  org?: string;
}): string {
  return template
    .replace(/\{\{\s*firstName\s*\}\}/gi, vars.firstName ?? '')
    .replace(/\{\{\s*name\s*\}\}/gi, vars.name ?? '')
    .replace(/\{\{\s*campaign\s*\}\}/gi, vars.campaign ?? '')
    .replace(/\{\{\s*venue\s*\}\}/gi, vars.venue ?? '')
    .replace(/\{\{\s*url\s*\}\}/gi, vars.url ?? '')
    .replace(/\{\{\s*org\s*\}\}/gi, vars.org ?? '');
}

// ── POST /issue-batch — Create N distribution tickets (admin+) ──

distributionRouter.post(
  '/issue-batch',
  requireAuth,
  requireRole('staff', 'admin', 'super_admin'),
  async (req: Request, res: Response) => {
    try {
      const { campaignId, quantity, count, venueId, orgId, onePerIp, name: batchName, expiresAt, activatesAt, tags, notes } = req.body;
      const user = req.user!;
      const qty = quantity ?? count;

      if (!campaignId || typeof qty !== 'number' || qty < 1 || qty > 500) {
        throw new HttpError(400, 'campaignId required and quantity must be 1-500.');
      }

      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: { oddsProfile: true, venue: true },
      });
      if (!campaign) throw new HttpError(404, 'Campaign not found.');
      if (!campaign.isActive) throw new HttpError(400, 'Campaign is not active.');

      const effectiveOrgId = orgId ?? campaign.orgId ?? undefined;

      // Check quota for each ticket
      if (effectiveOrgId) {
        for (let i = 0; i < qty; i++) {
          await checkTicketQuota(effectiveOrgId);
        }
      }

      const gameType = (campaign.gameType ?? 'poker') as GameType;
      const oddsProfile = campaign.oddsProfile;
      const scratchLimit = oddsProfile.scratchLimit ?? GAME_ENGINES[gameType]?.scratchLimit ?? 7;

      // Create the DistributionBatch record first
      const finalBatchName = (typeof batchName === 'string' && batchName.trim())
        ? batchName.trim()
        : `${campaign.name} - ${new Date().toLocaleDateString()}`;
      const distBatch = await prisma.distributionBatch.create({
        data: {
          campaignId: campaign.id,
          venueId: campaign.venueId,
          orgId: effectiveOrgId ?? null,
          name: finalBatchName,
          quantity: qty,
          onePerIp: onePerIp === true,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          activatesAt: activatesAt ? new Date(activatesAt) : null,
          tags: Array.isArray(tags) ? JSON.stringify(tags) : '[]',
          notes: typeof notes === 'string' ? notes : null,
          issuedBy: user.id,
          status: 'active',
        },
      });

      const tickets: Array<{ ticketId: string; scratchUrl: string; claimCode: string }> = [];
      const batchId = distBatch.id;

      for (let i = 0; i < qty; i++) {
        const claimCode = generateClaimCode();
        const claimCodeHash = hashClaimCode(claimCode);

        let deck: string[];
        if (gameType === 'poker' || gameType === 'poker_pick') {
          deck = buildShuffledDeck();
        } else {
          const engine = GAME_ENGINES[gameType];
          if (!engine) throw new HttpError(400, `Unknown game type: ${gameType}`);
          deck = engine.buildDeck();
        }

        const ticket = await prisma.ticket.create({
          data: {
            venueId: campaign.venueId,
            campaignId: campaign.id,
            orgId: effectiveOrgId ?? null,
            deck: JSON.stringify(deck),
            revealedCardIds: '[]',
            scratchLimit,
            gameType,
            status: 'issued',
            claimCodeHash,
            allowAnonymous: true, // distribution tickets always allow anonymous claims
            onePerIp: onePerIp === true,
            distributionBatch: true,
            distributionBatchId: batchId,
            issuedBy: user.id,
          },
        });

        const scratchUrl = `${APP_URL}/scratch/${ticket.id}`;
        tickets.push({ ticketId: ticket.id, scratchUrl, claimCode });
      }

      await writeAuditLog({
        actorUserId: user.id,
        actorRole: user.role,
        actionType: 'distribution_batch_issued',
        targetType: 'campaign',
        targetId: campaignId,
        venueId: campaign.venueId,
        details: { quantity: qty, campaignId, gameType },
      });

      io.to(`venue:${campaign.venueId}`).emit('distribution:batch-issued', {
        campaignId,
        count: qty,
        issuedBy: user.id,
      });

      res.json({ tickets, batchId, batchName: finalBatchName, batch: distBatch });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[distribution] issue-batch error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── POST /public-ticket — Get ticket display data (NO AUTH) ──

distributionRouter.post('/public-ticket', async (req: Request, res: Response) => {
  try {
    const { ticketId } = req.body;
    const validId = validateTicketId(ticketId);

    checkRateLimit(`public-ticket:${validId}`, 30);

    const ticket = await prisma.ticket.findUnique({
      where: { id: validId },
      include: {
        campaign: { include: { oddsProfile: true } },
        venue: true,
      },
    });

    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    if (!ticket.distributionBatch) throw new HttpError(403, 'Not a distribution ticket.');

    // Look up batch for time-window info
    const batchInfo = ticket.distributionBatchId
      ? await prisma.distributionBatch.findUnique({ where: { id: ticket.distributionBatchId } })
      : null;
    const notActiveUntil = batchInfo?.activatesAt && batchInfo.activatesAt > new Date()
      ? batchInfo.activatesAt.toISOString()
      : null;

    // Delivery tracking: mark as opened/scratched when ticket is loaded
    if (ticket.distributionBatchId) {
      void prisma.deliveryLog.updateMany({
        where: { ticketId: ticket.id, openedAt: null },
        data: { openedAt: new Date(), status: 'opened' },
      }).catch(() => {});
    }

    const revealedCardIds = (typeof ticket.revealedCardIds === 'string' ? JSON.parse(ticket.revealedCardIds) : ticket.revealedCardIds) as string[];

    const deck = (typeof ticket.deck === 'string' ? JSON.parse(ticket.deck) : ticket.deck) as string[];

    res.json({
      ticketId: ticket.id,
      status: ticket.status,
      gameType: ticket.gameType,
      scratchLimit: ticket.scratchLimit,
      deckSize: deck.length,
      revealedCardIds,
      isFrozen: ticket.isFrozen,
      freezeReason: ticket.freezeReason,
      allowAnonymous: ticket.allowAnonymous,
      prizeSnapshot: typeof ticket.prizeSnapshot === 'string' ? JSON.parse(ticket.prizeSnapshot) : ticket.prizeSnapshot,
      bestHandAtScratch: ticket.bestHandAtScratch,
      campaign: {
        id: ticket.campaign.id,
        name: ticket.campaign.name,
        description: ticket.campaign.description,
        gameType: ticket.campaign.gameType,
        guidelines: ticket.campaign.guidelines,
        guidelinesRequired: ticket.campaign.guidelinesRequired,
      },
      venue: {
        id: ticket.venue.id,
        name: ticket.venue.name,
      },
      oddsProfile: {
        prizes: typeof ticket.campaign.oddsProfile.prizes === 'string' ? JSON.parse(ticket.campaign.oddsProfile.prizes) : ticket.campaign.oddsProfile.prizes,
        scratchLimit: ticket.campaign.oddsProfile.scratchLimit,
      },
      notActiveUntil,
      expiresAt: batchInfo?.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[distribution] public-ticket error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /anonymous-claim — Submit an anonymous claim (NO AUTH) ──

distributionRouter.post('/anonymous-claim', async (req: Request, res: Response) => {
  try {
    const { ticketId, claimCode, playerEmail, playerName, playerPhone } = req.body;
    const validId = validateTicketId(ticketId);

    checkRateLimit(`anon-claim:${validId}`, 5);

    if (!playerName || typeof playerName !== 'string' || playerName.trim().length < 2) {
      throw new HttpError(400, 'Name is required (at least 2 characters).');
    }
    if (!playerEmail || typeof playerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(playerEmail)) {
      throw new HttpError(400, 'A valid email address is required.');
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: validId },
      include: { campaign: { include: { oddsProfile: true } } },
    });

    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    if (!ticket.distributionBatch) throw new HttpError(403, 'Not a distribution ticket.');
    if (!ticket.allowAnonymous) throw new HttpError(403, 'Anonymous claims not allowed for this ticket.');
    if (ticket.isFrozen) throw new HttpError(403, 'Ticket is frozen.');
    if (ticket.status !== 'finalized') throw new HttpError(400, 'Ticket must be finalized before claiming.');

    // IP lock check: only the original player can claim
    const clientIp = getClientIp(req);
    if (!ticket.lockedIp) {
      // Ticket was never scratched — lock to this IP now
      await prisma.ticket.update({ where: { id: validId }, data: { lockedIp: clientIp } });
    } else if (ticket.lockedIp !== clientIp) {
      throw new HttpError(403, 'This ticket is locked to another player.');
    }

    // Skip claim code verification for distribution tickets — IP lock is sufficient
    // The player already proved ownership by scratching from the same IP

    // Check if claim already exists
    const existingClaim = await prisma.claim.findUnique({ where: { ticketId: validId } });
    if (existingClaim) throw new HttpError(409, 'A claim has already been submitted for this ticket.');

    const prizeSnapshot = typeof ticket.prizeSnapshot === 'string' ? JSON.parse(ticket.prizeSnapshot) : ticket.prizeSnapshot;
    // Allow claims for item prizes (prizeAmount=0 but prizeLabel is set)
    const hasWinningPrize = prizeSnapshot && (
      prizeSnapshot.prizeAmount > 0 ||
      (prizeSnapshot.prizeLabel && prizeSnapshot.prizeLabel !== 'No prize' && prizeSnapshot.prizeLabel !== prizeSnapshot.handRank)
    );
    if (!hasWinningPrize) {
      throw new HttpError(400, 'This ticket has no prize to claim.');
    }

    const claim = await prisma.claim.create({
      data: {
        id: validId,
        ticketId: validId,
        playerId: null,
        venueId: ticket.venueId,
        campaignId: ticket.campaignId,
        orgId: ticket.orgId,
        prizeSnapshot: JSON.stringify(prizeSnapshot),
        status: 'pending_staff_approval',
        isAnonymous: true,
        playerEmail: playerEmail ?? null,
        playerName: playerName ?? null,
        playerPhone: playerPhone ?? null,
      },
    });

    await prisma.ticket.update({
      where: { id: validId },
      data: {
        status: 'claimed',
        claimSubmittedAt: new Date(),
        anonymousPlayer: JSON.stringify({
          email: playerEmail ?? null,
          name: playerName ?? null,
          phone: playerPhone ?? null,
        }),
      },
    });

    io.to(`venue:${ticket.venueId}`).emit('claim:submitted', {
      ticketId: validId,
      claimId: claim.id,
      isAnonymous: true,
    });

    res.json({ claimId: claim.id, status: claim.status });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[distribution] anonymous-claim error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /public-reveal — Reveal a card on a distribution ticket (NO AUTH, deck-order enforced) ──

distributionRouter.post('/public-reveal', async (req: Request, res: Response) => {
  try {
    const { ticketId } = req.body;
    const validId = validateTicketId(ticketId);

    checkRateLimit(`public-reveal:${validId}`, 20);

    const ticket = await prisma.ticket.findUnique({
      where: { id: validId },
    });

    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    if (!ticket.distributionBatch) throw new HttpError(403, 'Not a distribution ticket.');
    if (ticket.isFrozen) throw new HttpError(403, 'Ticket is frozen.');
    if (ticket.status === 'finalized' || ticket.status === 'claimed' || ticket.status === 'expired') {
      throw new HttpError(400, `Ticket is already ${ticket.status}.`);
    }

    // Time-window enforcement: check batch.activatesAt
    if (ticket.distributionBatchId) {
      const batchRow = await prisma.distributionBatch.findUnique({ where: { id: ticket.distributionBatchId } });
      if (batchRow?.activatesAt && batchRow.activatesAt > new Date()) {
        throw new HttpError(403, `This ticket is not yet active. Available at ${batchRow.activatesAt.toISOString()}`);
      }
    }

    // Delivery tracking: mark as scratched on first reveal
    if (ticket.distributionBatchId) {
      void prisma.deliveryLog.updateMany({
        where: { ticketId: ticket.id, scratchedAt: null },
        data: { scratchedAt: new Date(), status: 'scratched' },
      }).catch(() => {});
    }

    // IP lock: bind ticket to first player's IP (atomic to prevent race condition)
    const clientIp = getClientIp(req);
    if (ticket.lockedIp && ticket.lockedIp !== clientIp) {
      throw new HttpError(403, 'This ticket is already in use by another player.');
    }
    if (!ticket.lockedIp) {
      // One-per-IP check: if enabled, reject if this IP already used another ticket in the same batch
      if (ticket.onePerIp && ticket.distributionBatchId) {
        const existing = await prisma.ticket.findFirst({
          where: {
            distributionBatchId: ticket.distributionBatchId,
            lockedIp: clientIp,
            id: { not: validId },
          },
        });
        if (existing) {
          throw new HttpError(403, 'You have already used a ticket from this batch. One per person.');
        }
      }
      // Atomic lock: only update if still null (prevents race condition)
      const lockResult = await prisma.ticket.updateMany({
        where: { id: validId, lockedIp: null },
        data: { lockedIp: clientIp },
      });
      // If no rows updated, someone else locked it first — re-check
      if (lockResult.count === 0) {
        const rechecked = await prisma.ticket.findUnique({ where: { id: validId } });
        if (rechecked?.lockedIp && rechecked.lockedIp !== clientIp) {
          throw new HttpError(403, 'This ticket is already in use by another player.');
        }
      }
    }

    const deck = (typeof ticket.deck === 'string' ? JSON.parse(ticket.deck) : ticket.deck) as string[];
    const revealedCardIds = (typeof ticket.revealedCardIds === 'string' ? JSON.parse(ticket.revealedCardIds) : ticket.revealedCardIds) as string[];

    if (revealedCardIds.length >= ticket.scratchLimit) {
      throw new HttpError(400, 'All cards have been revealed.');
    }

    // For poker_pick: player chooses a card index from the full deck
    // For all other types: sequential deck order
    const gameType = (ticket.gameType ?? 'poker') as GameType;
    const { cardIndex } = req.body as { cardIndex?: number };
    let nextCard: string;

    if (gameType === 'poker_pick' && cardIndex !== undefined) {
      if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= deck.length) {
        throw new HttpError(400, 'Invalid card index.');
      }
      nextCard = deck[cardIndex];
      if (revealedCardIds.includes(nextCard)) {
        throw new HttpError(400, 'Card already revealed.');
      }
    } else {
      nextCard = deck[revealedCardIds.length];
    }
    if (!nextCard) throw new HttpError(400, 'No more cards to reveal.');

    const newRevealed = [...revealedCardIds, nextCard];
    const isComplete = newRevealed.length >= ticket.scratchLimit;

    // Update ticket with new reveal
    const updateData: any = {
      revealedCardIds: JSON.stringify(newRevealed),
      status: ticket.status === 'issued' ? 'in_progress' : ticket.status,
    };

    // If all cards revealed, compute best hand at scratch
    if (isComplete) {
      const gameType = (ticket.gameType ?? 'poker') as GameType;
      let bestHandAtScratch: any;

      if (gameType === 'poker' || gameType === 'poker_pick') {
        const handResult = evaluateBestHand(newRevealed);
        bestHandAtScratch = {
          handRank: handResult.handRank,
          handValue: handResult.handValue,
          bestCards: handResult.bestCards,
          description: handResult.description,
        };
      } else {
        const engine = GAME_ENGINES[gameType];
        if (engine) {
          const result = engine.evaluate(newRevealed);
          bestHandAtScratch = {
            handRank: result.tierName,
            handValue: result.tierValue,
            bestCards: result.displayItems,
            description: result.description,
          };
        }
      }

      updateData.bestHandAtScratch = bestHandAtScratch ?? null;
    }

    await prisma.ticket.update({
      where: { id: validId },
      data: updateData,
    });

    io.to(`ticket:${validId}`).emit('card:revealed', {
      ticketId: validId,
      cardId: nextCard,
      revealIndex: newRevealed.length - 1,
      isComplete,
    });

    res.json({
      cardId: nextCard,
      revealIndex: newRevealed.length - 1,
      revealedCardIds: newRevealed,
      isComplete,
      bestHandAtScratch: isComplete ? updateData.bestHandAtScratch : undefined,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[distribution] public-reveal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /public-finalize — Finalize a distribution ticket and evaluate result (NO AUTH) ──

distributionRouter.post('/public-finalize', async (req: Request, res: Response) => {
  try {
    const { ticketId } = req.body;
    const validId = validateTicketId(ticketId);

    checkRateLimit(`public-finalize:${validId}`, 5);

    const ticket = await prisma.ticket.findUnique({
      where: { id: validId },
      include: { campaign: { include: { oddsProfile: true } } },
    });

    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    if (!ticket.distributionBatch) throw new HttpError(403, 'Not a distribution ticket.');
    if (ticket.isFrozen) throw new HttpError(403, 'Ticket is frozen.');

    // IP lock check
    const clientIp = getClientIp(req);
    if (ticket.lockedIp && ticket.lockedIp !== clientIp) {
      throw new HttpError(403, 'This ticket is already in use by another player.');
    }

    if (ticket.status === 'finalized' || ticket.status === 'claimed') {
      throw new HttpError(400, `Ticket is already ${ticket.status}.`);
    }

    const revealedCardIds = (typeof ticket.revealedCardIds === 'string' ? JSON.parse(ticket.revealedCardIds) : ticket.revealedCardIds) as string[];
    if (revealedCardIds.length < ticket.scratchLimit) {
      throw new HttpError(400, `Must reveal all ${ticket.scratchLimit} cards before finalizing.`);
    }

    const gameType = (ticket.gameType ?? 'poker') as GameType;
    const rawOddsProfile = ticket.campaign.oddsProfile;
    const oddsProfile = {
      ...rawOddsProfile,
      prizes: typeof rawOddsProfile.prizes === 'string' ? JSON.parse(rawOddsProfile.prizes) : rawOddsProfile.prizes,
    };
    let prizeSnapshot: any;

    if (gameType === 'poker' || gameType === 'poker_pick') {
      const handResult = evaluateBestHand(revealedCardIds);
      prizeSnapshot = buildPrizeSnapshot(handResult, oddsProfile as any);
    } else {
      const engine = GAME_ENGINES[gameType];
      if (!engine) throw new HttpError(400, `Unknown game type: ${gameType}`);
      const result = engine.evaluate(revealedCardIds);
      prizeSnapshot = buildGamePrizeSnapshot(result, oddsProfile as GenericOddsProfile);
    }

    await prisma.ticket.update({
      where: { id: validId },
      data: {
        status: 'finalized',
        prizeSnapshot: JSON.stringify(prizeSnapshot),
        finalizedAt: new Date(),
      },
    });

    io.to(`ticket:${validId}`).emit('ticket:finalized', {
      ticketId: validId,
      prizeSnapshot,
    });

    io.to(`venue:${ticket.venueId}`).emit('ticket:finalized', {
      ticketId: validId,
      prizeSnapshot,
    });

    // For poker_pick: include full deck so frontend can reveal all 52 cards after finalize
    const fullDeck = gameType === 'poker_pick'
      ? (typeof ticket.deck === 'string' ? JSON.parse(ticket.deck) : ticket.deck) as string[]
      : undefined;
    res.json({ ticketId: validId, prizeSnapshot, fullDeck });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[distribution] public-finalize error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── BATCH MANAGEMENT ENDPOINTS ────────────────────────────────

distributionRouter.get('/batches', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, campaignId, tag, includeArchived } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (orgId) where.orgId = orgId;
    else if (user.orgId) where.orgId = user.orgId;
    if (campaignId) where.campaignId = campaignId;
    if (includeArchived !== 'true') where.archived = false;

    const batches = await prisma.distributionBatch.findMany({ where, orderBy: { issuedAt: 'desc' }, take: 500 });

    // Filter by tag client-side (SQLite doesn't support JSON contains)
    const filtered = tag
      ? batches.filter(b => {
          try { return (JSON.parse(b.tags) as string[]).includes(tag); } catch { return false; }
        })
      : batches;

    const batchIds = filtered.map(b => b.id);
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: { in: batchIds } },
      select: { distributionBatchId: true, status: true },
    });
    const stats: Record<string, Record<string, number>> = {};
    for (const t of tickets) {
      const bid = t.distributionBatchId!;
      if (!stats[bid]) stats[bid] = { issued: 0, in_progress: 0, finalized: 0, claimed: 0, redeemed: 0, frozen: 0 };
      const s = (t.status === 'pending_staff_approval' || t.status === 'approved') ? 'claimed' : t.status;
      stats[bid][s] = (stats[bid][s] ?? 0) + 1;
    }

    // Cost stats: count delivery logs per batch by channel
    const logs = await prisma.deliveryLog.groupBy({
      by: ['batchId', 'channel'],
      where: { batchId: { in: batchIds }, status: { in: ['sent', 'delivered', 'opened', 'scratched'] } },
      _count: { _all: true },
    });
    const costs: Record<string, { emailCount: number; smsCount: number; estimatedCostCents: number }> = {};
    for (const l of logs) {
      if (!costs[l.batchId]) costs[l.batchId] = { emailCount: 0, smsCount: 0, estimatedCostCents: 0 };
      if (l.channel === 'email') costs[l.batchId].emailCount = l._count._all;
      if (l.channel === 'sms') costs[l.batchId].smsCount = l._count._all;
    }
    for (const k of Object.keys(costs)) {
      // $0.0006/email, $0.0075/sms => 0.06 cents per email, 0.75 cents per SMS
      costs[k].estimatedCostCents = Math.round(costs[k].emailCount * 0.06 + costs[k].smsCount * 0.75);
    }

    res.json(filtered.map(b => ({
      ...b,
      tags: typeof b.tags === 'string' ? (() => { try { return JSON.parse(b.tags); } catch { return []; } })() : b.tags,
      stats: stats[b.id] ?? { issued: 0, in_progress: 0, finalized: 0, claimed: 0, redeemed: 0, frozen: 0 },
      cost: costs[b.id] ?? { emailCount: 0, smsCount: 0, estimatedCostCents: 0 },
    })));
  } catch (err) {
    console.error('[distribution] list batches error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.get('/batches/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: batch.id },
      select: {
        id: true, status: true, isFrozen: true, lockedIp: true,
        revealedCardIds: true, prizeSnapshot: true,
        createdAt: true, finalizedAt: true, claimSubmittedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
    const venue = await prisma.venue.findUnique({ where: { id: batch.venueId } });
    res.json({
      batch: {
        ...batch,
        tags: typeof batch.tags === 'string' ? (() => { try { return JSON.parse(batch.tags); } catch { return []; } })() : batch.tags,
      },
      campaign, venue,
      tickets: tickets.map(t => ({
        ...t,
        scratchUrl: `${APP_URL}/scratch/${t.id}`,
        prizeSnapshot: typeof t.prizeSnapshot === 'string' ? JSON.parse(t.prizeSnapshot) : t.prizeSnapshot,
        revealedCount: (typeof t.revealedCardIds === 'string' ? JSON.parse(t.revealedCardIds) : t.revealedCardIds)?.length ?? 0,
      })),
    });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] get batch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/batches/:id/void', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    if (batch.status === 'voided') throw new HttpError(400, 'Batch already voided.');
    const result = await prisma.ticket.updateMany({
      where: { distributionBatchId: batch.id, status: { in: ['issued', 'in_progress'] } },
      data: { isFrozen: true, freezeReason: 'Batch voided by admin' },
    });
    await prisma.distributionBatch.update({
      where: { id: batch.id },
      data: { status: 'voided', voidedAt: new Date(), voidedBy: user.id },
    });
    await writeAuditLog({
      actorUserId: user.id, actorRole: user.role,
      actionType: 'distribution_batch_voided',
      targetType: 'distribution_batch', targetId: batch.id,
      details: { ticketsFrozen: result.count, batchName: batch.name },
    });
    res.json({ success: true, ticketsFrozen: result.count });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] void batch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.get('/batches/:id/csv', requireAuth, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: batch.id },
      select: { id: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const rows = ['scratchUrl,status,issuedAt'];
    for (const t of tickets) rows.push(`${APP_URL}/scratch/${t.id},${t.status},${t.createdAt.toISOString()}`);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.id}.csv"`);
    res.send(rows.join('\n'));
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Layouts: grid10 (2x5, default), grid1 (1 per page big), grid20 (4x5 small),
// business_card (2x5 of 2"x3.5"), sticker_30 (3x10 of Avery 5160 1"x2.625")
const PDF_LAYOUTS: Record<string, { cols: number; rows: number; showFooter: boolean; showHeader: boolean; cellWidthIn: number; cellHeightIn: number }> = {
  grid10: { cols: 2, rows: 5, showFooter: true, showHeader: true, cellWidthIn: 4, cellHeightIn: 2.6 },
  grid1: { cols: 1, rows: 1, showFooter: true, showHeader: true, cellWidthIn: 7, cellHeightIn: 9 },
  grid20: { cols: 4, rows: 5, showFooter: true, showHeader: true, cellWidthIn: 2, cellHeightIn: 1.8 },
  business_card: { cols: 2, rows: 5, showFooter: false, showHeader: false, cellWidthIn: 3.5, cellHeightIn: 2 },
  sticker_30: { cols: 3, rows: 10, showFooter: false, showHeader: false, cellWidthIn: 2.625, cellHeightIn: 1 },
};

distributionRouter.get('/batches/:id/pdf', requireAuth, async (req: Request, res: Response) => {
  try {
    const PDFDocument = (await import('pdfkit')).default;
    const QRCode = await import('qrcode');
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: batch.id },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
    const venue = await prisma.venue.findUnique({ where: { id: batch.venueId } });

    const layoutKey = (req.query.layout as string) ?? 'grid10';
    const layout = PDF_LAYOUTS[layoutKey] ?? PDF_LAYOUTS.grid10;
    const PT_PER_IN = 72;

    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.id}-${layoutKey}.pdf"`);
    doc.pipe(res);

    let headerHeight = 0;
    if (layout.showHeader) {
      doc.fontSize(20).font('Helvetica-Bold').text(batch.name, { align: 'center' });
      doc.fontSize(11).font('Helvetica').text(`${campaign?.name ?? ''} - ${venue?.name ?? ''}`, { align: 'center' });
      doc.fontSize(9).text(`${tickets.length} tickets - Issued ${batch.issuedAt.toLocaleDateString()}`, { align: 'center' });
      doc.moveDown(1);
      headerHeight = 90;
    }

    const cellW = layout.cellWidthIn * PT_PER_IN;
    const cellH = layout.cellHeightIn * PT_PER_IN;
    const pageW = 612, pageH = 792;
    const usableW = layout.cols * cellW;
    const startX = (pageW - usableW) / 2;

    let i = 0;
    for (const ticket of tickets) {
      const perPage = layout.cols * layout.rows;
      const idx = i % perPage;
      const col = idx % layout.cols;
      const row = Math.floor(idx / layout.cols);

      if (i > 0 && idx === 0) {
        doc.addPage();
        if (layout.showHeader) {
          doc.fontSize(14).font('Helvetica-Bold').text(batch.name, { align: 'center' });
          doc.moveDown(0.5);
        }
      }

      const startY = (i < perPage && layout.showHeader) ? headerHeight + 36 : 36;
      const x = startX + col * cellW;
      const y = startY + row * cellH;

      doc.rect(x, y, cellW - 6, cellH - 6).stroke('#aaaaaa');

      const longUrl = `${APP_URL}/scratch/${ticket.id}`;
      const shortUrl = await getOrCreateShortUrl(longUrl);
      const qrTarget = layoutKey === 'sticker_30' || layoutKey === 'business_card' ? shortUrl : longUrl;
      const qrDataUrl = await QRCode.toDataURL(qrTarget, { width: 300, margin: 1 });
      const qrSize = Math.min(cellW - 16, cellH - (layout.showFooter ? 36 : 16));
      doc.image(Buffer.from(qrDataUrl.split(',')[1], 'base64'),
        x + (cellW - qrSize) / 2, y + 6, { width: qrSize });

      if (layout.showFooter) {
        const labelY = y + qrSize + 8;
        doc.fontSize(layoutKey === 'grid20' ? 7 : 9).font('Helvetica-Bold').text(
          `Ticket #${i + 1}`, x + 4, labelY,
          { width: cellW - 8, align: 'center' }
        );
        doc.fontSize(layoutKey === 'grid20' ? 6 : 7).font('Helvetica').fillColor('#666').text(
          shortUrl.replace(/^https?:\/\//, ''), x + 4, labelY + (layoutKey === 'grid20' ? 8 : 12),
          { width: cellW - 8, align: 'center' }
        );
        doc.fillColor('#000');
      }
      i++;
    }
    doc.end();
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] pdf error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared executor for email/SMS sends. Creates DeliveryLog rows + throttles.
async function executeDelivery(params: {
  batchId: string;
  channel: 'email' | 'sms';
  recipients: Array<{ email?: string; phone?: string; name?: string }>;
  recipientListId?: string;
  customSmsTemplate?: string; // optional template override with merge tags
  customEmailSubject?: string;
  customEmailBody?: string;
}) {
  const { batchId, channel, recipients, recipientListId, customSmsTemplate, customEmailSubject, customEmailBody } = params;
  const batch = await prisma.distributionBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Batch not found.');

  const tickets = await prisma.ticket.findMany({
    where: { distributionBatchId: batch.id, status: 'issued', isFrozen: false },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: recipients.length,
  });
  if (tickets.length < recipients.length) {
    throw new HttpError(400, `Only ${tickets.length} unscratched tickets available.`);
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
  const org = batch.orgId ? await prisma.organization.findUnique({ where: { id: batch.orgId } }) : null;

  let sent = 0, failed = 0;
  let twilioClient: any = null;
  if (channel === 'sms') {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      throw new HttpError(503, 'SMS not configured.');
    }
    twilioClient = (await import('twilio')).default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }

  const { sendDistributionTicketEmail } = await import('../lib/email.js');

  const venue = await prisma.venue.findUnique({ where: { id: batch.venueId } });

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const t = tickets[i];
    const contact = (channel === 'email' ? r.email : r.phone) ?? '';
    const longUrl = `${APP_URL}/scratch/${t.id}`;
    const shortUrl = await getOrCreateShortUrl(longUrl);
    const firstName = (r.name ?? '').trim().split(/\s+/)[0] ?? '';
    const mergeVars = {
      firstName,
      name: r.name ?? '',
      campaign: campaign?.name ?? 'Scratch Card',
      venue: venue?.name ?? '',
      url: shortUrl,
      org: org?.name ?? 'ScratchPoker',
    };

    // Create log row first
    const log = await prisma.deliveryLog.create({
      data: {
        batchId: batch.id, ticketId: t.id, channel,
        recipientName: r.name ?? null, recipientContact: contact,
        recipientListId: recipientListId ?? null,
        status: 'queued',
      },
    });

    try {
      if (channel === 'email') {
        // If custom subject/body provided, send directly with merge tags applied
        if (customEmailSubject || customEmailBody) {
          const sgKey = process.env.SENDGRID_API_KEY;
          if (sgKey) {
            const sgMail = (await import('@sendgrid/mail')).default;
            sgMail.setApiKey(sgKey);
            const FROM_EMAIL = process.env.FROM_EMAIL ?? 'noreply@scratchpoker.com';
            const FROM_NAME = process.env.FROM_NAME ?? 'ScratchPoker';
            await sgMail.send({
              to: { email: r.email ?? '', name: r.name || (r.email ?? '') },
              from: { email: FROM_EMAIL, name: org?.name ?? FROM_NAME },
              subject: applyMergeTags(customEmailSubject ?? `🎴 You have a scratch ticket from ${org?.name ?? 'ScratchPoker'}!`, mergeVars),
              html: applyMergeTags(customEmailBody ?? '', mergeVars),
              text: applyMergeTags(customEmailBody ?? '', mergeVars).replace(/<[^>]+>/g, ''),
            });
          }
        } else {
          await sendDistributionTicketEmail({
            toEmail: r.email ?? '',
            toName: r.name ?? '',
            scratchUrl: shortUrl,
            campaignName: campaign?.name ?? 'Scratch Card',
            orgName: org?.name ?? 'ScratchPoker',
            orgLogo: org?.logoUrl ?? null,
          });
        }
      } else {
        const defaultTpl = `{{firstName}}{{firstName? }}your scratch ticket: {{url}} - {{campaign}}`;
        const tpl = customSmsTemplate ?? `${r.name ? r.name + ', here is' : 'Here is'} your scratch ticket: {{url}} - {{campaign}}`;
        const msg = applyMergeTags(tpl, mergeVars);
        await twilioClient.messages.create({ to: r.phone!, from: process.env.TWILIO_PHONE_NUMBER!, body: msg });
      }
      await prisma.deliveryLog.update({
        where: { id: log.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      sent++;
    } catch (err: any) {
      await prisma.deliveryLog.update({
        where: { id: log.id },
        data: { status: 'failed', errorMessage: (err?.message ?? String(err)).slice(0, 500) },
      });
      failed++;
    }
  }
  return { sent, failed, total: recipients.length };
}

distributionRouter.post('/batches/:id/send-email', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { recipients, recipientListId, throttlePerMinute, delaySeconds, customEmailSubject, customEmailBody } = req.body as {
      recipients: Array<{ email: string; name?: string }>;
      recipientListId?: string;
      throttlePerMinute?: number;
      delaySeconds?: number;
      customEmailSubject?: string;
      customEmailBody?: string;
    };
    if (!Array.isArray(recipients) || recipients.length === 0) throw new HttpError(400, 'recipients required.');

    if ((delaySeconds && delaySeconds > 0) || (throttlePerMinute && recipients.length > throttlePerMinute)) {
      const scheduledFor = new Date(Date.now() + (delaySeconds ?? 0) * 1000);
      const job = await prisma.scheduledDelivery.create({
        data: {
          batchId: req.params.id,
          payload: JSON.stringify({ channel: 'email', recipients, recipientListId, throttlePerMinute, customEmailSubject, customEmailBody }),
          scheduledFor, createdBy: user.id, status: 'pending',
        },
      });
      res.json({ scheduled: true, jobId: job.id, scheduledFor, total: recipients.length });
      return;
    }

    const result = await executeDelivery({ batchId: req.params.id, channel: 'email', recipients, recipientListId, customEmailSubject, customEmailBody });
    res.json(result);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] send-email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/batches/:id/send-sms', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      throw new HttpError(503, 'SMS not configured.');
    }
    const { recipients, recipientListId, throttlePerMinute, delaySeconds, customSmsTemplate } = req.body as {
      recipients: Array<{ phone: string; name?: string }>;
      recipientListId?: string;
      throttlePerMinute?: number;
      delaySeconds?: number;
      customSmsTemplate?: string;
    };
    if (!Array.isArray(recipients) || recipients.length === 0) throw new HttpError(400, 'recipients required.');

    if ((delaySeconds && delaySeconds > 0) || (throttlePerMinute && recipients.length > throttlePerMinute)) {
      const scheduledFor = new Date(Date.now() + (delaySeconds ?? 0) * 1000);
      const job = await prisma.scheduledDelivery.create({
        data: {
          batchId: req.params.id,
          payload: JSON.stringify({ channel: 'sms', recipients, recipientListId, throttlePerMinute, customSmsTemplate }),
          scheduledFor, createdBy: user.id, status: 'pending',
        },
      });
      res.json({ scheduled: true, jobId: job.id, scheduledFor, total: recipients.length });
      return;
    }

    const result = await executeDelivery({ batchId: req.params.id, channel: 'sms', recipients, recipientListId, customSmsTemplate });
    res.json(result);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] send-sms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export for cron jobs
export { executeDelivery };

// ── DISTRIBUTION TEMPLATES ────────────────────────────────

distributionRouter.get('/templates', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId } = req.query as Record<string, string>;
    const finalOrgId = orgId ?? user.orgId;
    if (!finalOrgId) { res.json([]); return; }
    const templates = await prisma.distributionTemplate.findMany({
      where: { orgId: finalOrgId }, orderBy: { createdAt: 'desc' },
    });
    res.json(templates);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/templates', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, campaignId, venueId, quantity, onePerIp, orgId } = req.body;
    if (!name) throw new HttpError(400, 'Template name required.');
    const tmpl = await prisma.distributionTemplate.create({
      data: {
        orgId: orgId ?? user.orgId ?? '',
        name, campaignId: campaignId ?? null, venueId: venueId ?? null,
        quantity: quantity ?? 10, onePerIp: onePerIp === true, createdBy: user.id,
      },
    });
    res.json(tmpl);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.delete('/templates/:id', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    await prisma.distributionTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELIVERY TRACKING, PREVIEW, UNDO, RESEND ─────────────

// POST /batches/:id/send-preview — returns rendered content without sending
distributionRouter.post('/batches/:id/send-preview', requireAuth, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const { channel, recipient } = req.body as { channel: 'email' | 'sms'; recipient?: { email?: string; phone?: string; name?: string } };

    const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
    const org = batch.orgId ? await prisma.organization.findUnique({ where: { id: batch.orgId } }) : null;
    const exampleUrl = `${APP_URL}/scratch/EXAMPLE`;
    const name = recipient?.name ?? 'Alice';

    if (channel === 'sms') {
      const msg = `${name ? name + ', here is' : 'Here is'} your scratch ticket: ${exampleUrl} - ${campaign?.name ?? 'ScratchPoker'}`;
      res.json({ channel: 'sms', preview: msg, charCount: msg.length });
      return;
    }

    // Email preview — render the full HTML
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      ${org?.logoUrl ? `<div style="text-align:center;margin-bottom:16px"><img src="${org.logoUrl}" alt="${org.name}" style="max-height:60px"/></div>` : ''}
      <h2 style="text-align:center">You have a scratch ticket!</h2>
      <p>Hi ${name},</p>
      <p><strong>${org?.name ?? 'ScratchPoker'}</strong> sent you a scratch ticket for <strong>${campaign?.name ?? 'Scratch Card'}</strong>.</p>
      <p>Tap the button below to scratch your card and see if you've won!</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${exampleUrl}" style="display:inline-block;background:#3fb950;color:#000;padding:16px 36px;border-radius:8px;font-weight:700;text-decoration:none;font-size:18px">
          🎴 Scratch Your Card
        </a>
      </div>
      <p style="font-size:12px;color:#666">This ticket is one-time use. Don't share the link.</p>
    </div>`;
    res.json({
      channel: 'email',
      subject: `🎴 You have a scratch ticket from ${org?.name ?? 'ScratchPoker'}!`,
      html,
      text: `Hi ${name},\n\n${org?.name ?? 'ScratchPoker'} sent you a scratch ticket for ${campaign?.name ?? 'Scratch Card'}.\n\nTap to play: ${exampleUrl}\n\nThis ticket is one-time use - don't share the link.`,
    });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /delivery-jobs/:id/cancel — cancel a scheduled send (undo)
distributionRouter.post('/delivery-jobs/:id/cancel', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const job = await prisma.scheduledDelivery.findUnique({ where: { id: req.params.id } });
    if (!job) throw new HttpError(404, 'Job not found.');
    if (job.status !== 'pending') throw new HttpError(400, `Cannot cancel job in status: ${job.status}`);
    await prisma.scheduledDelivery.update({
      where: { id: req.params.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /batches/:id/send-to-failed — resend to recipients that failed or bounced
distributionRouter.post('/batches/:id/send-to-failed', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');

    const failedLogs = await prisma.deliveryLog.findMany({
      where: { batchId: batch.id, status: { in: ['failed', 'bounced'] } },
      orderBy: { createdAt: 'desc' },
    });

    // Dedupe by recipientContact — keep most recent
    const seen = new Set<string>();
    const uniqueFailed = failedLogs.filter(log => {
      if (seen.has(log.recipientContact)) return false;
      seen.add(log.recipientContact);
      return true;
    });

    if (uniqueFailed.length === 0) {
      res.json({ sent: 0, failed: 0, total: 0, message: 'No failed deliveries to resend.' });
      return;
    }

    // Group by channel
    const emailRecipients = uniqueFailed
      .filter(l => l.channel === 'email')
      .map(l => ({ email: l.recipientContact, name: l.recipientName ?? undefined }));
    const smsRecipients = uniqueFailed
      .filter(l => l.channel === 'sms')
      .map(l => ({ phone: l.recipientContact, name: l.recipientName ?? undefined }));

    let totalSent = 0, totalFailed = 0;
    if (emailRecipients.length > 0) {
      const r = await executeDelivery({ batchId: batch.id, channel: 'email', recipients: emailRecipients });
      totalSent += r.sent; totalFailed += r.failed;
    }
    if (smsRecipients.length > 0 && process.env.TWILIO_ACCOUNT_SID) {
      const r = await executeDelivery({ batchId: batch.id, channel: 'sms', recipients: smsRecipients });
      totalSent += r.sent; totalFailed += r.failed;
    }
    res.json({ sent: totalSent, failed: totalFailed, total: uniqueFailed.length });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] resend-failed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /batches/:id/delivery-log — list all delivery attempts for a batch
distributionRouter.get('/batches/:id/delivery-log', requireAuth, async (req: Request, res: Response) => {
  try {
    const logs = await prisma.deliveryLog.findMany({
      where: { batchId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /check-duplicates — check for duplicates in a recipient list + already-sent
distributionRouter.post('/check-duplicates', requireAuth, async (req: Request, res: Response) => {
  try {
    const { campaignId, channel, recipients } = req.body as {
      campaignId?: string;
      channel: 'email' | 'sms';
      recipients: Array<{ email?: string; phone?: string; name?: string }>;
    };

    // Find duplicates within the list itself
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of recipients) {
      const contact = (channel === 'email' ? r.email : r.phone)?.toLowerCase().trim();
      if (!contact) continue;
      if (seen.has(contact)) dupes.push(contact);
      else seen.add(contact);
    }

    // Find recipients who already got a ticket from this campaign
    let alreadySent: string[] = [];
    if (campaignId) {
      const contacts = Array.from(seen);
      const prior = await prisma.deliveryLog.findMany({
        where: {
          channel,
          recipientContact: { in: contacts },
          status: { in: ['sent', 'delivered', 'opened', 'scratched'] },
          batchId: { in: (await prisma.distributionBatch.findMany({ where: { campaignId }, select: { id: true } })).map(b => b.id) },
        },
        select: { recipientContact: true },
      });
      alreadySent = [...new Set(prior.map(p => p.recipientContact))];
    }

    res.json({ duplicates: dupes, alreadySent });
  } catch (err: any) {
    console.error('[distribution] check-duplicates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RECIPIENT LISTS CRUD ──────────────────────────────────

distributionRouter.get('/recipient-lists', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId } = req.query as Record<string, string>;
    const finalOrgId = orgId ?? user.orgId;
    if (!finalOrgId) { res.json([]); return; }
    const lists = await prisma.recipientList.findMany({
      where: { orgId: finalOrgId }, orderBy: { updatedAt: 'desc' },
    });
    res.json(lists.map(l => ({
      ...l,
      recipients: typeof l.recipients === 'string' ? JSON.parse(l.recipients) : l.recipients,
      recipientCount: (typeof l.recipients === 'string' ? JSON.parse(l.recipients) : l.recipients).length,
    })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.get('/recipient-lists/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const list = await prisma.recipientList.findUnique({ where: { id: req.params.id } });
    if (!list) throw new HttpError(404, 'List not found.');
    res.json({
      ...list,
      recipients: typeof list.recipients === 'string' ? JSON.parse(list.recipients) : list.recipients,
    });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/recipient-lists', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, description, recipients, orgId } = req.body as {
      name: string; description?: string; recipients: any[]; orgId?: string;
    };
    if (!name || !name.trim()) throw new HttpError(400, 'name required.');
    if (!Array.isArray(recipients)) throw new HttpError(400, 'recipients must be an array.');
    const list = await prisma.recipientList.create({
      data: {
        orgId: orgId ?? user.orgId ?? '',
        name: name.trim(),
        description: description ?? null,
        recipients: JSON.stringify(recipients),
        createdBy: user.id,
      },
    });
    res.json(list);
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.put('/recipient-lists/:id', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, recipients } = req.body as {
      name?: string; description?: string; recipients?: any[];
    };
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (recipients !== undefined) data.recipients = JSON.stringify(recipients);
    const list = await prisma.recipientList.update({ where: { id: req.params.id }, data });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.delete('/recipient-lists/:id', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    await prisma.recipientList.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── NOTES & TAGS (#2) ─────────────────────────────────────

distributionRouter.post('/batches/:id/notes', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { notes } = req.body as { notes: string };
    const batch = await prisma.distributionBatch.update({
      where: { id: req.params.id },
      data: { notes: notes ?? null },
    });
    res.json({ success: true, batch });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/batches/:id/tags', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { tags } = req.body as { tags: string[] };
    if (!Array.isArray(tags)) throw new HttpError(400, 'tags must be an array.');
    const cleanTags = tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const batch = await prisma.distributionBatch.update({
      where: { id: req.params.id },
      data: { tags: JSON.stringify(cleanTags) },
    });
    res.json({ success: true, batch: { ...batch, tags: cleanTags } });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ARCHIVE (#8) ──────────────────────────────────────────

distributionRouter.post('/batches/:id/archive', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    await prisma.distributionBatch.update({
      where: { id: req.params.id },
      data: { archived: true, archivedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/batches/:id/unarchive', requireAuth, requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    await prisma.distributionBatch.update({
      where: { id: req.params.id },
      data: { archived: false, archivedAt: null },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── COMPARE BATCHES (#3) ──────────────────────────────────

distributionRouter.post('/batches/compare', requireAuth, async (req: Request, res: Response) => {
  try {
    const { batchIds } = req.body as { batchIds: string[] };
    if (!Array.isArray(batchIds) || batchIds.length === 0 || batchIds.length > 5) {
      throw new HttpError(400, 'batchIds must be an array of 1–5 IDs.');
    }
    const batches = await prisma.distributionBatch.findMany({ where: { id: { in: batchIds } } });
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: { in: batchIds } },
      select: { distributionBatchId: true, status: true },
    });
    const logs = await prisma.deliveryLog.groupBy({
      by: ['batchId', 'channel'],
      where: { batchId: { in: batchIds } },
      _count: { _all: true },
    });
    const campaigns = await prisma.campaign.findMany({ where: { id: { in: batches.map(b => b.campaignId) } } });
    const venues = await prisma.venue.findMany({ where: { id: { in: batches.map(b => b.venueId) } } });

    const result = batches.map(b => {
      const bTickets = tickets.filter(t => t.distributionBatchId === b.id);
      const stats = { issued: 0, in_progress: 0, finalized: 0, claimed: 0, redeemed: 0, frozen: 0 };
      for (const t of bTickets) {
        const s = (t.status === 'pending_staff_approval' || t.status === 'approved') ? 'claimed' : t.status;
        (stats as any)[s] = ((stats as any)[s] ?? 0) + 1;
      }
      const bLogs = logs.filter(l => l.batchId === b.id);
      const emailCount = bLogs.find(l => l.channel === 'email')?._count._all ?? 0;
      const smsCount = bLogs.find(l => l.channel === 'sms')?._count._all ?? 0;
      const finalized = stats.finalized + stats.claimed + stats.redeemed;
      const conversionRate = b.quantity > 0 ? finalized / b.quantity : 0;
      return {
        batch: { ...b, tags: typeof b.tags === 'string' ? (() => { try { return JSON.parse(b.tags); } catch { return []; } })() : b.tags },
        campaign: campaigns.find(c => c.id === b.campaignId),
        venue: venues.find(v => v.id === b.venueId),
        stats,
        delivery: { emailCount, smsCount, costCents: Math.round(emailCount * 0.06 + smsCount * 0.75) },
        conversionRate,
      };
    });

    res.json({ batches: result });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[distribution] compare error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── EXPORT BATCH ANALYTICS CSV (#4) ───────────────────────

distributionRouter.get('/batches/:id/analytics.csv', requireAuth, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.distributionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const tickets = await prisma.ticket.findMany({
      where: { distributionBatchId: batch.id },
      select: { id: true, status: true, isFrozen: true, lockedIp: true, createdAt: true, finalizedAt: true, claimSubmittedAt: true, prizeSnapshot: true },
    });
    const logs = await prisma.deliveryLog.findMany({
      where: { batchId: batch.id },
      orderBy: { createdAt: 'asc' },
    });
    const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
    const venue = await prisma.venue.findUnique({ where: { id: batch.venueId } });

    const totals = {
      issued: tickets.length,
      scratched: tickets.filter(t => t.lockedIp).length,
      finalized: tickets.filter(t => t.finalizedAt).length,
      claimed: tickets.filter(t => t.claimSubmittedAt).length,
    };
    const conv = totals.issued > 0 ? (totals.finalized / totals.issued * 100).toFixed(1) : '0';

    const rows: string[] = [];
    rows.push('# Batch Analytics Export');
    rows.push(`# Batch: ${batch.name}`);
    rows.push(`# Campaign: ${campaign?.name ?? ''}`);
    rows.push(`# Venue: ${venue?.name ?? ''}`);
    rows.push(`# Issued: ${batch.issuedAt.toISOString()}`);
    rows.push(`# Quantity: ${batch.quantity}`);
    rows.push(`# Status: ${batch.status}`);
    rows.push('');
    rows.push('# Funnel');
    rows.push(`Issued,${totals.issued}`);
    rows.push(`Scratched (IP locked),${totals.scratched}`);
    rows.push(`Finalized,${totals.finalized}`);
    rows.push(`Claims submitted,${totals.claimed}`);
    rows.push(`Conversion rate,${conv}%`);
    rows.push('');
    rows.push('# Delivery Log');
    rows.push('createdAt,channel,recipientName,recipientContact,status,sentAt,openedAt,scratchedAt,errorMessage');
    for (const l of logs) {
      const cell = (v: any) => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return /[,\n"]/.test(s) ? `"${s}"` : s;
      };
      rows.push([
        cell(l.createdAt.toISOString()), cell(l.channel), cell(l.recipientName),
        cell(l.recipientContact), cell(l.status),
        cell(l.sentAt?.toISOString() ?? ''), cell(l.openedAt?.toISOString() ?? ''),
        cell(l.scratchedAt?.toISOString() ?? ''), cell(l.errorMessage ?? ''),
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.id}-analytics.csv"`);
    res.send(rows.join('\n'));
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── FULFILLMENT LABELS (#10) ─────────────────────────────

distributionRouter.get('/orgs/:orgId/fulfillment-claims', requireAuth, async (req: Request, res: Response) => {
  try {
    const claims = await prisma.claim.findMany({
      where: { orgId: req.params.orgId, status: { in: ['approved', 'redeemed'] } },
      orderBy: { reviewedAt: 'desc' },
      take: 500,
    });
    // Filter to only item prizes (prizeAmount = 0 or has shipping address)
    const itemClaims = claims.filter(c => {
      try {
        const ps = typeof c.prizeSnapshot === 'string' ? JSON.parse(c.prizeSnapshot) : c.prizeSnapshot;
        return ps?.prizeAmount === 0 || c.shippingAddress;
      } catch { return false; }
    });
    res.json(itemClaims.map(c => ({
      ...c,
      prizeSnapshot: typeof c.prizeSnapshot === 'string' ? JSON.parse(c.prizeSnapshot) : c.prizeSnapshot,
      shippingAddress: c.shippingAddress ? JSON.parse(c.shippingAddress) : null,
    })));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.post('/claims/:id/shipping-address', requireAuth, requireRole('staff', 'admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { street, city, state, zip, country } = req.body;
    const addr = JSON.stringify({ street, city, state, zip, country: country ?? 'US' });
    const claim = await prisma.claim.update({
      where: { id: req.params.id },
      data: { shippingAddress: addr },
    });
    res.json({ success: true, claim });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

distributionRouter.get('/fulfillment-labels.pdf', requireAuth, async (req: Request, res: Response) => {
  try {
    const PDFDocument = (await import('pdfkit')).default;
    const { claimIds } = req.query as Record<string, string>;
    if (!claimIds) throw new HttpError(400, 'claimIds required (comma-separated).');
    const ids = claimIds.split(',').map(s => s.trim()).filter(Boolean);
    const claims = await prisma.claim.findMany({ where: { id: { in: ids } } });

    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="fulfillment-labels.pdf"`);
    doc.pipe(res);

    // Avery 5163 layout: 2 cols x 5 rows, 4"x2" labels
    const cellW = 4 * 72;
    const cellH = 2 * 72;
    const startX = (612 - 2 * cellW) / 2;
    const startY = 36;

    let i = 0;
    for (const claim of claims) {
      const idx = i % 10;
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      if (i > 0 && idx === 0) doc.addPage();
      const x = startX + col * cellW;
      const y = startY + row * cellH;

      doc.rect(x + 4, y + 4, cellW - 8, cellH - 8).stroke('#cccccc');

      const ps = typeof claim.prizeSnapshot === 'string' ? JSON.parse(claim.prizeSnapshot) : claim.prizeSnapshot;
      const addr = claim.shippingAddress ? JSON.parse(claim.shippingAddress) : null;

      doc.fontSize(10).font('Helvetica-Bold').text(claim.playerName ?? 'Unknown', x + 12, y + 12, { width: cellW - 24 });
      if (addr) {
        doc.fontSize(8).font('Helvetica').text(addr.street ?? '', x + 12, y + 28, { width: cellW - 24 });
        doc.text(`${addr.city ?? ''}, ${addr.state ?? ''} ${addr.zip ?? ''}`, x + 12, y + 40, { width: cellW - 24 });
        doc.text(addr.country ?? '', x + 12, y + 52, { width: cellW - 24 });
      } else {
        doc.fontSize(8).fillColor('#888').text('No shipping address', x + 12, y + 28);
        doc.fillColor('#000');
      }
      doc.fontSize(7).fillColor('#666').text(`Prize: ${ps?.prizeLabel ?? ''}`, x + 12, y + 80, { width: cellW - 24 });
      doc.text(`Claim: ${claim.id.slice(0, 12)}`, x + 12, y + 92, { width: cellW - 24 });
      doc.fillColor('#000');
      i++;
    }
    doc.end();
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export helpers for other modules
export { getOrCreateShortUrl, applyMergeTags };
