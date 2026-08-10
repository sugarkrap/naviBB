import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { User } from '../schemas/users';
import { avatarUrlFor } from './auth';
import { resizeImage } from './images';
import { ViewConfig } from '../views';

const AVATARS_DIR = join(__dirname, '..', 'public', 'avatars');

export const EXTENSIONS_BY_MIMETYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const deleteAvatarFile = async (filename: string): Promise<void> => {
  try {
    await unlink(join(AVATARS_DIR, filename));
  } catch {
    // already gone, nothing to do
  }
};

export const avatar = async (app: FastifyInstance, config: ViewConfig) => {
  const renderProfile = (
    reply: FastifyReply,
    feedback: { error?: string; message?: string },
  ) =>
    reply.view('profile', {
      ...config,
      user: reply.locals!.user,
      ...feedback,
    });

  app.post('/profile/avatar', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const data = await request.file();
    if (!data) {
      return renderProfile(reply, { error: 'No avatar file was uploaded' });
    }

    const extension = EXTENSIONS_BY_MIMETYPE[data.mimetype];
    if (!extension) {
      return renderProfile(reply, {
        error: 'Unsupported image format. Use PNG, JPEG, GIF or WebP.',
      });
    }

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      return renderProfile(reply, { error: 'Avatar is too large (10MB max)' });
    }

    let resized: Buffer;
    try {
      resized = await resizeImage(buffer);
    } catch {
      return renderProfile(reply, {
        error: 'This file does not look like a readable image',
      });
    }

    const filename = `${reply.locals.user.userId}.png`;
    await writeFile(join(AVATARS_DIR, filename), resized);

    await User.updateOne(
      { _id: reply.locals.user.userId },
      { $set: { avatar: filename } },
    );

    reply.locals.user.avatarURL = avatarUrlFor(filename);
    return renderProfile(reply, { message: 'Avatar updated successfully' });
  });

  app.post('/profile/avatar/delete', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const user = await User.findById(reply.locals.user.userId);
    if (!user || !user.avatar) {
      return renderProfile(reply, { error: 'No avatar to delete' });
    }

    await deleteAvatarFile(user.avatar);
    user.avatar = '';
    await user.save();

    reply.locals.user.avatarURL = avatarUrlFor();
    return renderProfile(reply, { message: 'Avatar deleted successfully' });
  });
};
