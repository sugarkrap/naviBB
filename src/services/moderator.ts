import type { FastifyInstance, FastifyReply } from 'fastify';
import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import { User } from '../schemas/users';
import { BanLog } from '../schemas/ban-logs';
import { ViewConfig } from '../views';
import { avatarUrlFor } from './auth';
import { clearIPBan, setIPBan } from './ip-bans';
import {
  logActivity,
  ACTIVITY_ACTIONS,
  type ActivityActor,
} from './activity-log';

const PERMANENT_BAN_YEAR = 9999;

const banBodySchema = z.object({
  duration: z.coerce.number().int().min(0),
  durationUnit: z.enum(['hours', 'days', 'weeks', 'months', 'permanent']),
  reason: z.string().default(''),
  banIP: z
    .string()
    .optional()
    .transform((value) => value === 'on'),
});

interface TargetUserView {
  _id: Types.ObjectId;
  username: string;
  avatarURL: string | null;
  role: string;
  isBanned: boolean;
  bannedUntil: Date | null;
  banReason: string;
  banType: 'account' | 'account+ip';
  bannedIP: string | null;
}

interface DbUserForView {
  _id: Types.ObjectId;
  username: string;
  avatar?: string;
  role: string;
  bannedUntil?: Date | null;
  banReason?: string;
  banIP?: string | null;
}

const buildTargetView = (
  dbUser: DbUserForView,
  viewerRole: string,
): TargetUserView => {
  const bannedUntil = dbUser.bannedUntil ? new Date(dbUser.bannedUntil) : null;
  return {
    _id: dbUser._id,
    username: dbUser.username,
    avatarURL: avatarUrlFor(dbUser.avatar),
    role: dbUser.role,
    isBanned: !!bannedUntil && bannedUntil.getTime() > Date.now(),
    bannedUntil,
    banReason: dbUser.banReason ?? '',
    banType: dbUser.banIP ? 'account+ip' : 'account',
    bannedIP: viewerRole === 'admin' ? (dbUser.banIP ?? null) : null,
  };
};

const computeBannedUntil = (duration: number, unit: string): Date | null => {
  if (unit === 'permanent' || duration <= 0) {
    return new Date(PERMANENT_BAN_YEAR, 0, 1);
  }
  const now = new Date();
  switch (unit) {
    case 'hours':
      now.setHours(now.getHours() + duration);
      break;
    case 'days':
      now.setDate(now.getDate() + duration);
      break;
    case 'weeks':
      now.setDate(now.getDate() + duration * 7);
      break;
    case 'months':
      now.setMonth(now.getMonth() + duration);
      break;
  }
  return now;
};

const canBan = (
  bannerRole: string | undefined,
  targetRole: string,
): boolean => {
  if (bannerRole === 'admin') return true;
  if (bannerRole === 'moderator') return targetRole !== 'admin';
  return false;
};

const requireModerator = (reply: FastifyReply): ActivityActor | null => {
  if (!reply.locals || !reply.locals.user) {
    reply.redirect('/login');
    return null;
  }
  const user = reply.locals.user;
  if (!user.isModerator && !user.isAdmin) {
    reply.redirect('/');
    return null;
  }
  return {
    userId: user.userId,
    username: user.username,
    role: user.isAdmin ? 'admin' : 'moderator',
  };
};

const resolveRedirect = (id: string, redirectTo: unknown): string =>
  redirectTo === 'admin-ban-log' ? '/admin/ban-log' : `/profile/${id}`;

export const moderator = async (app: FastifyInstance, config: ViewConfig) => {
  const renderBanPage = (
    reply: FastifyReply,
    target: TargetUserView,
    error: string | null = null,
  ) =>
    reply.view('moderator-ban', {
      ...config,
      target,
      error,
      duration: 1,
      durationUnit: 'days',
      reason: '',
    });

  app.get('/moderator/ban/:id', async (request, reply) => {
    const moderator = requireModerator(reply);
    if (!moderator) return;

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const dbUser = await User.findById(id)
      .select('username avatar role bannedUntil banReason banIP')
      .lean();
    if (!dbUser) {
      return reply.redirect('/');
    }

    return renderBanPage(reply, buildTargetView(dbUser, moderator.role));
  });

  app.post('/moderator/ban/:id', async (request, reply) => {
    const moderator = requireModerator(reply);
    if (!moderator) return;

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const dbUser = await User.findById(id);
    if (!dbUser) {
      return reply.redirect('/');
    }

    if (id === moderator.userId) {
      return reply.redirect(`/profile/${id}`);
    }

    if (!canBan(moderator.role, dbUser.role)) {
      return reply.redirect(`/profile/${id}`);
    }

    const parseResult = banBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderBanPage(
        reply,
        buildTargetView(dbUser, moderator.role),
        parseResult.error.issues[0].message,
      );
    }

    const { duration, durationUnit, reason, banIP } = parseResult.data;

    if (banIP && !dbUser.lastIP) {
      return renderBanPage(
        reply,
        buildTargetView(dbUser, moderator.role),
        'Cannot ban by IP: no IP address has been recorded for this user yet.',
      );
    }

    if (dbUser.banIP) {
      clearIPBan(dbUser.banIP);
    }

    const bannedUntil = computeBannedUntil(duration, durationUnit);
    dbUser.bannedUntil = bannedUntil;
    dbUser.banReason = reason;
    dbUser.banIP = banIP ? dbUser.lastIP : null;
    await dbUser.save();

    if (dbUser.banIP) {
      setIPBan(dbUser.banIP, reason, bannedUntil);
    }

    await BanLog.findOneAndUpdate(
      { user: dbUser._id, active: true },
      {
        user: dbUser._id,
        bannedBy: moderator.userId,
        reason,
        bannedUntil,
        ip: dbUser.banIP,
        active: true,
        unbannedAt: null,
      },
      { upsert: true },
    );

    await logActivity(
      moderator,
      ACTIVITY_ACTIONS.USER_BAN,
      { id, label: dbUser.username },
      reason,
    );

    return reply.redirect(
      resolveRedirect(
        id,
        (request.body as Record<string, unknown>)?.redirectTo,
      ),
    );
  });

  app.post('/moderator/ban/:id/unban', async (request, reply) => {
    const moderator = requireModerator(reply);
    if (!moderator) return;

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const dbUser = await User.findById(id);
    if (!dbUser) {
      return reply.redirect('/');
    }

    if (!canBan(moderator.role, dbUser.role)) {
      return reply.redirect(`/profile/${id}`);
    }

    if (dbUser.banIP) {
      clearIPBan(dbUser.banIP);
    }

    dbUser.bannedUntil = null;
    dbUser.banReason = '';
    dbUser.banIP = null;
    await dbUser.save();

    await BanLog.updateMany(
      { user: dbUser._id, active: true },
      { active: false, unbannedAt: new Date() },
    );

    await logActivity(moderator, ACTIVITY_ACTIONS.USER_UNBAN, {
      id,
      label: dbUser.username,
    });

    return reply.redirect(
      resolveRedirect(
        id,
        (request.body as Record<string, unknown>)?.redirectTo,
      ),
    );
  });

  app.post('/moderator/signature/delete/:id', async (request, reply) => {
    const moderator = requireModerator(reply);
    if (!moderator) return;

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const updated = await User.findByIdAndUpdate(
      id,
      { signature: '' },
      { select: 'username' },
    );
    if (updated) {
      await logActivity(moderator, ACTIVITY_ACTIONS.USER_SIGNATURE_DELETE, {
        id,
        label: updated.username,
      });
    }
    return reply.redirect(`/profile/${id}`);
  });

  app.post('/moderator/bio/delete/:id', async (request, reply) => {
    const moderator = requireModerator(reply);
    if (!moderator) return;

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const updated = await User.findByIdAndUpdate(
      id,
      { bio: '' },
      { select: 'username' },
    );
    if (updated) {
      await logActivity(moderator, ACTIVITY_ACTIONS.USER_BIO_DELETE, {
        id,
        label: updated.username,
      });
    }
    return reply.redirect(`/profile/${id}`);
  });
};
