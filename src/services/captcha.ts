import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const OPENCAPTCHA_URL = 'https://api.opencaptcha.io/captcha';
const CAPTCHA_TTL_MS = 600000;
const CAPTCHA_LENGTH = 5;
const CAPTCHA_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

interface CaptchaEntry {
  text: string;
  expiresAt: number;
}

const store = new Map<string, CaptchaEntry>();

const generateText = (): string =>
  Array.from(
    { length: CAPTCHA_LENGTH },
    () => CAPTCHA_CHARS[randomInt(CAPTCHA_CHARS.length)],
  ).join('');

const sweepExpired = (): void => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
};

export const createCaptcha = (): string => {
  sweepExpired();
  const id = randomUUID();
  store.set(id, {
    text: generateText(),
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
  });
  return id;
};

export const verifyCaptcha = (id: string, answer: string): boolean => {
  const entry = store.get(id);
  store.delete(id);
  return (
    !!entry &&
    entry.expiresAt > Date.now() &&
    entry.text === answer.trim().toLowerCase()
  );
};

export const captcha = async (app: FastifyInstance) => {
  app.get('/captcha/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const entry = store.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      return reply.status(404).send({ error: 'Captcha not found' });
    }

    let upstream: Response;
    try {
      upstream = await fetch(OPENCAPTCHA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: entry.text }),
      });
    } catch (err) {
      request.log.warn({ err }, 'OpenCaptcha API unreachable');
      return reply.status(502).send({ error: 'Captcha service unavailable' });
    }

    if (!upstream.ok) {
      request.log.warn({ status: upstream.status }, 'OpenCaptcha API error');
      return reply.status(502).send({ error: 'Captcha service unavailable' });
    }

    return reply
      .type(upstream.headers.get('content-type') ?? 'image/png')
      .header('cache-control', 'no-store')
      .send(Buffer.from(await upstream.arrayBuffer()));
  });
};
