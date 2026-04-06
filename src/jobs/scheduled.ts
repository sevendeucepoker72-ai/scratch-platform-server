import cron from 'node-cron';
import { prisma } from '../db.js';

export function startScheduledJobs() {
  // Expire batches whose expiresAt has passed — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await prisma.distributionBatch.updateMany({
        where: {
          status: 'active',
          expiresAt: { lte: new Date() },
        },
        data: { status: 'expired' },
      });
      if (result.count > 0) {
        console.log(`[scheduled] Expired ${result.count} distribution batches`);
        // Also freeze unscratched tickets in expired batches
        const expired = await prisma.distributionBatch.findMany({
          where: { status: 'expired', expiresAt: { lte: new Date() } },
          select: { id: true },
        });
        if (expired.length > 0) {
          await prisma.ticket.updateMany({
            where: {
              distributionBatchId: { in: expired.map(b => b.id) },
              status: { in: ['issued', 'in_progress'] },
            },
            data: { isFrozen: true, freezeReason: 'Batch expired' },
          });
        }
      }
    } catch (err) {
      console.error('[scheduled] expireBatches error:', err);
    }
  });

  // Expire stale tickets — every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours
      const result = await prisma.ticket.updateMany({
        where: {
          status: { in: ['issued', 'in_progress'] },
          createdAt: { lt: cutoff },
        },
        data: { status: 'expired' },
      });
      if (result.count > 0) {
        console.log(`[scheduled] Expired ${result.count} stale tickets`);
      }
    } catch (err) {
      console.error('[scheduled] expireStaleTickets error:', err);
    }
  });

  // Cleanup old idempotency keys — daily at 3am
  cron.schedule('0 3 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
      const result = await prisma.idempotencyKey.deleteMany({
        where: { processedAt: { lt: cutoff } },
      });
      console.log(`[scheduled] Cleaned up ${result.count} idempotency keys`);
    } catch (err) {
      console.error('[scheduled] cleanupIdempotencyKeys error:', err);
    }
  });

  // Cleanup old rate limit buckets — daily at 3:30am
  cron.schedule('30 3 * * *', async () => {
    try {
      const result = await prisma.rateLimitBucket.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      console.log(`[scheduled] Cleaned up ${result.count} rate limit buckets`);
    } catch (err) {
      console.error('[scheduled] cleanupRateLimitBuckets error:', err);
    }
  });

  // Reset monthly quotas for non-Stripe orgs — 1st of month at midnight
  cron.schedule('0 0 1 * *', async () => {
    try {
      const result = await prisma.organization.updateMany({
        where: { stripeSubscriptionId: null },
        data: {
          ticketsIssuedThisMonth: 0,
          overageTickets: 0,
          overageAmountCents: 0,
          ticketsResetAt: new Date(),
        },
      });
      console.log(`[scheduled] Reset quotas for ${result.count} non-Stripe orgs`);
    } catch (err) {
      console.error('[scheduled] resetMonthlyQuotas error:', err);
    }
  });

  console.log('[scheduled] All cron jobs registered');
}
