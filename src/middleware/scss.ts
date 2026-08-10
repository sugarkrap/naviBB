import { compile } from 'sass';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import middie from '@fastify/middie';

const STYLES_ROOT = join(__dirname, '..', 'styles');

interface CompiledEntry {
  css: string;
  lastModified: Date;
  watchedFiles: Map<string, number>;
}

const cache = new Map<string, CompiledEntry>();

const mtimeOf = (path: string): number => statSync(path).mtimeMs;

const compileFresh = (scssPath: string): CompiledEntry => {
  const result = compile(scssPath, { style: 'compressed', sourceMap: false });

  const watchedFiles = new Map<string, number>();
  watchedFiles.set(scssPath, mtimeOf(scssPath));
  for (const url of result.loadedUrls) {
    if (url.protocol !== 'file:') continue;
    const path = fileURLToPath(url);
    if (!watchedFiles.has(path)) watchedFiles.set(path, mtimeOf(path));
  }

  let newestMtime = 0;
  for (const mtime of watchedFiles.values()) {
    newestMtime = Math.max(newestMtime, mtime);
  }
  const lastModified = new Date(Math.floor(newestMtime / 1000) * 1000);

  return { css: result.css, lastModified, watchedFiles };
};

const isStale = (entry: CompiledEntry): boolean => {
  for (const [path, mtime] of entry.watchedFiles) {
    try {
      if (statSync(path).mtimeMs !== mtime) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const getCompiled = (scssPath: string): CompiledEntry => {
  const cached = cache.get(scssPath);
  if (cached && !isStale(cached)) return cached;
  const fresh = compileFresh(scssPath);
  cache.set(scssPath, fresh);
  return fresh;
};

export async function registerScssMiddleware(app: FastifyInstance) {
  await app.register(middie);

  for (const file of readdirSync(STYLES_ROOT)) {
    if (extname(file) === '.scss') {
      try {
        getCompiled(join(STYLES_ROOT, file));
      } catch (err) {
        app.log.warn({ err, file }, 'failed to pre-compile stylesheet');
      }
    }
  }

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
      const entry = getCompiled(scssPath);

      res.setHeader('Content-Type', 'text/css');
      res.setHeader('Last-Modified', entry.lastModified.toUTCString());
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');

      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince && new Date(ifModifiedSince) >= entry.lastModified) {
        res.statusCode = 304;
        res.end();
        return;
      }

      res.end(entry.css);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'SCSS compilation failed');
    }
  });
}
