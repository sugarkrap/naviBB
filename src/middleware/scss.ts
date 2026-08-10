import { compile } from 'sass';
import { existsSync } from 'node:fs';
import {
 join, basename 
} from 'node:path';
import type { FastifyInstance } from 'fastify';
import middie from '@fastify/middie';

const STYLES_ROOT = join(__dirname, '..', 'styles');

export async function registerScssMiddleware(app: FastifyInstance) {
  await app.register(middie);

  app.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      !req.url.startsWith('/static/') ||
      !req.url.endsWith('.css')
    ) {
      return next();
    }

    const scssFile = basename(req.url, '.css') + '.scss';
    const scssPath = join(STYLES_ROOT, scssFile);

    if (!existsSync(scssPath)) {
      return next();
    }

    try {
      const result = compile(scssPath, {
        style: 'compressed',
        sourceMap: false,
      });

      res.setHeader('Content-Type', 'text/css');
      res.end(result.css);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'SCSS compilation failed');
    }
  });
}
