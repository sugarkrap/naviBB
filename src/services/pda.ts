import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ViewConfig } from '../views';
import { User } from '../schemas/users';
import LATIN_WORDS from '../data/latin-words.json';

const PDA_TEMP_PASSWORD_DURATION_MINUTES = 10;
const PDA_TEMP_PASSWORD_DURATION_MS =
  PDA_TEMP_PASSWORD_DURATION_MINUTES * 60 * 1000;

export const generateTempPassword = (): string => {
  const words: string[] = [];
  for (let i = 0; i < 3; i++) {
    const randomIndex = Math.floor(Math.random() * LATIN_WORDS.length);
    words.push(LATIN_WORDS[randomIndex]);
  }
  return words.join('-');
};

export const register = async (app: FastifyInstance, config: ViewConfig) => {
  app.get('/pda', async (request, reply) => {
    if (!reply.locals?.user) {
      return reply.redirect('/login');
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    const now = new Date();
    const isTempPasswordActive =
      user.tempPassword &&
      user.tempPasswordExpires &&
      user.tempPasswordExpires > now;
    let tempPassword = '';
    let secondsRemaining = 0;

    if (isTempPasswordActive) {
      tempPassword = user.tempPassword || '';
      secondsRemaining = Math.floor(
        (user.tempPasswordExpires!.getTime() - now.getTime()) / 1000,
      );
    }

    return reply.view('pda', {
      ...config,
      tempPassword,
      isTempPasswordActive,
      secondsRemaining,
    });
  });

  app.post('/pda/generate', async (request, reply) => {
    if (!reply.locals?.user) {
      return reply.redirect('/login');
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    const newTempPassword = generateTempPassword();
    const expiresAt = new Date(Date.now() + PDA_TEMP_PASSWORD_DURATION_MS);

    user.tempPassword = newTempPassword;
    user.tempPasswordExpires = expiresAt;
    await user.save();

    const secondsRemaining = PDA_TEMP_PASSWORD_DURATION_MINUTES * 60;

    return reply.view('pda', {
      ...config,
      tempPassword: newTempPassword,
      isTempPasswordActive: true,
      secondsRemaining,
      message: 'Temporary password generated!',
    });
  });

  app.post('/pda/disable', async (request, reply) => {
    if (!reply.locals?.user) {
      return reply.redirect('/login');
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user) {
      return reply.redirect('/login');
    }

    user.tempPassword = null;
    user.tempPasswordExpires = null;
    await user.save();

    return reply.view('pda', {
      ...config,
      tempPassword: '',
      isTempPasswordActive: false,
      secondsRemaining: 0,
      message: 'Temporary password disabled.',
    });
  });
};
