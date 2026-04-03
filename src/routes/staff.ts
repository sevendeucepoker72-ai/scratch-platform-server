import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import { writeAuditLog, writeFraudEvent, checkIdempotency, HttpError } from '../lib/helpers.js';
import { sanitizeDetails } from '../lib/helpers.js';

const router = Router();

// ── 1. POST /approve-claim — approveScratchClaim (staff+) ──────

router.post(
  '/approve-claim',
  requireAuth,
  requireRole('staff', 'admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { claimId, approvalNote } = req.body;

      if (!claimId || typeof claimId !== 'string') {
        throw new HttpError(400, 'claimId is required.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.claim.findUnique({ where: { id: claimId } });
        if (!claim) throw new HttpError(404, 'Claim not found.');

        const venueId = claim.venueId;

        // Venue access check
        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (claim.status !== 'pending_staff_approval') {
          throw new HttpError(409, `Claim is not pending approval. Current status: ${claim.status}`);
        }

        const ticket = await tx.ticket.findUnique({ where: { id: claim.ticketId } });
        if (!ticket) throw new HttpError(404, 'Associated ticket not found.');

        if (ticket.isFrozen) {
          throw new HttpError(409, 'Ticket is frozen and cannot be approved.');
        }

        const prizeSnapshot = claim.prizeSnapshot as { prizeAmount?: number } | null;
        const prizeAmount = ticket.payoutOverride ?? prizeSnapshot?.prizeAmount ?? 0;
        const now = new Date();

        // Update claim to approved
        const updatedClaim = await tx.claim.update({
          where: { id: claimId },
          data: {
            status: 'approved',
            reviewedAt: now,
            reviewedBy: user.id,
            reviewerRole: user.role,
            approvalNote: approvalNote ?? null,
          },
        });

        // Update ticket status
        await tx.ticket.update({
          where: { id: claim.ticketId },
          data: {
            status: 'approved',
            approvedAt: now,
          },
        });

        // Create settlement log
        await tx.settlementLog.create({
          data: {
            ticketId: claim.ticketId,
            claimId: claimId,
            venueId: venueId,
            prizeAmount: prizeAmount,
            finalAmount: prizeAmount,
            settledBy: user.id,
          },
        });

        // Write audit log inside transaction
        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'claim_approved',
            targetType: 'claim',
            targetId: claimId,
            venueId: venueId,
            details: sanitizeDetails({
              ticketId: claim.ticketId,
              prizeAmount,
              approvalNote: approvalNote ?? null,
            }),
          },
        });

        return { updatedClaim, venueId, prizeAmount, playerId: claim.playerId };
      });

      // Emit Socket.io events after successful transaction
      io.to(`claims:${result.venueId}`).emit('claim:approved', { claimId });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('claim:approved', {
          claimId,
          prizeAmount: result.prizeAmount,
        });
      }

      res.json({ success: true, claimId });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] approveScratchClaim error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 2. POST /deny-claim — denyScratchClaim (staff+) ────────────

router.post(
  '/deny-claim',
  requireAuth,
  requireRole('staff', 'admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { claimId, denialReason } = req.body;

      if (!claimId || typeof claimId !== 'string') {
        throw new HttpError(400, 'claimId is required.');
      }
      if (!denialReason || typeof denialReason !== 'string' || denialReason.trim().length === 0) {
        throw new HttpError(400, 'denialReason is required.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.claim.findUnique({ where: { id: claimId } });
        if (!claim) throw new HttpError(404, 'Claim not found.');

        const venueId = claim.venueId;

        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (claim.status !== 'pending_staff_approval') {
          throw new HttpError(409, `Claim is not pending approval. Current status: ${claim.status}`);
        }

        const now = new Date();

        // Update claim to denied
        await tx.claim.update({
          where: { id: claimId },
          data: {
            status: 'denied',
            reviewedAt: now,
            reviewedBy: user.id,
            reviewerRole: user.role,
            denialReason: denialReason.trim(),
          },
        });

        // Revert ticket status back to finalized so it can be re-claimed
        await tx.ticket.update({
          where: { id: claim.ticketId },
          data: {
            status: 'finalized',
          },
        });

        // Audit log
        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'claim_denied',
            targetType: 'claim',
            targetId: claimId,
            venueId: venueId,
            details: sanitizeDetails({
              ticketId: claim.ticketId,
              denialReason: denialReason.trim(),
            }),
          },
        });

        return { venueId, playerId: claim.playerId };
      });

      io.to(`claims:${result.venueId}`).emit('claim:denied', { claimId });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('claim:denied', { claimId });
      }

      res.json({ success: true, claimId });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] denyScratchClaim error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 3. POST /redeem — redeemScratchTicket (staff+) ─────────────

router.post(
  '/redeem',
  requireAuth,
  requireRole('staff', 'admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { claimId, notes } = req.body;

      if (!claimId || typeof claimId !== 'string') {
        throw new HttpError(400, 'claimId is required.');
      }

      // Idempotency check — prevent double-redeem
      const idempotencyKey = `redeem:${claimId}`;
      const isFirstAttempt = await checkIdempotency(idempotencyKey);
      if (!isFirstAttempt) {
        throw new HttpError(409, 'This claim has already been redeemed (duplicate request).');
      }

      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.claim.findUnique({ where: { id: claimId } });
        if (!claim) throw new HttpError(404, 'Claim not found.');

        const venueId = claim.venueId;

        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (claim.status !== 'approved') {
          throw new HttpError(409, `Claim must be approved before redemption. Current status: ${claim.status}`);
        }

        const ticket = await tx.ticket.findUnique({ where: { id: claim.ticketId } });
        if (!ticket) throw new HttpError(404, 'Associated ticket not found.');

        if (ticket.isFrozen) {
          throw new HttpError(409, 'Ticket is frozen and cannot be redeemed.');
        }

        const prizeSnapshot = claim.prizeSnapshot as { prizeAmount?: number } | null;
        const prizeAmount = ticket.payoutOverride ?? prizeSnapshot?.prizeAmount ?? 0;
        const now = new Date();

        // Create redemption record
        const redemption = await tx.redemption.create({
          data: {
            ticketId: claim.ticketId,
            claimId: claimId,
            playerId: claim.playerId,
            venueId: venueId,
            prizeAmount: prizeAmount,
            redeemedBy: user.id,
            notes: notes ?? null,
          },
        });

        // Update claim
        await tx.claim.update({
          where: { id: claimId },
          data: {
            status: 'redeemed',
            redeemedAt: now,
            redeemedBy: user.id,
            redemptionNote: notes ?? null,
          },
        });

        // Update ticket
        await tx.ticket.update({
          where: { id: claim.ticketId },
          data: {
            status: 'redeemed',
            redeemedAt: now,
          },
        });

        // Audit log
        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'ticket_redeemed',
            targetType: 'ticket',
            targetId: claim.ticketId,
            venueId: venueId,
            details: sanitizeDetails({
              claimId,
              redemptionId: redemption.id,
              prizeAmount,
              notes: notes ?? null,
            }),
          },
        });

        return { redemption, venueId, playerId: claim.playerId, prizeAmount };
      });

      io.to(`claims:${result.venueId}`).emit('claim:redeemed', {
        claimId,
        redemptionId: result.redemption.id,
      });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('claim:redeemed', {
          claimId,
          prizeAmount: result.prizeAmount,
        });
      }

      res.json({ success: true, claimId, redemptionId: result.redemption.id });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] redeemScratchTicket error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 4. POST /freeze — freezeTicket (admin+) ────────────────────

router.post(
  '/freeze',
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { ticketId, freezeReason } = req.body;

      if (!ticketId || typeof ticketId !== 'string') {
        throw new HttpError(400, 'ticketId is required.');
      }
      if (!freezeReason || typeof freezeReason !== 'string' || freezeReason.trim().length === 0) {
        throw new HttpError(400, 'freezeReason is required.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) throw new HttpError(404, 'Ticket not found.');

        const venueId = ticket.venueId;

        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (ticket.isFrozen) {
          throw new HttpError(409, 'Ticket is already frozen.');
        }

        const now = new Date();

        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            isFrozen: true,
            freezeReason: freezeReason.trim(),
            frozenAt: now,
            frozenBy: user.id,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'ticket_frozen',
            targetType: 'ticket',
            targetId: ticketId,
            venueId: venueId,
            details: sanitizeDetails({
              freezeReason: freezeReason.trim(),
            }),
          },
        });

        return { venueId, playerId: ticket.playerId };
      });

      io.to(`claims:${result.venueId}`).emit('ticket:frozen', { ticketId });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('ticket:frozen', { ticketId });
      }

      res.json({ success: true, ticketId });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] freezeTicket error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 5. POST /unfreeze — unfreezeTicket (admin+) ────────────────

router.post(
  '/unfreeze',
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { ticketId, unfreezeReason } = req.body;

      if (!ticketId || typeof ticketId !== 'string') {
        throw new HttpError(400, 'ticketId is required.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) throw new HttpError(404, 'Ticket not found.');

        const venueId = ticket.venueId;

        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (!ticket.isFrozen) {
          throw new HttpError(409, 'Ticket is not frozen.');
        }

        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            isFrozen: false,
            freezeReason: null,
            frozenAt: null,
            frozenBy: null,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'ticket_unfrozen',
            targetType: 'ticket',
            targetId: ticketId,
            venueId: venueId,
            details: sanitizeDetails({
              previousFreezeReason: ticket.freezeReason ?? 'none',
              unfreezeReason: unfreezeReason ?? null,
            }),
          },
        });

        return { venueId, playerId: ticket.playerId };
      });

      io.to(`claims:${result.venueId}`).emit('ticket:unfrozen', { ticketId });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('ticket:unfrozen', { ticketId });
      }

      res.json({ success: true, ticketId });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] unfreezeTicket error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 6. POST /override-payout — overridePayout (admin+) ─────────

router.post(
  '/override-payout',
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { ticketId, newPayoutAmount, note } = req.body;

      if (!ticketId || typeof ticketId !== 'string') {
        throw new HttpError(400, 'ticketId is required.');
      }
      if (typeof newPayoutAmount !== 'number' || newPayoutAmount < 0) {
        throw new HttpError(400, 'newPayoutAmount must be a non-negative number.');
      }

      // Enforce payout caps by role
      const ADMIN_MAX_PAYOUT = 10_000_00; // $10,000 in cents
      const SUPER_ADMIN_MAX_PAYOUT = 500_000_00; // $500,000 in cents

      if (user.role === 'admin' && newPayoutAmount > ADMIN_MAX_PAYOUT) {
        throw new HttpError(403, 'Admin payout override cannot exceed $10,000.');
      }
      if (newPayoutAmount > SUPER_ADMIN_MAX_PAYOUT) {
        throw new HttpError(403, 'Payout override cannot exceed $500,000 absolute cap.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) throw new HttpError(404, 'Ticket not found.');

        const venueId = ticket.venueId;

        if (user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (ticket.status === 'redeemed') {
          throw new HttpError(409, 'Cannot override payout on a redeemed ticket.');
        }

        const previousPayout = ticket.payoutOverride;
        const now = new Date();

        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            payoutOverride: newPayoutAmount,
            payoutOverrideNote: note ?? null,
            payoutOverrideBy: user.id,
            payoutOverrideRole: user.role,
            payoutOverrideAt: now,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'payout_overridden',
            targetType: 'ticket',
            targetId: ticketId,
            venueId: venueId,
            details: sanitizeDetails({
              previousPayout: previousPayout ?? 'none',
              newPayoutAmount,
              note: note ?? null,
            }),
          },
        });

        return { venueId, playerId: ticket.playerId };
      });

      io.to(`claims:${result.venueId}`).emit('ticket:payout_overridden', {
        ticketId,
        newPayoutAmount,
      });
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('ticket:payout_overridden', {
          ticketId,
          newPayoutAmount,
        });
      }

      res.json({ success: true, ticketId, newPayoutAmount });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] overridePayout error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 7. POST /resolve-fraud — resolveFraudCase (admin+) ─────────

router.post(
  '/resolve-fraud',
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { ticketId, resolutionCode, resolutionNote } = req.body;

      if (!ticketId || typeof ticketId !== 'string') {
        throw new HttpError(400, 'ticketId is required.');
      }
      if (!resolutionCode || typeof resolutionCode !== 'string') {
        throw new HttpError(400, 'resolutionCode is required.');
      }

      const validResolutionCodes = ['cleared', 'confirmed_fraud', 'suspicious_dismissed', 'escalated'];
      if (!validResolutionCodes.includes(resolutionCode)) {
        throw new HttpError(400, `Invalid resolutionCode. Must be one of: ${validResolutionCodes.join(', ')}`);
      }

      const result = await prisma.$transaction(async (tx) => {
        const riskScore = await tx.riskScore.findUnique({ where: { ticketId } });
        if (!riskScore) throw new HttpError(404, 'No fraud case found for this ticket.');

        const venueId = riskScore.venueId;

        if (venueId && user.role !== 'super_admin') {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
        }

        if (riskScore.status === 'resolved') {
          throw new HttpError(409, 'Fraud case is already resolved.');
        }

        const now = new Date();

        await tx.riskScore.update({
          where: { ticketId },
          data: {
            status: 'resolved',
            resolutionCode,
            resolutionNote: resolutionNote ?? null,
            resolvedBy: user.id,
            resolvedAt: now,
          },
        });

        // If confirmed fraud, freeze the ticket
        if (resolutionCode === 'confirmed_fraud') {
          await tx.ticket.update({
            where: { id: ticketId },
            data: {
              isFrozen: true,
              freezeReason: 'Frozen due to confirmed fraud.',
              frozenAt: now,
              frozenBy: user.id,
            },
          });
        }

        // If cleared, unfreeze if currently frozen
        if (resolutionCode === 'cleared') {
          const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
          if (ticket?.isFrozen) {
            await tx.ticket.update({
              where: { id: ticketId },
              data: {
                isFrozen: false,
                freezeReason: null,
                frozenAt: null,
                frozenBy: null,
              },
            });
          }
        }

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorRole: user.role,
            actionType: 'fraud_resolved',
            targetType: 'risk_score',
            targetId: ticketId,
            venueId: venueId,
            details: sanitizeDetails({
              resolutionCode,
              resolutionNote: resolutionNote ?? null,
              previousScore: riskScore.score,
              previousSeverity: riskScore.severity,
            }),
          },
        });

        return { venueId, playerId: riskScore.playerId };
      });

      if (result.venueId) {
        io.to(`claims:${result.venueId}`).emit('fraud:resolved', { ticketId, resolutionCode });
      }
      if (result.playerId) {
        io.to(`user:${result.playerId}`).emit('fraud:resolved', { ticketId, resolutionCode });
      }

      res.json({ success: true, ticketId, resolutionCode });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] resolveFraudCase error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 8. POST /generate-export — generateExportArtifact (finance/super_admin) ──

router.post(
  '/generate-export',
  requireAuth,
  requireRole('finance', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { venueId, startDate, endDate, format } = req.body;

      if (!startDate || !endDate) {
        throw new HttpError(400, 'startDate and endDate are required.');
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new HttpError(400, 'Invalid date format for startDate or endDate.');
      }
      if (start >= end) {
        throw new HttpError(400, 'startDate must be before endDate.');
      }

      // Determine which venues the user can access
      let venueFilter: string[];
      if (user.role === 'super_admin') {
        // Super admin can export for a specific venue or all venues
        if (venueId) {
          venueFilter = [venueId];
        } else {
          // All venues — no filter
          venueFilter = [];
        }
      } else {
        // Finance users are scoped to their assigned venues
        if (venueId) {
          if (!user.venueIds.includes(venueId)) {
            throw new HttpError(403, `No access to venue: ${venueId}`);
          }
          venueFilter = [venueId];
        } else {
          venueFilter = user.venueIds;
        }
        if (venueFilter.length === 0) {
          throw new HttpError(403, 'No venues assigned to this user.');
        }
      }

      // Query redemptions scoped to the user's venues
      const whereClause: Record<string, unknown> = {
        redeemedAt: { gte: start, lte: end },
      };
      if (venueFilter.length > 0) {
        whereClause.venueId = { in: venueFilter };
      }

      const redemptions = await prisma.redemption.findMany({
        where: whereClause,
        orderBy: { redeemedAt: 'asc' },
        include: {
          claim: {
            select: {
              playerEmail: true,
              playerName: true,
              status: true,
              prizeSnapshot: true,
            },
          },
        },
      });

      // Generate CSV string
      const csvHeaders = [
        'redemptionId',
        'ticketId',
        'claimId',
        'venueId',
        'playerId',
        'playerName',
        'playerEmail',
        'prizeAmount',
        'redeemedBy',
        'redeemedAt',
      ];
      const csvRows = redemptions.map((r) => {
        return [
          r.id,
          r.ticketId,
          r.claimId,
          r.venueId,
          r.playerId ?? '',
          csvEscape(r.claim?.playerName ?? ''),
          csvEscape(r.claim?.playerEmail ?? ''),
          r.prizeAmount.toString(),
          r.redeemedBy,
          r.redeemedAt.toISOString(),
        ].join(',');
      });
      const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');

      // Generate a batch ID and file name
      const batchId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `redemptions_${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}_${batchId}.csv`;
      const storagePath = `exports/${fileName}`;

      // TODO: Upload csvContent to S3 or compatible object storage
      // For now, we store the metadata and skip the actual upload.

      const artifact = await prisma.storageExport.create({
        data: {
          batchId,
          venueId: venueFilter.length === 1 ? venueFilter[0] : null,
          fileName,
          storagePath,
          status: 'ready',
          generatedBy: user.id,
        },
      });

      await writeAuditLog({
        actorUserId: user.id,
        actorRole: user.role,
        actionType: 'export_generated',
        targetType: 'storage_export',
        targetId: artifact.id,
        venueId: venueFilter.length === 1 ? venueFilter[0] : undefined,
        details: {
          fileName,
          redemptionCount: redemptions.length,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          venueFilter,
        },
      });

      res.json({
        success: true,
        artifactId: artifact.id,
        fileName,
        redemptionCount: redemptions.length,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] generateExportArtifact error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── 9. POST /request-download — requestSignedExportDownload (finance/super_admin) ──

router.post(
  '/request-download',
  requireAuth,
  requireRole('finance', 'super_admin'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { artifactId } = req.body;

      if (!artifactId || typeof artifactId !== 'string') {
        throw new HttpError(400, 'artifactId is required.');
      }

      const artifact = await prisma.storageExport.findUnique({ where: { id: artifactId } });
      if (!artifact) {
        throw new HttpError(404, 'Export artifact not found.');
      }

      // Venue access check
      if (artifact.venueId && user.role !== 'super_admin') {
        if (!user.venueIds.includes(artifact.venueId)) {
          throw new HttpError(403, `No access to venue: ${artifact.venueId}`);
        }
      }

      if (artifact.status !== 'ready') {
        throw new HttpError(409, `Export is not ready for download. Current status: ${artifact.status}`);
      }

      // TODO: Implement signed URL generation using S3 getSignedUrl or equivalent.
      // For now, return a placeholder URL.
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      const downloadUrl = `https://storage.placeholder.local/${artifact.storagePath}?token=TODO_SIGNED_URL&expires=${expiresAt.toISOString()}`;

      const signedDownload = await prisma.signedDownload.create({
        data: {
          artifactId: artifact.id,
          downloadUrl,
          expiresAt,
          requestedBy: user.id,
        },
      });

      // Increment download count on the artifact
      await prisma.storageExport.update({
        where: { id: artifactId },
        data: { downloadedCount: { increment: 1 } },
      });

      await writeAuditLog({
        actorUserId: user.id,
        actorRole: user.role,
        actionType: 'export_download_requested',
        targetType: 'storage_export',
        targetId: artifactId,
        venueId: artifact.venueId ?? undefined,
        details: {
          fileName: artifact.fileName,
          signedDownloadId: signedDownload.id,
        },
      });

      res.json({
        success: true,
        downloadUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[staff] requestSignedExportDownload error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },
);

// ── CSV helper ──────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export { router as staffRouter };
