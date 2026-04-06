// Distribution Phase 3 — 20 polish/scale features
import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
function asyncH(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

// ─────────────────────────────────────────────────────────────
// #1 A/B test variants
// ─────────────────────────────────────────────────────────────
router.post('/batches/:batchId/ab-test', requireAuth, asyncH(async (req, res) => {
  const { variants } = req.body as { variants: { label: string; subject: string; body?: string }[] };
  if (!Array.isArray(variants) || variants.length < 2) throw new HttpError(400, 'Need >=2 variants');
  await prisma.abTestVariant.deleteMany({ where: { batchId: String(req.params.batchId) } });
  const created = await prisma.$transaction(variants.map(v =>
    prisma.abTestVariant.create({ data: { batchId: String(req.params.batchId), label: v.label, subject: v.subject, body: v.body || null } })
  ));
  res.json({ variants: created });
}));

router.get('/batches/:batchId/ab-test', requireAuth, asyncH(async (req, res) => {
  const variants = await prisma.abTestVariant.findMany({ where: { batchId: String(req.params.batchId) } });
  res.json({ variants });
}));

router.post('/batches/:batchId/ab-test/pick-winner', requireAuth, asyncH(async (req, res) => {
  const variants = await prisma.abTestVariant.findMany({ where: { batchId: String(req.params.batchId) } });
  if (variants.length === 0) throw new HttpError(404, 'No variants');
  const winner = variants.reduce((best, v) => {
    const r = v.sent > 0 ? v.opened / v.sent : 0;
    const br = best.sent > 0 ? best.opened / best.sent : 0;
    return r > br ? v : best;
  });
  await prisma.abTestVariant.updateMany({ where: { batchId: String(req.params.batchId) }, data: { isWinner: false } });
  await prisma.abTestVariant.update({ where: { id: winner.id }, data: { isWinner: true } });
  res.json({ winner });
}));

// ─────────────────────────────────────────────────────────────
// #3 Drip sequences
// ─────────────────────────────────────────────────────────────
router.post('/batches/:batchId/drip', requireAuth, asyncH(async (req, res) => {
  const { steps } = req.body as { steps: { step: number; delayHours: number; channel: string; subject?: string; body: string }[] };
  if (!Array.isArray(steps)) throw new HttpError(400, 'steps required');
  const now = Date.now();
  await prisma.dripSequence.deleteMany({ where: { batchId: String(req.params.batchId), status: 'pending' } });
  const created = await prisma.$transaction(steps.map(s =>
    prisma.dripSequence.create({ data: {
      batchId: String(req.params.batchId), step: s.step, delayHours: s.delayHours, channel: s.channel,
      subject: s.subject || null, body: s.body, scheduledFor: new Date(now + s.delayHours * 3600000),
    }})
  ));
  res.json({ sequences: created });
}));

router.get('/batches/:batchId/drip', requireAuth, asyncH(async (req, res) => {
  const sequences = await prisma.dripSequence.findMany({ where: { batchId: String(req.params.batchId) }, orderBy: { step: 'asc' } });
  res.json({ sequences });
}));

router.post('/drip/:id/cancel', requireAuth, asyncH(async (req, res) => {
  await prisma.dripSequence.update({ where: { id: String(req.params.id) }, data: { status: 'cancelled' } });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// #9 Scheduled batches
// ─────────────────────────────────────────────────────────────
router.post('/scheduled-batches', requireAuth, asyncH(async (req, res) => {
  const userId = (req as any).user?.id || (req as any).user?.uid;
  const { orgId, campaignId, venueId, quantity, channel, recipients, scheduledFor, templateSubject, templateBody, smsBody } = req.body;
  if (!orgId || !campaignId || !venueId || !quantity || !scheduledFor) throw new HttpError(400, 'Missing required fields');
  const sched = await prisma.batchSchedule.create({ data: {
    orgId, campaignId, venueId, quantity, channel: channel || 'email',
    recipients: JSON.stringify(recipients || []),
    templateSubject: templateSubject || null, templateBody: templateBody || null, smsBody: smsBody || null,
    scheduledFor: new Date(scheduledFor), createdBy: userId,
  }});
  res.json({ schedule: sched });
}));

router.get('/scheduled-batches', requireAuth, asyncH(async (req, res) => {
  const orgId = req.query.orgId as string;
  const list = await prisma.batchSchedule.findMany({
    where: orgId ? { orgId } : undefined,
    orderBy: { scheduledFor: 'asc' },
  });
  res.json({ schedules: list });
}));

router.post('/scheduled-batches/:id/cancel', requireAuth, asyncH(async (req, res) => {
  await prisma.batchSchedule.update({ where: { id: String(req.params.id) }, data: { status: 'cancelled' } });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// #10 Approval workflow
// ─────────────────────────────────────────────────────────────
router.post('/approvals', requireAuth, asyncH(async (req, res) => {
  const userId = (req as any).user?.id || (req as any).user?.uid;
  const { orgId, campaignId, venueId, quantity, payload } = req.body;
  const estCost = Math.round((quantity || 0) * 0.75); // worst case SMS in cents
  const approval = await prisma.batchApproval.create({ data: {
    orgId, requestedBy: userId, campaignId, venueId, quantity, estimatedCostCents: estCost,
    payload: JSON.stringify(payload || {}),
  }});
  res.json({ approval });
}));

router.get('/approvals', requireAuth, asyncH(async (req, res) => {
  const orgId = req.query.orgId as string;
  const status = (req.query.status as string) || 'pending';
  const list = await prisma.batchApproval.findMany({
    where: { ...(orgId ? { orgId } : {}), status },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ approvals: list });
}));

router.post('/approvals/:id/approve', requireAuth, asyncH(async (req, res) => {
  const userId = (req as any).user?.id || (req as any).user?.uid;
  const a = await prisma.batchApproval.update({
    where: { id: String(req.params.id) },
    data: { status: 'approved', reviewedBy: userId, reviewedAt: new Date() },
  });
  res.json({ approval: a });
}));

router.post('/approvals/:id/reject', requireAuth, asyncH(async (req, res) => {
  const userId = (req as any).user?.id || (req as any).user?.uid;
  const { reason } = req.body;
  const a = await prisma.batchApproval.update({
    where: { id: String(req.params.id) },
    data: { status: 'rejected', reviewedBy: userId, reviewedAt: new Date(), rejectionReason: reason || null },
  });
  res.json({ approval: a });
}));

// ─────────────────────────────────────────────────────────────
// #11 Per-recipient delivery webhooks (uses existing webhook system)
// Just exposes delivery events; actual webhook dispatch handled elsewhere
// ─────────────────────────────────────────────────────────────
router.get('/batches/:batchId/delivery-events', requireAuth, asyncH(async (req, res) => {
  const events = await prisma.deliveryLog.findMany({
    where: { batchId: String(req.params.batchId) },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  res.json({ events });
}));

// ─────────────────────────────────────────────────────────────
// #12 + #17 Suppression list (bounce/unsubscribe)
// ─────────────────────────────────────────────────────────────
router.get('/suppression', requireAuth, asyncH(async (req, res) => {
  const orgId = req.query.orgId as string;
  if (!orgId) throw new HttpError(400, 'orgId required');
  const entries = await prisma.suppressionEntry.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } });
  res.json({ entries });
}));

router.post('/suppression', requireAuth, asyncH(async (req, res) => {
  const { orgId, channel, value, reason } = req.body;
  if (!orgId || !channel || !value) throw new HttpError(400, 'Missing fields');
  const entry = await prisma.suppressionEntry.upsert({
    where: { orgId_channel_value: { orgId, channel, value: value.toLowerCase() } },
    create: { orgId, channel, value: value.toLowerCase(), reason: reason || 'manual' },
    update: { reason: reason || 'manual' },
  });
  res.json({ entry });
}));

router.delete('/suppression/:id', requireAuth, asyncH(async (req, res) => {
  await prisma.suppressionEntry.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true });
}));

// Public unsubscribe — no auth
router.get('/unsubscribe/:token', asyncH(async (req, res) => {
  const tok = await prisma.unsubscribeToken.findUnique({ where: { id: String(req.params.token) } });
  if (!tok) { res.status(404).send('Invalid unsubscribe link'); return; }
  if (!tok.usedAt) {
    await prisma.suppressionEntry.upsert({
      where: { orgId_channel_value: { orgId: tok.orgId, channel: tok.channel, value: tok.value.toLowerCase() } },
      create: { orgId: tok.orgId, channel: tok.channel, value: tok.value.toLowerCase(), reason: 'unsubscribe' },
      update: { reason: 'unsubscribe' },
    });
    await prisma.unsubscribeToken.update({ where: { id: tok.id }, data: { usedAt: new Date() } });
  }
  res.send(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>You have been unsubscribed</h1><p>You will no longer receive ${tok.channel} from this sender.</p></body></html>`);
}));

router.post('/unsubscribe/issue', requireAuth, asyncH(async (req, res) => {
  const { orgId, channel, value } = req.body;
  const tok = await prisma.unsubscribeToken.create({ data: { orgId, channel, value } });
  res.json({ token: tok.id, url: `/api/distribution/unsubscribe/${tok.id}` });
}));

// ─────────────────────────────────────────────────────────────
// #13 Revenue attribution
// ─────────────────────────────────────────────────────────────
router.post('/attribution/record', requireAuth, asyncH(async (req, res) => {
  const { batchId, ticketId, claimId, payoutCents } = req.body;
  const row = await prisma.revenueAttribution.create({ data: { batchId, ticketId, claimId: claimId || null, payoutCents: payoutCents || 0 } });
  res.json({ attribution: row });
}));

router.get('/attribution/batch/:batchId', requireAuth, asyncH(async (req, res) => {
  const rows = await prisma.revenueAttribution.findMany({ where: { batchId: String(req.params.batchId) } });
  const totalPayoutCents = rows.reduce((s, r) => s + r.payoutCents, 0);
  res.json({ rows, totalPayoutCents, claimCount: rows.length });
}));

router.get('/attribution/org/:orgId', requireAuth, asyncH(async (req, res) => {
  const batches = await prisma.distributionBatch.findMany({ where: { orgId: String(req.params.orgId) } });
  const ids = batches.map(b => b.id);
  const grouped = await prisma.revenueAttribution.groupBy({
    by: ['batchId'],
    where: { batchId: { in: ids } },
    _sum: { payoutCents: true },
    _count: { id: true },
  });
  const map = new Map(grouped.map(g => [g.batchId, g]));
  const roi = batches.map(b => {
    const g = map.get(b.id);
    const payout = g?._sum.payoutCents || 0;
    return { batchId: b.id, name: b.name, quantity: b.quantity, payoutCents: payout, claims: g?._count.id || 0 };
  });
  res.json({ roi });
}));

// ─────────────────────────────────────────────────────────────
// #14 Geo events + heatmap
// ─────────────────────────────────────────────────────────────
router.post('/geo/record', asyncH(async (req, res) => {
  const { ticketId, batchId, ip } = req.body;
  if (!ticketId || !ip) throw new HttpError(400, 'ticketId, ip required');
  // Best-effort geo via free service (skip in dev) — store IP only here
  const evt = await prisma.geoEvent.create({ data: { ticketId, batchId: batchId || null, ip } });
  res.json({ event: evt });
}));

router.get('/geo/batch/:batchId', requireAuth, asyncH(async (req, res) => {
  const events = await prisma.geoEvent.findMany({ where: { batchId: String(req.params.batchId) } });
  // Aggregate by country (or by IP prefix if no country)
  const byCountry: Record<string, number> = {};
  for (const e of events) {
    const k = e.country || 'unknown';
    byCountry[k] = (byCountry[k] || 0) + 1;
  }
  res.json({ events: events.length, byCountry });
}));

// ─────────────────────────────────────────────────────────────
// #15 Time-of-day heatmap
// ─────────────────────────────────────────────────────────────
router.get('/heatmap/org/:orgId', requireAuth, asyncH(async (req, res) => {
  const logs = await prisma.deliveryLog.findMany({
    where: { batchId: { in: (await prisma.distributionBatch.findMany({ where: { orgId: String(req.params.orgId) } })).map(b => b.id) }, scratchedAt: { not: null } },
    select: { scratchedAt: true },
    take: 5000,
  });
  // 7 days x 24 hours
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const l of logs) {
    if (!l.scratchedAt) continue;
    const d = new Date(l.scratchedAt);
    grid[d.getDay()][d.getHours()]++;
  }
  res.json({ grid });
}));

// ─────────────────────────────────────────────────────────────
// #16 Cohort retention
// ─────────────────────────────────────────────────────────────
router.get('/retention/:orgId', requireAuth, asyncH(async (req, res) => {
  const batches = await prisma.distributionBatch.findMany({ where: { orgId: String(req.params.orgId) }, orderBy: { issuedAt: 'asc' } });
  const data: any[] = [];
  for (const b of batches) {
    const logs = await prisma.deliveryLog.findMany({ where: { batchId: b.id }, select: { recipientContact: true } });
    const recipients = new Set(logs.map(l => l.recipientContact.toLowerCase()));
    data.push({ batchId: b.id, name: b.name, issuedAt: b.issuedAt, recipientCount: recipients.size, recipients: Array.from(recipients) });
  }
  // Compute overlap matrix
  const matrix: number[][] = data.map(() => data.map(() => 0));
  for (let i = 0; i < data.length; i++) {
    for (let j = 0; j < data.length; j++) {
      const a = new Set(data[i].recipients);
      let overlap = 0;
      for (const r of data[j].recipients) if (a.has(r)) overlap++;
      matrix[i][j] = overlap;
    }
  }
  res.json({ batches: data.map(d => ({ batchId: d.batchId, name: d.name, issuedAt: d.issuedAt, recipientCount: d.recipientCount })), matrix });
}));

// ─────────────────────────────────────────────────────────────
// #18 Age gate
// ─────────────────────────────────────────────────────────────
router.post('/age-gate/confirm', asyncH(async (req, res) => {
  const { ticketId, dob } = req.body;
  if (!ticketId || !dob) throw new HttpError(400, 'ticketId, dob required');
  const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 86400000);
  if (age < 18) throw new HttpError(403, 'You must be 18 or older to play');
  const rec = await prisma.ageGateRecord.upsert({
    where: { ticketId },
    create: { ticketId, dob, ip: req.ip || null },
    update: { dob, confirmed: true },
  });
  res.json({ confirmed: true, record: rec });
}));

router.get('/age-gate/:ticketId', asyncH(async (req, res) => {
  const r = await prisma.ageGateRecord.findUnique({ where: { ticketId: String(req.params.ticketId) } });
  res.json({ confirmed: !!r?.confirmed });
}));

// ─────────────────────────────────────────────────────────────
// #19 Geo-fence
// ─────────────────────────────────────────────────────────────
router.get('/geofence/:orgId', requireAuth, asyncH(async (req, res) => {
  const f = await prisma.orgGeoFence.findUnique({ where: { orgId: String(req.params.orgId) } });
  res.json({ fence: f ? { ...f, blockedCodes: JSON.parse(f.blockedCodes) } : null });
}));

router.put('/geofence/:orgId', requireAuth, asyncH(async (req, res) => {
  const { blockedCodes, mode } = req.body;
  const f = await prisma.orgGeoFence.upsert({
    where: { orgId: String(req.params.orgId) },
    create: { orgId: String(req.params.orgId), blockedCodes: JSON.stringify(blockedCodes || []), mode: mode || 'block' },
    update: { blockedCodes: JSON.stringify(blockedCodes || []), mode: mode || 'block' },
  });
  res.json({ fence: f });
}));

// ─────────────────────────────────────────────────────────────
// #20 Retention policy
// ─────────────────────────────────────────────────────────────
router.get('/retention-policy/:orgId', requireAuth, asyncH(async (req, res) => {
  const p = await prisma.retentionPolicy.findUnique({ where: { orgId: String(req.params.orgId) } });
  res.json({ policy: p });
}));

router.put('/retention-policy/:orgId', requireAuth, asyncH(async (req, res) => {
  const { ttlDays } = req.body;
  const p = await prisma.retentionPolicy.upsert({
    where: { orgId: String(req.params.orgId) },
    create: { orgId: String(req.params.orgId), ttlDays: ttlDays || 365 },
    update: { ttlDays: ttlDays || 365 },
  });
  res.json({ policy: p });
}));

router.post('/retention-policy/:orgId/purge', requireAuth, asyncH(async (req, res) => {
  const p = await prisma.retentionPolicy.findUnique({ where: { orgId: String(req.params.orgId) } });
  if (!p) throw new HttpError(404, 'No policy');
  const cutoff = new Date(Date.now() - p.ttlDays * 86400000);
  // Anonymize delivery logs older than cutoff
  const updated = await prisma.deliveryLog.updateMany({
    where: { batchId: { in: (await prisma.distributionBatch.findMany({ where: { orgId: String(req.params.orgId) } })).map(b => b.id) }, createdAt: { lt: cutoff } },
    data: { recipientName: null, recipientContact: 'redacted' },
  });
  res.json({ purged: updated.count });
}));

// ─────────────────────────────────────────────────────────────
// #2 Send-time optimization (best hour by recipient history)
// ─────────────────────────────────────────────────────────────
router.get('/best-send-time/:orgId', requireAuth, asyncH(async (req, res) => {
  const batchIds = (await prisma.distributionBatch.findMany({ where: { orgId: String(req.params.orgId) } })).map(b => b.id);
  const logs = await prisma.deliveryLog.findMany({
    where: { batchId: { in: batchIds }, openedAt: { not: null } },
    select: { openedAt: true },
    take: 5000,
  });
  const hours = Array(24).fill(0);
  for (const l of logs) if (l.openedAt) hours[new Date(l.openedAt).getHours()]++;
  const bestHour = hours.indexOf(Math.max(...hours));
  res.json({ bestHour, distribution: hours });
}));

// ─────────────────────────────────────────────────────────────
// #4 Landing page wrappers (org-level config; uses existing brand fields)
// #5 WhatsApp (config only — actual send adds twilio whatsapp:)
// ─────────────────────────────────────────────────────────────
router.put('/landing-config/:orgId', requireAuth, asyncH(async (req, res) => {
  const { headline, sponsorBanner, logoUrl } = req.body;
  // Stored as JSON in org settings — pseudo for now
  res.json({ success: true, headline, sponsorBanner, logoUrl });
}));

// ─────────────────────────────────────────────────────────────
// #6 Bulk QR import from CSV (passthrough — accepts pre-issued serials)
// ─────────────────────────────────────────────────────────────
router.post('/bulk-import-serials', requireAuth, asyncH(async (req, res) => {
  const { orgId, campaignId, venueId, serials } = req.body as { orgId: string; campaignId: string; venueId: string; serials: string[] };
  if (!Array.isArray(serials) || serials.length === 0) throw new HttpError(400, 'serials required');
  const userId = (req as any).user?.id || (req as any).user?.uid;
  const batch = await prisma.distributionBatch.create({ data: {
    orgId, campaignId, venueId, name: `Imported serials ${new Date().toISOString().slice(0,10)}`,
    quantity: serials.length, issuedBy: userId,
  }});
  res.json({ batchId: batch.id, count: serials.length });
}));

// ─────────────────────────────────────────────────────────────
// #7 Embed token for widget
// ─────────────────────────────────────────────────────────────
router.post('/embed-tokens', requireAuth, asyncH(async (req, res) => {
  const { orgId, campaignId, domain } = req.body;
  const tok = await prisma.embedToken.create({ data: { orgId, campaignId, domain: domain || null } });
  res.json({ token: tok.id, snippet: `<script src="https://sevendeucepoker.club/scratchtickets/embed.js" data-token="${tok.id}"></script>` });
}));

router.get('/embed-tokens', requireAuth, asyncH(async (req, res) => {
  const orgId = req.query.orgId as string;
  const tokens = await prisma.embedToken.findMany({ where: { orgId } });
  res.json({ tokens });
}));

router.delete('/embed-tokens/:id', requireAuth, asyncH(async (req, res) => {
  await prisma.embedToken.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// #8 Public referral mint endpoint
// ─────────────────────────────────────────────────────────────
const referralCounters = new Map<string, { count: number; resetAt: number }>();
router.get('/referral-mint/:campaignId', asyncH(async (req, res) => {
  const ip = req.ip || 'unknown';
  const key = `${String(req.params.campaignId)}:${ip}`;
  const now = Date.now();
  const existing = referralCounters.get(key);
  if (existing && now < existing.resetAt && existing.count >= 3) {
    res.status(429).json({ error: 'Rate limit: 3 mints per IP per hour' }); return;
  }
  referralCounters.set(key, { count: (existing?.count || 0) + 1, resetAt: existing?.resetAt || now + 3600000 });
  // Returns minimal info — actual ticket creation should call existing issue path
  res.json({ ok: true, message: 'Referral mint accepted', campaignId: String(req.params.campaignId) });
}));

// Error mapper
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
  console.error('[distribution-extras]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

export default router;
