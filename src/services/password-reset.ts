import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { User } from '../schemas/users';
import { hashPassword } from './auth';
import { ViewConfig } from '../views';

export const RESET_TOKEN_TTL_MS = 3600000; // 1 hour

const forgotBodySchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetBodySchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

export const generateResetToken = (): string =>
  randomBytes(32).toString('hex');

const findByResetToken = (token: string) =>
  User.findOne({
    passwordResetToken: token,
    passwordResetExpires: { $gt: new Date() },
  });

export const passwordReset = async (
  app: FastifyInstance,
  config: ViewConfig,
  sendPasswordResetEmail: (to: string, token: string, baseUrl: string) => Promise<void>,
) => {
  app.get('/forgot-password', async (_, reply) => {
    return reply.view('forgot-password', config);
  });

  app.post('/forgot-password', async (request, reply) => {
    const parseResult = forgotBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.view('forgot-password', {
        ...config,
        error: parseResult.error.issues[0].message,
      });
    }

    const user = await User.findOne({
      email: parseResult.data.email.toLowerCase(),
    });

    if (user && user.isActive) {
      user.passwordResetToken = generateResetToken();
      user.passwordResetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      try {
        await sendPasswordResetEmail(
          user.email,
          user.passwordResetToken,
          config.boardBaseURL,
        );
        await user.save();
      } catch (err) {
        request.log.warn({ err, email: user.email }, 'Failed to send password reset email');
        return reply.view('forgot-password', {
          ...config,
          error: 'We could not send the password reset email to this address. Please try again later.',
        });
      }
    }

    return reply.view('forgot-password', {
      ...config,
      message: 'If an account exists for this address, a password reset link has been sent.',
    });
  });

  app.get('/reset-password/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const user = await findByResetToken(token);
    if (!user) {
      return reply.view('login', {
        ...config,
        error: 'Invalid or expired password reset link',
      });
    }

    return reply.view('reset-password', { ...config, token });
  });

  app.post('/reset-password/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const user = await findByResetToken(token);
    if (!user) {
      return reply.view('login', {
        ...config,
        error: 'Invalid or expired password reset link',
      });
    }

    const parseResult = resetBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.view('reset-password', {
        ...config,
        token,
        error: parseResult.error.issues[0].message,
      });
    }

    user.password = await hashPassword(parseResult.data.password);
    user.passwordResetToken = '';
    user.passwordResetExpires = null;

    user.isActive = true;
    await user.save();

    return reply.view('login', {
      ...config,
      message: 'Password updated. You can now log in with your new password.',
    });
  });
};
