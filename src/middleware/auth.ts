import { Request, Response, NextFunction } from 'express';
import { auth } from '../auth.js';
import { prisma } from '../db.js';
import { fromNodeHeaders } from 'better-auth/node';

export type UserRole = 'player' | 'staff' | 'admin' | 'finance' | 'super_admin';

export interface AuthUser {
  id: string;       // User.id (app user)
  authId: string;   // BetterAuth user ID
  email: string;
  displayName: string;
  role: UserRole;
  venueIds: string[];
  isActive: boolean;
  orgId?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    // Load app user profile from the users table
    const appUser = await prisma.appUser.findUnique({
      where: { authId: session.user.id },
    });

    if (!appUser) {
      res.status(403).json({ error: 'User profile not found.' });
      return;
    }

    if (!appUser.isActive) {
      res.status(403).json({ error: 'Account is suspended.' });
      return;
    }

    req.user = {
      id: appUser.id,
      authId: session.user.id,
      email: appUser.email,
      displayName: appUser.displayName,
      role: appUser.role as UserRole,
      venueIds: typeof appUser.venueIds === 'string' ? JSON.parse(appUser.venueIds) : appUser.venueIds,
      isActive: appUser.isActive,
      orgId: appUser.orgId ?? undefined,
    };

    next();
  } catch (err) {
    console.error('[auth] Session verification failed:', err);
    res.status(401).json({ error: 'Invalid session.' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Role '${req.user.role}' is not authorized. Requires: ${roles.join(' or ')}.` });
      return;
    }
    next();
  };
}

export function requireVenueAccess(venueIdExtractor: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (req.user.role === 'super_admin') return next();
    const venueId = venueIdExtractor(req);
    if (!req.user.venueIds.includes(venueId)) {
      res.status(403).json({ error: `No access to venue: ${venueId}` });
      return;
    }
    next();
  };
}
