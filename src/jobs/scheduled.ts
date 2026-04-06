import cron from 'node-cron';
import { prisma } from '../db.js';
import { executeDelivery } from '../routes/distribution.js';

export function startScheduledJobs() {
  // Dispatch scheduled deliveries (undo timers + throttled batches) — every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const pending = await prisma.scheduledDelivery.findMany({
        where: { status: 'pending', scheduledFor: { lte: now } },
        take: 20,
      });
      for (const job of pending) {
        try {
          await prisma.scheduledDelivery.update({
            where: { id: job.id }, data: { status: 'running' },
          });
          const payload = JSON.parse(job.payload);
          const throttle = payload.throttlePerMinute as number | undefined;
          const recipients = payload.recipients as Array<any>;

          if (throttle && recipients.length > throttle) {
            // Send first `throttle` recipients now, reschedule the rest for 1 min later
            const thisBatch = recipients.slice(0, throttle);
            const remaining = recipients.slice(throttle);
            await executeDelivery({
              batchId: job.batchId,
              channel: payload.channel,
              recipients: thisBatch,
              recipientListId: payload.recipientListId,
            });
            if (remaining.length > 0) {
              await prisma.scheduledDelivery.create({
                data: {
                  batchId: job.batchId,
                  payload: JSON.stringify({ ...payload, recipients: remaining }),
                  scheduledFor: new Date(now.getTime() + 60 * 1000),
                  createdBy: job.createdBy,
                  status: 'pending',
                },
              });
            }
          } else {
            await executeDelivery({
              batchId: job.batchId,
              channel: payload.channel,
              recipients,
              recipientListId: payload.recipientListId,
            });
          }

          await prisma.scheduledDelivery.update({
            where: { id: job.id }, data: { status: 'done' },
          });
        } catch (err) {
          console.error('[scheduled] delivery job failed:', err);
          await prisma.scheduledDelivery.update({
            where: { id: job.id }, data: { status: 'done' }, // mark done to avoid retry loop
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[scheduled] dispatchDeliveries error:', err);
    }
  });

  // Send reminder emails — every hour
  cron.schedule('15 * * * *', async () => {
    try {
      const { sendDistributionTicketEmail } = await import('../lib/email.js');
      const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago
      const candidates = await prisma.deliveryLog.findMany({
        where: {
          channel: 'email',
          sentAt: { lt: cutoff },
          scratchedAt: null,
          reminderSentAt: null,
          status: { in: ['sent', 'delivered', 'opened'] },
        },
        take: 100,
      });
      if (candidates.length === 0) return;

      for (const log of candidates) {
        const batch = await prisma.distributionBatch.findUnique({ where: { id: log.batchId } });
        if (!batch) continue;
        const campaign = await prisma.campaign.findUnique({ where: { id: batch.campaignId } });
        const org = batch.orgId ? await prisma.organization.findUnique({ where: { id: batch.orgId } }) : null;
        const url = `${process.env.APP_URL ?? 'http://localhost:5173'}/scratch/${log.ticketId}`;
        try {
          await sendDistributionTicketEmail({
            toEmail: log.recipientContact,
            toName: log.recipientName ?? '',
            scratchUrl: url,
            campaignName: `Reminder: ${campaign?.name ?? 'Scratch Card'}`,
            orgName: org?.name ?? 'ScratchPoker',
            orgLogo: org?.logoUrl ?? null,
          });
          await prisma.deliveryLog.update({
            where: { id: log.id },
            data: { reminderSentAt: new Date() },
          });
        } catch { /* ignore individual failures */ }
      }
      console.log(`[scheduled] Sent ${candidates.length} reminder emails`);
    } catch (err) {
      console.error('[scheduled] reminders error:', err);
    }
  });

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
