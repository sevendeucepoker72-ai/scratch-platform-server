import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { prisma } from './db.js';

// Routes
import { playerRouter } from './routes/player.js';
import { staffRouter } from './routes/staff.js';
import { orgRouter } from './routes/org.js';
import { distributionRouter } from './routes/distribution.js';
import { inviteRouter } from './routes/invites.js';
import { webhookRouter } from './routes/webhooks.js';
import { stripeRouter } from './routes/stripe.js';
import { apiKeyRouter } from './routes/apiKeys.js';
import { miscRouter } from './routes/misc.js';
import { queryRouter } from './routes/query.js';

// Scheduled jobs
import { startScheduledJobs } from './jobs/scheduled.js';

const app = express();
const httpServer = createServer(app);
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// Socket.io
export const io = new SocketServer(httpServer, {
  cors: { origin: FRONTEND_URL, credentials: true },
});

io.on('connection', (socket) => {
  // Join rooms based on user context
  socket.on('join', (rooms: string[]) => {
    rooms.forEach(room => socket.join(room));
  });
  socket.on('leave', (rooms: string[]) => {
    rooms.forEach(room => socket.leave(room));
  });
});

// Middleware
app.use(helmet());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// Better Auth handles its own routes — mount BEFORE JSON parser for raw body access
app.all('/api/auth/*', toNodeHandler(auth));

// Stripe webhook needs raw body — mount BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// JSON body parser for all other routes
app.use(express.json({ limit: '1mb' }));

// Error handler
function asyncHandler(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Mount API routes
app.use('/api/player', playerRouter);
app.use('/api/staff', staffRouter);
app.use('/api/org', orgRouter);
app.use('/api/distribution', distributionRouter);
app.use('/api/invites', inviteRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/api-keys', apiKeyRouter);
app.use('/api', miscRouter);
app.use('/api/query', queryRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Parse JSON string fields from SQLite (venueIds, deck, revealedCardIds, etc.)
function parseJsonFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try { result[key] = JSON.parse(value); } catch { /* keep as string */ }
    }
  }
  return result;
}

// User profile endpoint
app.get('/api/me', async (req, res) => {
  try {
    const { fromNodeHeaders } = await import('better-auth/node');
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const user = await prisma.appUser.findUnique({ where: { authId: session.user.id } });
    if (!user) { res.status(404).json({ error: 'Profile not found' }); return; }
    res.json(parseJsonFields(user as unknown as Record<string, unknown>));
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
});

// One-time admin seed endpoint (remove after first use)
app.post('/api/seed-admin', async (req, res) => {
  const { email, secret } = req.body as { email: string; secret: string };
  if (secret !== process.env.CLAIM_CODE_SECRET) { res.status(403).json({ error: 'Invalid secret' }); return; }
  const user = await prisma.appUser.findUnique({ where: { email } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  await prisma.appUser.update({ where: { id: user.id }, data: { role: 'super_admin' } });
  res.json({ success: true, role: 'super_admin' });
});

// Global error handler
app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  if (status === 500) console.error('[error]', err);
  res.status(status).json({ error: err.message });
});

// Start
const PORT = parseInt(process.env.PORT ?? '3001', 10);

httpServer.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);
  startScheduledJobs();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] Shutting down...');
  await prisma.$disconnect();
  httpServer.close();
  process.exit(0);
});

export { asyncHandler, parseJsonFields };
