import type { FastifyInstance } from 'fastify';
import type { Types } from 'mongoose';
import { createCaptcha } from './services/captcha';
import { buildCategoryBoxes, pageForPost } from './services/forum';
import { renderPost } from './services/formatting';
import { getOnlineStats } from './services/presence';
import { getIPBan } from './services/ip-bans';
import { Thread } from './schemas/threads';
import { Post } from './schemas/posts';
import { User } from './schemas/users';
import { WelcomeMessage } from './schemas/welcome-message';

interface PopulatedAuthor {
  _id: Types.ObjectId;
  username: string;
}

export interface ViewConfig {
  boardName: string;
  boardTagline: string;
  boardBaseURL: string;
}

export async function registerRoutes(app: FastifyInstance, config: ViewConfig) {
  app.get('/', async (_, reply) => {
    const [categoryBoxes, welcomeMessage, online, latestMember, latestThread] =
      await Promise.all([
        buildCategoryBoxes(),
        WelcomeMessage.findOne().lean(),
        getOnlineStats(),
        User.findOne().sort('-createdAt').select('username').lean(),
        Thread.findOne()
          .sort('-createdAt')
          .populate<{ author: PopulatedAuthor }>('author', 'username')
          .lean(),
      ]);

    const welcomeMessageHtml =
      welcomeMessage?.enabled && welcomeMessage.content
        ? renderPost(welcomeMessage.content, welcomeMessage.processor)
        : null;

    interface LatestPostInfo {
      _id: Types.ObjectId;
      threadId: Types.ObjectId;
      page: number;
      title: string;
      locked: boolean;
      authorId: Types.ObjectId | null;
      authorName: string;
    }

    let latestPost: LatestPostInfo | null = null;
    if (latestThread) {
      const lastPost = await Post.findOne({ thread: latestThread._id })
        .sort('-createdAt')
        .populate<{ author: PopulatedAuthor }>('author', 'username')
        .lean();
      if (lastPost) {
        latestPost = {
          _id: lastPost._id,
          threadId: latestThread._id,
          page: await pageForPost(lastPost),
          title: latestThread.title,
          locked: latestThread.locked ?? false,
          authorId: lastPost.author?._id ?? null,
          authorName: lastPost.author?.username ?? 'unknown',
        };
      }
    }

    return reply.view('index', {
      ...config,
      categoryBoxes,
      welcomeMessageHtml,
      stats: {
        users: online.users,
        guests: online.guests,
        peakCount: online.peakCount,
        peakAt: online.peakAt,
        latestMember: latestMember
          ? { _id: latestMember._id, username: latestMember.username }
          : null,
        latestPost,
      },
    });
  });

  app.post('/accept-cookies', async (request, reply) => {
    reply.setCookie('navibb_cookie_consent', '1', {
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
      httpOnly: true,
      sameSite: 'lax',
    });
    const referer = request.headers.referer || '/';
    return reply.redirect(referer);
  });

  app.get('/login', async (_, reply) => {
    if (reply.locals && reply.locals.user) {
      return reply.redirect('/profile');
    }
    // Check if connection is unsecured (HTTP)
    const isUnsecuredConnection = _.headers['x-navi-unsecured'] === 'true';
    return reply.view('login', { ...config, isUnsecuredConnection });
  });

  app.get('/register', async (_, reply) => {
    if (reply.locals && reply.locals.user) {
      return reply.redirect('/profile');
    }
    return reply.view('register', { ...config, captchaId: createCaptcha() });
  });

  app.get('/privacy-policy', async (_, reply) => {
    return reply.view('privacy-policy', config);
  });

  app.get('/disabled', async (_, reply) => {
    return reply.view('disabled', config);
  });

  app.get('/banned', async (request, reply) => {
    const localUser = reply.locals?.user;
    let banReason = '';
    let bannedUntil: Date | null = null;
    if (localUser) {
      const user = await User.findById(localUser.userId)
        .select('bannedUntil banReason')
        .lean();
      if (user) {
        bannedUntil = user.bannedUntil ? new Date(user.bannedUntil) : null;
        banReason = user.banReason ?? '';
      }
    } else {
      const ipBan = getIPBan(request.ip);
      if (ipBan) {
        banReason = ipBan.reason;
        bannedUntil = ipBan.bannedUntil;
      }
    }
    return reply.view('banned', {
      ...config,
      banReason,
      bannedUntil,
    });
  });

  // finally doooone with the tedious user CRUD, now the fun part!!
  // profile!

  const profilePages: [string, string][] = [
    ['/profile', 'profile'],
    ['/profile/bio', 'profile-bio'],
    ['/profile/signature', 'profile-signature'],
    ['/profile/password', 'profile-password'],
    ['/profile/privacy', 'profile-privacy'],
  ];

  for (const [path, template] of profilePages) {
    app.get(path, async (_, reply) => {
      if (!reply.locals || !reply.locals.user) {
        return reply.redirect('/login');
      }

      return reply.view(template, { ...config, user: reply.locals.user });
    });
  }
}
