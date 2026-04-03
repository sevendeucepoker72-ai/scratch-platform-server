// ============================================================
// PLAYER ROUTES — Express+Prisma port of Firebase player functions
//
// Routes: POST /issue-ticket, /load-ticket, /reveal,
//         /finalize, /submit-claim, /register
// ============================================================

import { Router } from 'express';
import * as crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import { buildShuffledDeck, evaluateBestHand, buildPrizeSnapshot } from '../game/poker.js';
import { GAME_ENGINES, buildGamePrizeSnapshot, type GameType } from '../game/gameEngines.js';
import {
  hashClaimCode,
  generateClaimCode,
  validateTicketId,
  validateCardId,
  writeAuditLog,
  writeFraudEvent,
  checkIdempotency,
  checkGlobalRateLimit,
  checkTicketQuota,
  HttpError,
} from '../lib/helpers.js';

export const playerRouter = Router();

// ── POST /issue-ticket ──────────────────────────────────────
// Supports both session auth and API key auth (for POS/kiosk integrations).

playerRouter.post('/issue-ticket', async (req, res) => {
  try {
    const rawApiKey = req.body.apiKey as string | undefined;

    let actorUid: string;
    let actorRole: string;
    let apiKeyOrgId: string | undefined;

    if (rawApiKey) {
      // API key path — no session required.
      // Verify by computing HMAC-SHA256 hash and looking up in api_keys table.
      const keyHash = crypto
        .createHmac('sha256', process.env.API_KEY_SECRET ?? 'dev-api-key-secret')
        .update(rawApiKey)
        .digest('hex');

      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
      if (!apiKey || !apiKey.isActive) {
        throw new HttpError(401, 'Invalid or expired API key.');
      }
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        throw new HttpError(401, 'Invalid or expired API key.');
      }

      const scopes = (typeof apiKey.scopes === 'string' ? JSON.parse(apiKey.scopes) : apiKey.scopes) as string[];
      if (!scopes.includes('tickets:issue')) {
        throw new HttpError(403, 'API key does not have tickets:issue scope.');
      }

      actorUid = `apikey:${apiKey.id}`;
      actorRole = 'admin';
      apiKeyOrgId = apiKey.orgId;
    } else {
      // Standard session auth path — apply requireAuth inline
      const { fromNodeHeaders } = await import('better-auth/node');
      const { auth } = await import('../auth.js');
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) {
        throw new HttpError(401, 'Authentication required.');
      }

      const appUser = await prisma.appUser.findUnique({ where: { authId: session.user.id } });
      if (!appUser) throw new HttpError(403, 'User profile not found.');
      if (!appUser.isActive) throw new HttpError(403, 'Account is suspended.');

      const allowedRoles = ['player', 'staff', 'admin', 'super_admin'];
      if (!allowedRoles.includes(appUser.role)) {
        throw new HttpError(403, `Role '${appUser.role}' is not authorized for this action.`);
      }

      actorUid = appUser.id;
      actorRole = appUser.role;

      // Attach user to request for downstream use
      req.user = {
        id: appUser.id,
        authId: session.user.id,
        email: appUser.email,
        displayName: appUser.displayName,
        role: appUser.role as any,
        venueIds: typeof appUser.venueIds === 'string' ? JSON.parse(appUser.venueIds) : appUser.venueIds,
        isActive: appUser.isActive,
        orgId: appUser.orgId ?? undefined,
      };
    }

    const { venueId, campaignId } = req.body as { venueId: string; campaignId: string };
    if (!venueId || !campaignId) {
      throw new HttpError(400, 'venueId and campaignId required.');
    }

    // In-memory rate limiter: fast, per-instance defense against burst
    checkRateLimit(`issue:${actorUid}`, 10);
    // DB-backed rate limiter: globally coordinated, 20 tickets/hour
    await checkGlobalRateLimit(actorUid, 20);

    // Fetch campaign with its odds profile
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { oddsProfile: true },
    });
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    if (!campaign.isActive) throw new HttpError(409, 'Campaign is not active.');

    // End date enforcement
    if (campaign.endDate && campaign.endDate < new Date()) {
      throw new HttpError(409, 'This campaign has ended and is no longer accepting new tickets.');
    }
    if (campaign.venueId !== venueId) {
      throw new HttpError(400, 'Campaign does not belong to this venue.');
    }

    // Quota enforcement — checks monthly limit and charges overage
    const orgId = apiKeyOrgId ?? campaign.orgId ?? undefined;
    if (orgId) {
      await checkTicketQuota(orgId);
    }

    // Fetch player data for email (skip for API key path)
    const odds = campaign.oddsProfile;
    if (!odds) throw new HttpError(404, 'Odds profile not found.');

    let playerData: { email: string; displayName: string } | null = null;
    if (!rawApiKey) {
      const player = await prisma.appUser.findUnique({ where: { id: actorUid } });
      if (!player?.email) throw new HttpError(409, 'Player email not found.');
      playerData = { email: player.email, displayName: player.displayName };
    }

    // Game type dispatch: use the right deck builder for this campaign
    const gameType = (campaign.gameType as GameType | null) ?? 'poker';
    const engine = gameType !== 'poker' ? GAME_ENGINES[gameType] : null;
    const deck = engine ? engine.buildDeck() : buildShuffledDeck();
    const scratchLimitOverride = engine ? engine.scratchLimit : ((odds as any).scratchLimit ?? 7);

    const claimCode = generateClaimCode();
    const claimCodeHash = hashClaimCode(claimCode);

    // Create ticket + audit log in parallel
    const ticket = await prisma.ticket.create({
      data: {
        playerId: rawApiKey ? null : actorUid,
        venueId,
        campaignId,
        orgId: orgId ?? null,
        deck: JSON.stringify(deck),
        revealedCardIds: '[]',
        scratchLimit: scratchLimitOverride,
        gameType,
        status: 'issued',
        isFrozen: false,
        claimCodeHash,
        claimCodeEmailSentAt: new Date(),
      },
    });

    const ticketId = ticket.id;

    await writeAuditLog({
      actorUserId: actorUid,
      actorRole,
      actionType: 'ticket_issued',
      targetType: 'scratchTicket',
      targetId: ticketId,
      venueId,
      details: {
        campaignId,
        scratchLimit: scratchLimitOverride,
        claimCodeDelivery: rawApiKey ? 'api_batch' : 'email',
      },
    });

    // TODO: Send claim code email (fire-and-forget)
    // void sendClaimCodeEmail({
    //   toEmail: playerData!.email,
    //   displayName: playerData!.displayName ?? 'Player',
    //   ticketId, claimCode,
    //   campaignName: campaign.name ?? campaignId,
    //   scratchLimit: scratchLimitOverride,
    // });

    io.to(`user:${actorUid}`).emit('ticket:issued', { ticketId });

    res.json({ ticketId });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] issue-ticket error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /load-ticket ───────────────────────────────────────

playerRouter.post('/load-ticket', requireAuth, async (req, res) => {
  try {
    const { ticketId } = req.body as { ticketId: string };

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new HttpError(404, 'Ticket not found.');

    if (ticket.playerId !== req.user!.id && !['staff', 'admin', 'super_admin'].includes(req.user!.role)) {
      await writeFraudEvent({
        ticketId,
        playerId: req.user!.id,
        signal: 'runtime_owner_mismatch_claim',
        details: { expectedOwner: ticket.playerId, requestedBy: req.user!.id },
      });
      throw new HttpError(403, 'Access denied.');
    }

    // Strip sensitive fields from response
    const { deck: _d, claimCodeHash: _h, ...safe } = ticket;
    void _d; void _h;

    res.json(safe);
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] load-ticket error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /reveal ────────────────────────────────────────────
// Uses Prisma $transaction with raw SQL SELECT ... FOR UPDATE
// to prevent concurrent reveals on the same ticket.

playerRouter.post('/reveal', requireAuth, async (req, res) => {
  try {
    const rawTicketId = (req.body as { ticketId: string }).ticketId;
    const rawCardId = (req.body as { cardId?: string }).cardId;

    const ticketId = validateTicketId(rawTicketId);
    // Only validate cardId if provided (poker games send it; non-poker games omit it)
    if (rawCardId !== undefined && rawCardId !== null) validateCardId(rawCardId);

    checkRateLimit(`reveal:${req.user!.id}`, 30);

    const revealedCardIds = await prisma.$transaction(async (tx) => {
      // Lock the ticket row to prevent concurrent reveals
      const rows = await tx.$queryRaw<Array<{
        id: string;
        playerId: string | null;
        venueId: string;
        status: string;
        isFrozen: boolean;
        deck: unknown;
        revealedCardIds: unknown;
        scratchLimit: number;
        gameType: string | null;
      }>>`SELECT "id", "playerId", "venueId", "status", "isFrozen", "deck", "revealedCardIds", "scratchLimit", "gameType" FROM tickets WHERE id = ${ticketId} FOR UPDATE`;

      if (!rows.length) throw new HttpError(404, 'Ticket not found.');
      const ticket = rows[0];

      if (ticket.playerId !== req.user!.id) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'runtime_owner_mismatch_finalize',
          details: { expectedOwner: ticket.playerId },
        });
        throw new HttpError(403, 'Access denied.');
      }

      if (ticket.isFrozen) throw new HttpError(409, 'Ticket is frozen.');
      if (ticket.status !== 'issued' && ticket.status !== 'in_progress') {
        throw new HttpError(409, `Ticket status: '${ticket.status}'.`);
      }

      const deck = (typeof ticket.deck === 'string' ? JSON.parse(ticket.deck) : ticket.deck) as string[];
      const revealed = (typeof ticket.revealedCardIds === 'string' ? JSON.parse(ticket.revealedCardIds) : ticket.revealedCardIds) as string[];

      // Deck-order enforcement: the revealed item is always deck[revealedCount].
      const nextDeckItem = deck[revealed.length];
      if (!nextDeckItem) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'runtime_reveal_over_limit',
          details: { revealedCount: revealed.length, limit: ticket.scratchLimit },
        });
        throw new HttpError(409, 'No more items to reveal.');
      }

      // For poker: validate that the client-supplied cardId matches deck order
      const isPokerTicket = !ticket.gameType || ticket.gameType === 'poker';
      if (isPokerTicket && rawCardId && rawCardId !== nextDeckItem) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'suspicious_retry_pattern',
          details: {
            requestedCard: rawCardId,
            expectedCard: nextDeckItem,
            revealedCount: revealed.length,
          },
        });
        throw new HttpError(400, 'Card reveal out of order.');
      }

      // Use the server-authoritative next deck item (not client-supplied)
      const itemToReveal = nextDeckItem;
      if (revealed.includes(itemToReveal)) {
        throw new HttpError(409, 'Item already revealed.');
      }
      if (revealed.length >= ticket.scratchLimit) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'runtime_reveal_over_limit',
          details: { limit: ticket.scratchLimit, current: revealed.length },
        });
        throw new HttpError(409, 'Scratch limit reached.');
      }

      const newRevealed = [...revealed, itemToReveal];

      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          revealedCardIds: JSON.stringify(newRevealed),
          status: 'in_progress',
        },
      });

      return newRevealed;
    });

    io.to(`ticket:${ticketId}`).emit('ticket:updated', { ticketId, status: 'in_progress' });

    res.json({ revealedCardIds });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] reveal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /finalize ──────────────────────────────────────────
// Idempotent via checkIdempotency(). Evaluates final hand/game result
// and writes prizeSnapshot to the ticket.

playerRouter.post('/finalize', requireAuth, async (req, res) => {
  try {
    const { ticketId } = req.body as { ticketId: string };

    const isFirst = await checkIdempotency(`finalize:${ticketId}`);
    if (!isFirst) {
      // Already finalized — return current state (idempotent)
      const existing = await prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!existing) throw new HttpError(404, 'Ticket not found.');
      const { deck: _d, claimCodeHash: _h, ...safe } = existing;
      void _d; void _h;
      res.json({ ticket: safe });
      return;
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new HttpError(404, 'Ticket not found.');

    if (ticket.playerId !== req.user!.id) {
      await writeFraudEvent({
        ticketId,
        playerId: req.user!.id,
        venueId: ticket.venueId,
        signal: 'runtime_owner_mismatch_finalize',
        details: { expectedOwner: ticket.playerId },
      });
      throw new HttpError(403, 'Access denied.');
    }

    if (ticket.isFrozen) throw new HttpError(409, 'Ticket is frozen.');

    const revealedCardIds = (typeof ticket.revealedCardIds === 'string' ? JSON.parse(ticket.revealedCardIds) : ticket.revealedCardIds) as string[];
    if (revealedCardIds.length < ticket.scratchLimit) {
      await writeFraudEvent({
        ticketId,
        playerId: req.user!.id,
        venueId: ticket.venueId,
        signal: 'runtime_finalize_insufficient_cards',
        details: { revealed: revealedCardIds.length, required: ticket.scratchLimit },
      });
      throw new HttpError(409, `Need ${ticket.scratchLimit} cards, have ${revealedCardIds.length}.`);
    }

    // Fetch campaign + odds profile
    const campaign = await prisma.campaign.findUnique({
      where: { id: ticket.campaignId },
      include: { oddsProfile: true },
    });
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    const odds = campaign.oddsProfile;
    if (!odds) throw new HttpError(404, 'Odds profile not found.');

    // Game type dispatch: evaluate using the correct engine
    const ticketGameType = (ticket.gameType as GameType | null) ?? 'poker';
    let prizeSnapshot: ReturnType<typeof buildPrizeSnapshot>;

    if (ticketGameType !== 'poker' && GAME_ENGINES[ticketGameType]) {
      const gameResult = GAME_ENGINES[ticketGameType].evaluate(revealedCardIds);
      // Cast odds.prizes to generic shape (tierName = handRank for non-poker)
      const prizesRaw = typeof (odds as any).prizes === 'string' ? JSON.parse((odds as any).prizes) : ((odds as any).prizes ?? []);
      const genericOdds = {
        prizes: (prizesRaw as Array<Record<string, unknown>>).map((p) => ({
          tierName: (p.tierName ?? p.handRank) as string,
          prizeLabel: p.prizeLabel as string,
          prizeAmount: p.prizeAmount as number,
          isEnabled: p.isEnabled as boolean,
        })),
      };
      prizeSnapshot = buildGamePrizeSnapshot(gameResult, genericOdds);
    } else {
      const handResult = evaluateBestHand(revealedCardIds);
      const oddsData = {
        prizes: (typeof (odds as any).prizes === 'string' ? JSON.parse((odds as any).prizes) : ((odds as any).prizes ?? [])) as Array<{
          handRank: string;
          prizeLabel: string;
          prizeAmount: number;
          isEnabled: boolean;
        }>,
      };
      prizeSnapshot = buildPrizeSnapshot(handResult, oddsData);
    }

    // Update ticket with finalized state + audit log
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'finalized',
          bestHandAtScratch: prizeSnapshot,
          prizeSnapshot: JSON.stringify(prizeSnapshot),
          finalizedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          actionType: 'ticket_finalized',
          targetType: 'scratchTicket',
          targetId: ticketId,
          venueId: ticket.venueId,
          details: JSON.stringify({
            handRank: prizeSnapshot.handRank,
            prizeAmount: prizeSnapshot.prizeAmount,
          }),
        },
      });

      return result;
    });

    // Strip sensitive fields from response
    const { deck: _d, claimCodeHash: _h, ...safeTicket } = updated;
    void _d; void _h;

    io.to(`ticket:${ticketId}`).emit('ticket:updated', { ticketId, status: 'finalized' });

    res.json({ ticket: safeTicket });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] finalize error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /submit-claim ──────────────────────────────────────
// Deterministic claim ID = ticketId (eliminates TOCTOU race).
// Transactional duplicate check + HMAC claim code verification.

playerRouter.post('/submit-claim', requireAuth, async (req, res) => {
  try {
    const { ticketId, claimCode } = req.body as { ticketId: string; claimCode: string };
    if (!ticketId || !claimCode) throw new HttpError(400, 'ticketId and claimCode required.');

    // Rate limit: max 5 claim attempts per user per minute
    checkRateLimit(`claim:${req.user!.id}`, 5);

    // Deterministic claim ID = ticket ID
    const claimId = ticketId;

    await prisma.$transaction(async (tx) => {
      // Lock ticket row and fetch it
      const tickets = await tx.$queryRaw<Array<{
        id: string;
        playerId: string | null;
        venueId: string;
        campaignId: string;
        status: string;
        isFrozen: boolean;
        claimCodeHash: string;
        prizeSnapshot: unknown;
      }>>`SELECT "id", "playerId", "venueId", "campaignId", "status", "isFrozen", "claimCodeHash", "prizeSnapshot" FROM tickets WHERE id = ${ticketId} FOR UPDATE`;

      if (!tickets.length) throw new HttpError(404, 'Ticket not found.');
      const ticket = tickets[0];

      if (ticket.playerId !== req.user!.id) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'runtime_owner_mismatch_claim',
          details: { expectedOwner: ticket.playerId },
        });
        throw new HttpError(403, 'Access denied.');
      }

      if (ticket.isFrozen) throw new HttpError(409, 'Ticket is frozen.');
      if (ticket.status !== 'finalized') {
        throw new HttpError(409, 'Ticket must be finalized before claiming.');
      }

      // Transactional duplicate check — no TOCTOU window
      const existingClaim = await tx.claim.findUnique({ where: { id: claimId } });
      if (existingClaim) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'duplicate_claim_attempt',
          details: {},
        });
        throw new HttpError(409, 'A claim already exists for this ticket.');
      }

      // Verify claim code via HMAC
      const submittedHash = hashClaimCode(claimCode);
      if (submittedHash !== ticket.claimCodeHash) {
        await writeFraudEvent({
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          signal: 'runtime_invalid_claim_code',
          details: { submittedHash },
        });
        throw new HttpError(403, 'Invalid claim code.');
      }

      if (!ticket.prizeSnapshot) {
        throw new HttpError(409, 'No prize snapshot on ticket.');
      }

      // Create claim record
      await tx.claim.create({
        data: {
          id: claimId,
          ticketId,
          playerId: req.user!.id,
          venueId: ticket.venueId,
          campaignId: ticket.campaignId,
          prizeSnapshot: typeof ticket.prizeSnapshot === 'string' ? ticket.prizeSnapshot : JSON.stringify(ticket.prizeSnapshot),
          status: 'pending_staff_approval',
          submittedAt: new Date(),
        },
      });

      // Update ticket status
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'pending_staff_approval',
          claimSubmittedAt: new Date(),
        },
      });

      // Audit log inside transaction
      await tx.auditLog.create({
        data: {
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          actionType: 'claim_submitted',
          targetType: 'scratchClaim',
          targetId: claimId,
          details: JSON.stringify({ ticketId }),
        },
      });
    });

    // TODO: Send confirmation email (fire-and-forget)
    // try {
    //   const player = await prisma.appUser.findUnique({ where: { id: req.user!.id } });
    //   const ticketData = await prisma.ticket.findUnique({ where: { id: ticketId } });
    //   if (player?.email) {
    //     void sendClaimSubmittedEmail({
    //       toEmail: player.email,
    //       displayName: player.displayName ?? 'Player',
    //       ticketId, claimId,
    //       handRank: (ticketData?.prizeSnapshot as any)?.handRank ?? 'Unknown',
    //       prizeAmount: (ticketData?.prizeSnapshot as any)?.prizeAmount ?? 0,
    //     });
    //   }
    // } catch { /* email failure never blocks the claim */ }

    io.to(`ticket:${ticketId}`).emit('ticket:updated', { ticketId, status: 'pending_staff_approval' });
    io.to(`user:${req.user!.id}`).emit('claim:submitted', { claimId });

    res.json({ claimId });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] submit-claim error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /register ──────────────────────────────────────────
// Creates a player profile linked to the Better Auth session user.
// Role is always hardcoded to 'player' — never from client.

playerRouter.post('/register', async (req, res) => {
  try {
    // Bootstrap-safe: get auth session directly (no requireAuth needed)
    const { fromNodeHeaders } = await import('better-auth/node');
    const { auth } = await import('../auth.js');
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const authId = session.user.id;
    const email = session.user.email ?? '';
    const displayName = ((req.body as { displayName?: string }).displayName ?? '').trim();

    if (!displayName || displayName.length < 2) {
      throw new HttpError(400, 'Display name must be at least 2 characters.');
    }
    if (displayName.length > 64) {
      throw new HttpError(400, 'Display name must be under 64 characters.');
    }

    // Check if profile already exists
    const existing = await prisma.appUser.findUnique({ where: { authId } });
    if (existing) {
      res.json({ success: true });
      return;
    }

    await prisma.appUser.create({
      data: {
        authId,
        email,
        displayName,
        role: 'player', // always hardcoded -- never from client
        venueIds: '[]',
        isActive: true,
      },
    });

    // Audit log uses authId since that's the only stable ID at this point
    console.log('[register] Player profile created', { authId, email });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[player] register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
