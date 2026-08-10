const onlineUsers = new Map<string, number>();
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import { User } from '../schemas/users';
import { Thread } from '../schemas/threads';
import { Post } from '../schemas/posts';
import {
  setAuthCookie,
  clearAuthCookie,
  hashPassword,
  verifyPassword,
  avatarUrlFor,
} from './auth';
import { generateActivationToken } from './register';
import { ViewConfig } from '../views';

const USERNAME_CHANGE_COOLDOWN_MONTHS = 6;

const ROLE_ICONS: Record<string, string> = {
  admin: 'administration-24.png',
  moderator: 'gnome-eyes-24.png',
  user: 'music-player-24.png',
};

const usernameBodySchema = z.object({
  newUsername: z.string().trim().min(1, 'Username is required'),
});

const emailBodySchema = z.object({
  newEmail: z.string().email('Invalid email address'),
});

const passwordBodySchema = z.object({
  currentPassword: z
    .string('Current password is required')
    .min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters long'),
  confirmPassword: z
    .string()
    .min(8, 'Confirm Password must be at least 8 characters long'),
});

const bioBodySchema = z.object({
  bio: z.string().max(128, 'Bio must be at most 128 characters long'),
});

const signatureBodySchema = z.object({
  signature: z.string(),
  signatureProcessor: z.enum(['bbcode', 'markdown']).default('bbcode'),
});

const nextChangeAllowedAt = (changedAt: Date): Date => {
  const next = new Date(changedAt);
  next.setMonth(next.getMonth() + USERNAME_CHANGE_COOLDOWN_MONTHS);
  return next;
};

export const profile = async (
  app: FastifyInstance,
  config: ViewConfig,
  sendActivationEmail: (
    to: string,
    token: string,
    baseUrl: string,
  ) => Promise<void>,
) => {
  const renderProfile = (
    reply: FastifyReply,
    feedback: { error?: string; message?: string },
    template = 'profile',
  ) =>
    reply.view(template, {
      ...config,
      user: reply.locals!.user,
      ...feedback,
    });

  app.post('/profile/username', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const parseResult = usernameBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderProfile(reply, {
        error: parseResult.error.issues[0].message,
      });
    }

    const { newUsername } = parseResult.data;
    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    if (user.usernameChangedAt) {
      const allowedAt = nextChangeAllowedAt(user.usernameChangedAt);
      if (allowedAt > new Date()) {
        return renderProfile(reply, {
          error: `You can change your username again on ${allowedAt.toDateString()}.`,
        });
      }
    }

    if (newUsername === user.username) {
      return renderProfile(reply, {
        error: 'This is already your username',
      });
    }

    const taken = await User.findOne({ username: newUsername });
    if (taken) {
      return renderProfile(reply, { error: 'Username already taken' });
    }

    user.username = newUsername;
    user.usernameChangedAt = new Date();
    try {
      await user.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // lost a race on the unique index
        return renderProfile(reply, { error: 'Username already taken' });
      }
      throw err;
    }

    const token = await reply.jwtSign({
      userId: user._id.toString(),
      email: user.email,
      username: user.username,
    });
    setAuthCookie(reply, token);

    reply.locals.user.username = newUsername;
    return renderProfile(reply, { message: 'Username updated successfully' });
  });

  app.post('/profile/email', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const parseResult = emailBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderProfile(reply, {
        error: parseResult.error.issues[0].message,
      });
    }

    const newEmail = parseResult.data.newEmail.toLowerCase();
    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    if (newEmail === user.email) {
      return renderProfile(reply, { error: 'This is already your email' });
    }

    const taken = await User.findOne({ email: newEmail });
    if (taken) {
      return renderProfile(reply, { error: 'Email already in use' });
    }

    const activationToken = generateActivationToken();
    try {
      await sendActivationEmail(newEmail, activationToken, config.boardBaseURL);
    } catch (err) {
      request.log.warn(
        { err, email: newEmail },
        'Failed to send re-activation email; email change aborted',
      );
      return renderProfile(reply, {
        error:
          'We could not send the activation email to this address. Please check the email address and try again later.',
      });
    }

    user.email = newEmail;
    user.isActive = false;
    user.activationToken = activationToken;
    try {
      await user.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // lost a race on the unique index
        return renderProfile(reply, { error: 'Email already in use' });
      }
      throw err;
    }

    // the JWT carries the email, so re-issue the auth cookie
    const token = await reply.jwtSign({
      userId: user._id.toString(),
      email: user.email,
      username: user.username,
    });
    setAuthCookie(reply, token);

    reply.locals.user.email = newEmail;
    return renderProfile(reply, {
      message:
        'Email updated. Your account is disabled until you activate it from the link sent to your new address.',
    });
  });

  app.post('/profile/password', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const parseResult = passwordBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderProfile(
        reply,
        { error: parseResult.error.issues[0].message },
        'profile-password',
      );
    }

    const { currentPassword, newPassword, confirmPassword } = parseResult.data;

    if (newPassword !== confirmPassword) {
      return renderProfile(
        reply,
        { error: 'Passwords do not match' },
        'profile-password',
      );
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    const valid = await verifyPassword(currentPassword, user.password);
    if (!valid) {
      return renderProfile(
        reply,
        { error: 'Current password is incorrect' },
        'profile-password',
      );
    }

    user.password = await hashPassword(newPassword);
    await user.save();

    return renderProfile(
      reply,
      { message: 'Password updated successfully' },
      'profile-password',
    );
  });

  app.get('/profile/data', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const user = await User.findById(reply.locals.user.userId).lean();
    if (!user) {
      return reply.redirect('/login');
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      password: _password,
      activationToken: _activationToken,
      ...data
    } = user;
    /* eslint-enable @typescript-eslint/no-unused-vars */

    return reply
      .header(
        'Content-Disposition',
        `attachment; filename="navibb-${user.username}-data.json"`,
      )
      .type('application/json')
      .send(JSON.stringify(data, null, 2));
  });

  app.get('/confirm-deletion', async (_, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    return reply.view('confirm-deletion', {
      ...config,
      user: reply.locals.user,
    });
  });

  app.post('/confirm-deletion', async (_, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    await User.deleteOne({ _id: reply.locals.user.userId });
    clearAuthCookie(reply);
    return reply.redirect('/');
  });

  app.post('/profile/bio', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const parseResult = bioBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderProfile(
        reply,
        { error: parseResult.error.issues[0].message },
        'profile-bio',
      );
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    user.bio = parseResult.data.bio;
    await user.save();

    reply.locals.user.bio = user.bio;
    return renderProfile(
      reply,
      { message: 'Bio updated successfully' },
      'profile-bio',
    );
  });

  app.post('/profile/signature', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const parseResult = signatureBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return renderProfile(
        reply,
        { error: parseResult.error.issues[0].message },
        'profile-signature',
      );
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    user.signature = parseResult.data.signature;
    user.signatureProcessor = parseResult.data.signatureProcessor;
    await user.save();

    reply.locals.user.signature = user.signature;
    reply.locals.user.signatureProcessor = user.signatureProcessor;
    return renderProfile(
      reply,
      { message: 'Signature updated successfully' },
      'profile-signature',
    );
  });

  app.get('/profile/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const profileUser = await User.findById(id)
      .select(
        'username avatar role bio signature bannedUntil banReason createdAt',
      )
      .lean();
    if (!profileUser) {
      return reply.redirect('/');
    }

    const [threadCount, postCount, recentThreads] = await Promise.all([
      Thread.countDocuments({ author: profileUser._id }),
      Post.countDocuments({ author: profileUser._id }),
      Thread.find({ author: profileUser._id })
        .sort('-createdAt')
        .limit(10)
        .populate<{ category: { name: string } | null }>('category', 'name')
        .lean<
          {
            _id: Types.ObjectId;
            title: string;
            locked: boolean;
            category: { name: string } | null;
            createdAt: Date;
          }[]
        >(),
    ]);

    const bannedUntil = profileUser.bannedUntil
      ? new Date(profileUser.bannedUntil)
      : null;

    return reply.view('user-profile', {
      ...config,
      profileUser: {
        _id: profileUser._id as Types.ObjectId,
        username: profileUser.username,
        avatarURL: avatarUrlFor(profileUser.avatar),
        role: profileUser.role,
        roleIcon: ROLE_ICONS[profileUser.role] ?? ROLE_ICONS.user,
        bio: profileUser.bio,
        signature: profileUser.signature,
        isBanned: !!bannedUntil && bannedUntil.getTime() > Date.now(),
        bannedUntil,
        banReason: profileUser.banReason,
        createdAt: profileUser.createdAt,
      },
      threadCount,
      postCount,
      recentThreads: recentThreads.map((thread) => ({
        _id: thread._id,
        type: 'Thread',
        title: thread.title,
        locked: thread.locked ?? false,
        categoryName: thread.category?.name ?? 'unknown',
        createdAt: thread.createdAt,
      })),
    });
  });
};
