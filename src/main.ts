import 'dotenv/config';

// here comes the adams familly of the backend dev
import Fastify from 'fastify';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import ejs from 'ejs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

import { registerRoutes as registerViews, ViewConfig } from './views';
import { registerScssMiddleware as registerSCSSMiddleware } from './middleware/scss';
import {
  createMailService,
  createMailTransporter,
  type MailConfig,
} from './services/mail';
import { register as registerRegister } from './services/register';
import {
  avatarUrlFor,
  COOKIE_NAME,
  register as registerAuth,
  type JWTPayload,
} from './services/auth';
import { User } from './schemas/users';
import { activate as registerActivate } from './services/activate';
import { passwordReset as registerPasswordReset } from './services/password-reset';
import { avatar as registerAvatar } from './services/avatar';
import { IMAGE_SIZE_LIMIT } from './services/images';
import { profile as registerProfile } from './services/profile';
import { captcha as registerCaptcha } from './services/captcha';
import { admin as registerAdmin } from './services/admin';
import { forum as registerForum } from './services/forum';
import { moderator as registerModerator } from './services/moderator';
import { register as registerPDA } from './services/pda';
import { search as registerSearch } from './services/search';
import { touch } from './services/presence';
import { getIPBan, loadBannedIPs } from './services/ip-bans';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';

export interface LocalUser extends JWTPayload {
  avatarURL: string | null;
  isAdmin: boolean;
  isModerator: boolean;
  isActive: boolean;
  isBanned: boolean;
  bio: string;
  signature: string;
  signatureProcessor: 'bbcode' | 'markdown';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}

declare module 'fastify' {
  interface FastifyReply {
    locals: { user: LocalUser | null; cookiesAccepted: boolean } | null;
  }
}

const config = {
  boardName: process.env.BOARD_NAME || 'naviBB',
  boardTagline: process.env.BOARD_TAGLINE,
  boardBaseURL: process.env.BOARD_BASE_URL || 'http://localhost:8080/',
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production',
};

const mailConfig: MailConfig = {
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : Number(process.env.SMTP_PORT || 587) === 465,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'noreply@navibb.local',
};

const bootstrap = async () => {
  const app = Fastify({ logger: true });
  const mailTransporter = createMailTransporter(mailConfig);
  const mailService = createMailService(mailConfig, mailTransporter);

  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: IMAGE_SIZE_LIMIT,
      files: 10,
    },
  });
  await app.register(fastifyCookie, { secret: config.JWT_SECRET });
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    cookie: {
      cookieName: COOKIE_NAME,
      signed: false,
    },
  });

  app.addHook('preHandler', async (request, reply) => {
    const cookiesAccepted = request.cookies.navibb_cookie_consent === '1';
    try {
      await request.jwtVerify();
      const dbUser = await User.findByIdAndUpdate(
        request.user.userId,
        { lastIP: request.ip },
        { new: false },
      )
        .select(
          'avatar role isActive bannedUntil bio signature signatureProcessor',
        )
        .lean();

      const bannedUntil = dbUser?.bannedUntil
        ? new Date(dbUser.bannedUntil)
        : null;
      const isBanned = !!bannedUntil && bannedUntil.getTime() > Date.now();

      reply.locals = {
        user: {
          ...request.user,
          avatarURL: avatarUrlFor(dbUser?.avatar),
          isAdmin: dbUser?.role === 'admin',
          isModerator: dbUser?.role === 'moderator' || dbUser?.role === 'admin',
          isActive: dbUser?.isActive ?? false,
          isBanned,
          bio: dbUser?.bio ?? '',
          signature: dbUser?.signature ?? '',
          signatureProcessor: dbUser?.signatureProcessor ?? 'bbcode',
        },
        cookiesAccepted,
      };
    } catch {
      reply.locals = { user: null, cookiesAccepted };
    }

    const user = reply.locals.user;
    touch(user ? user.userId : null, request.ip);

    const ipBanned = !user?.isBanned && getIPBan(request.ip) !== null;

    if (user && (!user.isActive || user.isBanned)) {
      const url = request.raw.url ?? '';
      const allowed = user.isBanned
        ? url.startsWith('/banned') ||
          url.startsWith('/logout') ||
          url.startsWith('/static')
        : url.startsWith('/disabled') ||
          url.startsWith('/activate') ||
          url.startsWith('/logout') ||
          url.startsWith('/static');
      if (!allowed) {
        return reply.redirect(user.isBanned ? '/banned' : '/disabled');
      }
    } else if (ipBanned) {
      const url = request.raw.url ?? '';
      const allowed =
        url.startsWith('/banned') ||
        url.startsWith('/logout') ||
        url.startsWith('/static');
      if (!allowed) {
        return reply.redirect('/banned');
      }
    }
  });

  app.register(fastifyView, {
    engine: { ejs },
    root: join(__dirname, 'views'),
    layout: 'layout.ejs',
    includeViewExtension: true,
    propertyName: 'view',
  });

  await registerSCSSMiddleware(app);

  app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/static/',
    decorateReply: false,
  });

  // Browsers request /favicon.ico at the root, not under /static/, so it
  // needs its own route.
  const favicon = readFileSync(join(__dirname, 'public', 'favicon.ico'));
  app.get('/favicon.ico', (_, reply) => {
    reply.header('Content-Type', 'image/x-icon');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(favicon);
  });

  await registerViews(app, config as ViewConfig);
  await registerAuth(app, config as ViewConfig);
  await registerActivate(app, config as ViewConfig);
  await registerRegister(
    app,
    config as ViewConfig,
    mailService.sendActivationEmail,
  );
  await registerPasswordReset(
    app,
    config as ViewConfig,
    mailService.sendPasswordResetEmail,
  );
  await registerAvatar(app, config as ViewConfig);
  await registerCaptcha(app);
  await registerAdmin(
    app,
    config as ViewConfig,
    mailService.sendPasswordResetEmail,
  );
  await registerProfile(
    app,
    config as ViewConfig,
    mailService.sendActivationEmail,
  );
  await registerForum(app, config as ViewConfig);
  await registerModerator(app, config as ViewConfig);
  await registerPDA(app, config as ViewConfig);
  await registerSearch(app, config as ViewConfig);

  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/navibb';
  await mongoose.connect(uri);
  console.log('connected to MongoDB');

  await mongoose.syncIndexes();

  await loadBannedIPs();

  try {
    await mailService.verifySmtpConnection();
    console.log('connected to SMTP server');
  } catch (err) {
    console.warn('SMTP connection failed; emails will not be sent', err);
  }

  const port = Number(process.env.PORT || 8080);
  await app.listen({
    port,
    host: '0.0.0.0',
  });
  console.log(`naviBB is running on http://localhost:${port}`);
};

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
