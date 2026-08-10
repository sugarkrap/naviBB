import type { FastifyInstance } from 'fastify';
import { User } from '../schemas/users';
import { setAuthCookie } from './auth';
import { ViewConfig } from '../views';

export const activate = async (
    app: FastifyInstance,
    config: ViewConfig
) => {
  app.get('/activate/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const user = await User.findOne({ activationToken: token });
    if (!user)
      return reply.view('login', {
        ...config,
        error: 'Invalid activation token'
      });

    const bannedUntil = user.bannedUntil ? new Date(user.bannedUntil) : null;
    if (bannedUntil && bannedUntil.getTime() > Date.now()) {
      return reply.view('banned', {
        ...config,
        banReason: user.banReason,
        bannedUntil: user.bannedUntil,
      });
    }

    user.isActive = true;
    user.activationToken = '';
    await user.save();

    const jwtToken = await reply.jwtSign({
      userId: user._id.toString(),
      email: user.email,
      username: user.username,
    });

    setAuthCookie(reply, jwtToken);
    return reply.redirect(config.boardBaseURL);
  });
};
