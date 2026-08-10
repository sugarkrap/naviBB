import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ViewConfig } from '../views';

import { User } from '../schemas/users';

export interface JWTPayload {
  userId: string;
  email: string;
  username: string;
}

export const avatarUrlFor = (avatar?: string): string | null =>
  avatar ? `/static/avatars/${avatar}` : null;

const SALT_ROUNDS = 10;
export const COOKIE_NAME = 'navibb_auth_token';
const COOKIE_MAX_AGE_MS = 604800000; // big shoe lmao

// may need to divide this service into micro services, this is becoming ilisible
export const hashPassword = async (password: string): Promise<string> =>
  bcrypt.hash(password, SALT_ROUNDS);

export const verifyPassword = async (
  password: string,
  hash: string,
): Promise<boolean> => bcrypt.compare(password, hash);

export const setAuthCookie = (reply: FastifyReply, token: string): void => {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
};

export const clearAuthCookie = (reply: FastifyReply): void => {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
};

export const authenticate = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  try {
    await request.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
};

export const register = async (app: FastifyInstance, config: ViewConfig) => {
  app.post('/login', async (request, reply) => {
    const body = request.body as {
      email?: string;
      password?: string;
      passwordType?: string;
    };
    const isUnsecuredConnection =
      request.headers['x-navi-unsecured'] === 'true';

    if (!body?.email || !body?.password) {
      return reply.view('login', {
        ...config,
        error: 'Email and password are required',
        isUnsecuredConnection,
      });
    }

    const user = await User.findOne({ email: body.email.toLowerCase() });
    if (!user) {
      return reply.view('login', {
        ...config,
        error: 'Invalid email or password',
        isUnsecuredConnection,
      });
    }

    if (!user.isActive) {
      return reply.status(401).view('login', {
        ...config,
        error: 'Account is not activated. Please check your email.',
        isUnsecuredConnection,
      });
    }

    const passwordType = body.passwordType || 'regular';
    let isValidPassword = false;

    if (passwordType === 'temp') {
      if (
        user.tempPassword &&
        user.tempPasswordExpires &&
        user.tempPasswordExpires > new Date()
      ) {
        isValidPassword = body.password === user.tempPassword;
      }
    } else {
      isValidPassword = await verifyPassword(body.password, user.password);
    }

    if (!isValidPassword) {
      return reply.view('login', {
        ...config,
        error: 'Invalid email or password',
        isUnsecuredConnection,
      });
    }

    const token = await reply.jwtSign({
      userId: user._id.toString(),
      email: user.email,
      username: user.username,
    });

    setAuthCookie(reply, token);
    return reply.redirect(config.boardBaseURL);
  });

  app.get('/logout', async (_, reply) => {
    clearAuthCookie(reply);
    return reply.redirect(config.boardBaseURL);
  });
};
