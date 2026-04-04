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
      const { campaignId, quantity, count, venueId, orgId, onePerIp } = req.body;
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

      const tickets: Array<{ ticketId: string; scratchUrl: string; claimCode: string }> = [];
      const batchId = crypto.randomBytes(8).toString('hex'); // unique ID for this batch

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

      res.json({ tickets });
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

    res.json({ ticketId: validId, prizeSnapshot });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[distribution] public-finalize error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
