import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { User } from '../schemas/users';
import { hashPassword } from './auth';
import { createCaptcha, verifyCaptcha } from './captcha';
import { ViewConfig } from '../views';

const registerBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  confirmPassword: z
    .string()
    .min(8, 'Confirm Password must be at least 8 characters long'),
  captchaId: z.string('Captcha is required').min(1, 'Captcha is required'),
  captcha: z.string('Captcha is required').min(1, 'Captcha is required'),
});

export const generateActivationToken = (): string =>
  randomBytes(32).toString('hex');

export const register = async (
  app: FastifyInstance,
  config: ViewConfig,
  sendActivationEmail: (
    to: string,
    token: string,
    baseUrl: string,
  ) => Promise<void>,
) => {
  const renderRegister = (
    reply: FastifyReply,
    feedback: { error?: string; message?: string },
  ) =>
    reply.view('register', {
      ...config,
      captchaId: createCaptcha(),
      ...feedback,
    });

  app.post('/register', async (request, reply) => {
    if (!request.body || Object.keys(request.body).length === 0) {
      return renderRegister(reply, {
        error:
          'Request body is required. Send a JSON object with username, email, and password.',
      });
    }

    const parseResult = registerBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      return renderRegister(reply, {
        error: firstError.message,
      });
    }

    const { username, email, password, confirmPassword, captchaId, captcha } =
      parseResult.data;

    if (!verifyCaptcha(captchaId, captcha)) {
      return renderRegister(reply, {
        error: 'Captcha does not match, please try again',
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return renderRegister(reply, {
        error: 'User with this email already exists',
      });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return renderRegister(reply, {
        error: 'Username already taken',
      });
    }

    if (password !== confirmPassword) {
      return renderRegister(reply, {
        error: 'Passwords do not match',
      });
    }

    const hashedPassword = await hashPassword(password);

    const newUser = new User({
      username,
      email: email.toLowerCase(),
      password: hashedPassword,
      isActive: false,
      activationToken: generateActivationToken(),
    });

    try {
      await sendActivationEmail(
        newUser.email,
        newUser.activationToken,
        config.boardBaseURL,
      );
    } catch (err) {
      request.log.warn(
        {
          err,
          email: newUser.email,
        },
        'Failed to send activation email; registration aborted',
      );

      return renderRegister(reply, {
        error:
          'We could not send the activation email to this address. Please check the email address and try again later.',
      });
    }

    try {
      await newUser.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        //that's so dirty lol but hey it works
        return renderRegister(reply, {
          error: 'Username or email already taken',
        });
      }
      throw err;
    }

    return renderRegister(reply, {
      message:
        'User registered successfully. Please check your email to activate your account.',
    });
  });
};
