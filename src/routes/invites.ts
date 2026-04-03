import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { io } from '../index.js';
import {
  HttpError,
  writeAuditLog,
  validateOrgId,
  TIER_LIMITS,
  type SubscriptionTier,
} from '../lib/helpers.js';

export const inviteRouter = Router();

// ── POST /invite — Invite a team member (admin/owner) ──

inviteRouter.post('/invite', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, email, role } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      throw new HttpError(400, 'A valid email address is required.');
    }

    const validRoles = ['staff', 'admin', 'viewer'];
    const inviteRole = validRoles.includes(role) ? role : 'staff';

    // Verify caller is admin/owner of this org
    const callerMember = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!callerMember && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (callerMember && !['owner', 'admin'].includes(callerMember.role)) {
      throw new HttpError(403, 'Only owners and admins can invite team members.');
    }

    const org = await prisma.organization.findUnique({ where: { id: validOrgId } });
    if (!org) throw new HttpError(404, 'Organization not found.');

    // Check staff user limit
    const tier = org.subscriptionTier as SubscriptionTier;
    const limits = TIER_LIMITS[tier];
    if (limits.maxStaffUsers !== -1) {
      const currentCount = await prisma.orgMember.count({ where: { orgId: validOrgId } });
      if (currentCount >= limits.maxStaffUsers) {
        throw new HttpError(400, `Your plan allows a maximum of ${limits.maxStaffUsers} team members. Upgrade to add more.`);
      }
    }

    // Check if already a member
    const existingMember = await prisma.orgMember.findFirst({
      where: { orgId: validOrgId, email: email.toLowerCase() },
    });
    if (existingMember) throw new HttpError(409, 'This user is already a member of your organization.');

    // Check for pending invite
    const pendingInvite = await prisma.orgInvite.findFirst({
      where: { orgId: validOrgId, inviteeEmail: email.toLowerCase(), status: 'pending' },
    });
    if (pendingInvite) throw new HttpError(409, 'An invite is already pending for this email.');

    const invite = await prisma.orgInvite.create({
      data: {
        orgId: validOrgId,
        orgName: org.name,
        inviteeEmail: email.toLowerCase(),
        role: inviteRole,
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'team_member_invited',
      targetType: 'org_invite',
      targetId: invite.id,
      details: { orgId: validOrgId, email: email.toLowerCase(), role: inviteRole },
    });

    res.json({
      invite: {
        id: invite.id,
        token: invite.token,
        inviteeEmail: invite.inviteeEmail,
        role: invite.role,
        expiresAt: invite.expiresAt,
        status: invite.status,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[invites] invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /details — Get invite details by token (public) ──

inviteRouter.post('/details', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      throw new HttpError(400, 'Invite token is required.');
    }

    const invite = await prisma.orgInvite.findUnique({
      where: { token },
    });

    if (!invite) throw new HttpError(404, 'Invite not found.');

    // Check expiration
    if (invite.status === 'pending' && invite.expiresAt < new Date()) {
      await prisma.orgInvite.update({
        where: { id: invite.id },
        data: { status: 'expired' },
      });
      throw new HttpError(410, 'This invite has expired.');
    }

    res.json({
      invite: {
        id: invite.id,
        orgName: invite.orgName,
        inviteeEmail: invite.inviteeEmail,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[invites] details error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /accept — Accept an invite (authenticated) ──

inviteRouter.post('/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      throw new HttpError(400, 'Invite token is required.');
    }

    const invite = await prisma.orgInvite.findUnique({ where: { token } });
    if (!invite) throw new HttpError(404, 'Invite not found.');

    if (invite.status !== 'pending') {
      throw new HttpError(400, `This invite has already been ${invite.status}.`);
    }

    if (invite.expiresAt < new Date()) {
      await prisma.orgInvite.update({
        where: { id: invite.id },
        data: { status: 'expired' },
      });
      throw new HttpError(410, 'This invite has expired.');
    }

    // Verify email matches
    if (invite.inviteeEmail !== user.email.toLowerCase()) {
      throw new HttpError(403, 'This invite was sent to a different email address.');
    }

    // Check if user already belongs to an org
    if (user.orgId) {
      throw new HttpError(400, 'You already belong to an organization. Leave your current org first.');
    }

    // Check if already a member (race condition guard)
    const existingMember = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
    });
    if (existingMember) throw new HttpError(409, 'You are already a member of this organization.');

    await prisma.$transaction(async (tx) => {
      // Accept the invite
      await tx.orgInvite.update({
        where: { id: invite.id },
        data: {
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedBy: user.id,
        },
      });

      // Add as org member
      await tx.orgMember.create({
        data: {
          orgId: invite.orgId,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          role: invite.role,
          invitedBy: invite.invitedBy,
        },
      });

      // Update user record
      await tx.user.update({
        where: { id: user.id },
        data: {
          orgId: invite.orgId,
          orgRole: invite.role,
          orgName: invite.orgName,
        },
      });
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'invite_accepted',
      targetType: 'org_invite',
      targetId: invite.id,
      details: { orgId: invite.orgId, role: invite.role },
    });

    io.to(`org:${invite.orgId}`).emit('member:joined', {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: invite.role,
    });

    res.json({ success: true, orgId: invite.orgId, role: invite.role });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[invites] accept error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /remove — Remove a team member (admin/owner) ──

inviteRouter.post('/remove', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgId, userId: targetUserId } = req.body;
    const validOrgId = validateOrgId(orgId ?? user.orgId);

    if (!targetUserId || typeof targetUserId !== 'string') {
      throw new HttpError(400, 'Target userId is required.');
    }

    // Verify caller is admin/owner
    const callerMember = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: user.id } },
    });
    if (!callerMember && user.role !== 'super_admin') {
      throw new HttpError(403, 'Not a member of this organization.');
    }
    if (callerMember && !['owner', 'admin'].includes(callerMember.role)) {
      throw new HttpError(403, 'Only owners and admins can remove team members.');
    }

    // Can't remove yourself
    if (targetUserId === user.id) {
      throw new HttpError(400, 'You cannot remove yourself. Transfer ownership first.');
    }

    // Can't remove the owner
    const targetMember = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: validOrgId, userId: targetUserId } },
    });
    if (!targetMember) throw new HttpError(404, 'Member not found in this organization.');
    if (targetMember.role === 'owner') {
      throw new HttpError(403, 'Cannot remove the organization owner.');
    }

    // Admins can't remove other admins (only owner can)
    if (callerMember?.role === 'admin' && targetMember.role === 'admin') {
      throw new HttpError(403, 'Only the owner can remove admin members.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.orgMember.delete({
        where: { orgId_userId: { orgId: validOrgId, userId: targetUserId } },
      });

      await tx.user.update({
        where: { id: targetUserId },
        data: {
          orgId: null,
          orgRole: null,
          orgName: null,
        },
      });
    });

    await writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      actionType: 'team_member_removed',
      targetType: 'user',
      targetId: targetUserId,
      details: {
        orgId: validOrgId,
        removedEmail: targetMember.email,
        removedRole: targetMember.role,
      },
    });

    io.to(`org:${validOrgId}`).emit('member:removed', {
      userId: targetUserId,
      removedBy: user.id,
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[invites] remove error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
