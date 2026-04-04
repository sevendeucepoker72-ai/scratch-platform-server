import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  TIER_LIMITS,
  OVERAGE_RATE_CENTS,
  type SubscriptionTier,
} from '../lib/helpers.js';

export const stripeRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-12-18.acacia' as any,
});

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// Price IDs per tier (configure in env or constants)
const TIER_PRICE_IDS: Record<string, string> = {
  growth: process.env.STRIPE_PRICE_GROWTH ?? '',
  business: process.env.STRIPE_PRICE_BUSINESS ?? '',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE ?? '',
};

// ── POST /create-checkout — Create Stripe Checkout session (owner only) ──

stripeRouter.post('/create-checkout', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, tier } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');
    if (org.ownerId !== user.id && user.role !== 'super_admin') {
      throw new HttpError(403, 'Only the organization owner can manage billing.');
    }

    if (!tier || !['growth', 'business', 'enterprise'].includes(tier)) {
      throw new HttpError(400, 'Invalid subscription tier. Choose growth, business, or enterprise.');
    }

    const priceId = TIER_PRICE_IDS[tier];
    if (!priceId) {
      throw new HttpError(400, `Billing is not yet configured. Please contact support to set up ${tier} plan pricing.`);
    }

    // Create or retrieve Stripe customer
    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: org.name,
        metadata: {
          orgId: validOrgId,
          ownerId: user.id,
        },
      });
      customerId = customer.id;
      await prisma.organization.update({
        where: { id: validOrgId },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/settings/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/settings/billing?canceled=true`,
      metadata: {
        orgId: validOrgId,
        tier,
      },
      subscription_data: {
        metadata: {
          orgId: validOrgId,
          tier,
        },
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'checkout_session_created',
      targetType: 'organization',
      targetId: validOrgId,
      details: { tier, sessionId: session.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[stripe] create-checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /create-portal — Create Stripe Billing Portal session ──

stripeRouter.post('/create-portal', requireAuth, async (req: Request, res: Response) => {
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

    if (!org.stripeCustomerId) {
      throw new HttpError(400, 'No billing account found. Subscribe to a plan first.');
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${FRONTEND_URL}/settings/billing`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[stripe] create-portal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /webhook — Stripe webhook (raw body, signature verification) ──

stripeRouter.post('/webhook', async (req: Request, res: Response) => {
  try {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) {
      res.status(400).json({ error: 'Missing Stripe signature.' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      console.error('[stripe] Webhook signature verification failed:', err.message);
      res.status(400).json({ error: 'Invalid signature.' });
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.metadata?.orgId;
        const tier = session.metadata?.tier;
        if (orgId && tier) {
          await prisma.organization.update({
            where: { id: orgId },
            data: {
              subscriptionTier: tier,
              subscriptionStatus: 'active',
              stripeSubscriptionId: session.subscription as string,
            },
          });
          console.log(`[stripe] Org ${orgId} upgraded to ${tier}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const orgId = subscription.metadata?.orgId;
        if (orgId) {
          const status = subscription.status === 'active' ? 'active'
            : subscription.status === 'past_due' ? 'past_due'
            : subscription.status === 'canceled' ? 'canceled'
            : subscription.status;

          const updateData: Record<string, unknown> = {
            subscriptionStatus: status,
          };

          if (subscription.current_period_start) {
            updateData.currentPeriodStart = new Date(subscription.current_period_start * 1000);
          }
          if (subscription.current_period_end) {
            updateData.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
          }

          await prisma.organization.update({
            where: { id: orgId },
            data: updateData,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const orgId = subscription.metadata?.orgId;
        if (orgId) {
          await prisma.organization.update({
            where: { id: orgId },
            data: {
              subscriptionTier: 'starter',
              subscriptionStatus: 'canceled',
              stripeSubscriptionId: null,
            },
          });
          console.log(`[stripe] Org ${orgId} subscription canceled, downgraded to starter`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoice.subscription as string;
        if (subId) {
          // Reset monthly quotas on successful billing cycle
          const org = await prisma.organization.findFirst({
            where: { stripeSubscriptionId: subId },
          });
          if (org) {
            await prisma.organization.update({
              where: { id: org.id },
              data: {
                ticketsIssuedThisMonth: 0,
                overageTickets: 0,
                overageAmountCents: 0,
                ticketsResetAt: new Date(),
              },
            });
            console.log(`[stripe] Reset monthly quotas for org ${org.id}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoice.subscription as string;
        if (subId) {
          const org = await prisma.organization.findFirst({
            where: { stripeSubscriptionId: subId },
          });
          if (org) {
            await prisma.organization.update({
              where: { id: org.id },
              data: { subscriptionStatus: 'past_due' },
            });
            console.log(`[stripe] Payment failed for org ${org.id}, set to past_due`);
          }
        }
        break;
      }

      default:
        console.log(`[stripe] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Scheduled: Reset monthly quotas for Stripe-managed orgs ──
// Called from scheduled jobs on billing cycle reset.

export async function resetMonthlyQuotas(): Promise<void> {
  try {
    const now = new Date();

    // Find orgs with Stripe subscriptions whose period has ended
    const orgs = await prisma.organization.findMany({
      where: {
        stripeSubscriptionId: { not: null },
        currentPeriodEnd: { lte: now },
      },
    });

    for (const org of orgs) {
      try {
        // Verify with Stripe that the subscription is still active
        if (org.stripeSubscriptionId) {
          const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
          if (sub.status === 'active') {
            await prisma.organization.update({
              where: { id: org.id },
              data: {
                ticketsIssuedThisMonth: 0,
                overageTickets: 0,
                overageAmountCents: 0,
                ticketsResetAt: now,
                currentPeriodStart: new Date(sub.current_period_start * 1000),
                currentPeriodEnd: new Date(sub.current_period_end * 1000),
              },
            });

            // Report overage usage if any
            if (org.overageTickets > 0 && org.overageAmountCents > 0) {
              await stripe.subscriptionItems.createUsageRecord(
                sub.items.data[0]?.id ?? '',
                {
                  quantity: org.overageTickets,
                  timestamp: Math.floor(Date.now() / 1000),
                  action: 'set',
                }
              ).catch((err) => {
                console.error(`[stripe] Failed to report overage for org ${org.id}:`, err);
              });
            }
          }
        }
      } catch (err) {
        console.error(`[stripe] resetMonthlyQuotas error for org ${org.id}:`, err);
      }
    }

    console.log(`[stripe] Monthly quota reset checked ${orgs.length} orgs`);
  } catch (err) {
    console.error('[stripe] resetMonthlyQuotas error:', err);
  }
}
