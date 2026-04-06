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

// ── POST /issue-batch — Create N distribution tickets (admin+) ──

distributionRouter.post(
  '/issue-batch',
  requireAuth,
  requireRole('staff', 'admin', 'super_admin'),
  async (req: Request, res: Response) => {
    try {
      const { campaignId, quantity, count, venueId, orgId, onePerIp, name: batchName, expiresAt } = req.body;
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
    const { orgId, campaignId } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (orgId) where.orgId = orgId;
    else if (user.orgId) where.orgId = user.orgId;
    if (campaignId) where.campaignId = campaignId;

    const batches = await prisma.distributionBatch.findMany({ where, orderBy: { issuedAt: 'desc' }, take: 200 });
    const batchIds = batches.map(b => b.id);
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
    res.json(batches.map(b => ({ ...b, stats: stats[b.id] ?? { issued: 0, in_progress: 0, finalized: 0, claimed: 0, redeemed: 0, frozen: 0 } })));
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
      batch, campaign, venue,
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

    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.id}-qrcodes.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text(batch.name, { align: 'center' });
    doc.fontSize(11).font('Helvetica').text(`${campaign?.name ?? ''} - ${venue?.name ?? ''}`, { align: 'center' });
    doc.fontSize(9).text(`${tickets.length} tickets - Issued ${batch.issuedAt.toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(1);

    const cols = 2, rows = 5;
    const cardWidth = (612 - 72 - 18) / cols;
    const cardHeight = (792 - 200) / rows;

    let i = 0;
    for (const ticket of tickets) {
      const idx = i % (cols * rows);
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      if (i > 0 && idx === 0) doc.addPage();

      const x = 36 + col * (cardWidth + 18);
      const y = (i < (cols * rows) ? 130 : 36) + row * cardHeight;

      doc.rect(x, y, cardWidth, cardHeight - 12).stroke('#aaaaaa');

      const url = `${APP_URL}/scratch/${ticket.id}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
      const qrSize = Math.min(cardWidth - 40, cardHeight - 80);
      doc.image(Buffer.from(qrDataUrl.split(',')[1], 'base64'),
        x + (cardWidth - qrSize) / 2, y + 10, { width: qrSize });

      doc.fontSize(9).font('Helvetica-Bold').text(`Ticket #${i + 1}`, x + 4, y + qrSize + 16, { width: cardWidth - 8, align: 'center' });
      doc.fontSize(7).font('Helvetica').fillColor('#666').text(url.replace(/^https?:\/\//, ''), x + 4, y + qrSize + 28, { width: cardWidth - 8, align: 'center' });
      doc.fillColor('#000');
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
}) {
  const { batchId, channel, recipients, recipientListId } = params;
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

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const t = tickets[i];
    const contact = (channel === 'email' ? r.email : r.phone) ?? '';
    const url = `${APP_URL}/scratch/${t.id}`;

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
        await sendDistributionTicketEmail({
          toEmail: r.email ?? '',
          toName: r.name ?? '',
          scratchUrl: url,
          campaignName: campaign?.name ?? 'Scratch Card',
          orgName: org?.name ?? 'ScratchPoker',
          orgLogo: org?.logoUrl ?? null,
        });
      } else {
        const msg = `${r.name ? r.name + ', here is' : 'Here is'} your scratch ticket: ${url} - ${campaign?.name ?? 'ScratchPoker'}`;
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
    const { recipients, recipientListId, throttlePerMinute, delaySeconds } = req.body as {
      recipients: Array<{ email: string; name?: string }>;
      recipientListId?: string;
      throttlePerMinute?: number;
      delaySeconds?: number; // for undo — schedule N seconds out
    };
    if (!Array.isArray(recipients) || recipients.length === 0) throw new HttpError(400, 'recipients required.');

    // Schedule for later (undo window or throttling)
    if ((delaySeconds && delaySeconds > 0) || (throttlePerMinute && recipients.length > throttlePerMinute)) {
      const scheduledFor = new Date(Date.now() + (delaySeconds ?? 0) * 1000);
      const job = await prisma.scheduledDelivery.create({
        data: {
          batchId: req.params.id,
          payload: JSON.stringify({ channel: 'email', recipients, recipientListId, throttlePerMinute }),
          scheduledFor, createdBy: user.id, status: 'pending',
        },
      });
      res.json({ scheduled: true, jobId: job.id, scheduledFor, total: recipients.length });
      return;
    }

    const result = await executeDelivery({ batchId: req.params.id, channel: 'email', recipients, recipientListId });
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
    const { recipients, recipientListId, throttlePerMinute, delaySeconds } = req.body as {
      recipients: Array<{ phone: string; name?: string }>;
      recipientListId?: string;
      throttlePerMinute?: number;
      delaySeconds?: number;
    };
    if (!Array.isArray(recipients) || recipients.length === 0) throw new HttpError(400, 'recipients required.');

    if ((delaySeconds && delaySeconds > 0) || (throttlePerMinute && recipients.length > throttlePerMinute)) {
      const scheduledFor = new Date(Date.now() + (delaySeconds ?? 0) * 1000);
      const job = await prisma.scheduledDelivery.create({
        data: {
          batchId: req.params.id,
          payload: JSON.stringify({ channel: 'sms', recipients, recipientListId, throttlePerMinute }),
          scheduledFor, createdBy: user.id, status: 'pending',
        },
      });
      res.json({ scheduled: true, jobId: job.id, scheduledFor, total: recipients.length });
      return;
    }

    const result = await executeDelivery({ batchId: req.params.id, channel: 'sms', recipients, recipientListId });
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
