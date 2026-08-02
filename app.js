'use strict';

const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const { createDefaultTabletRepository, resolveRedisCredentials } = require('./lib/tablet-repository');

dotenv.config({ path: path.join(__dirname, '.env') });

const CREATE_COOKIE = 'riddle_create_access';

class RateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, max = 10, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.entries = new Map();
  }

  check(key) {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (current.count >= this.max) {
      return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
    }
    current.count += 1;
    return { allowed: true, retryAfter: 0 };
  }
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  });
  return cookies;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function accessToken(password) {
  return crypto.createHmac('sha256', password).update('riddle-create-access-v1').digest('base64url');
}

function hasCreateAccess(req, config) {
  if (!config.createPassword) return false;
  return safeEqual(parseCookies(req.headers.cookie)[CREATE_COOKIE], accessToken(config.createPassword));
}

function createApp(options = {}) {
  const config = {
    createPassword: process.env.CREATE_PASSWORD || '',
    cookieTtlSeconds: Number(process.env.CREATE_COOKIE_TTL_SECONDS) || 8 * 60 * 60,
    inputLimit: '8kb',
    logRequests: process.env.LOG_REQUESTS !== 'false',
    ...(options.config || {})
  };
  const repository = options.tabletRepository || createDefaultTabletRepository(__dirname);
  const loginLimiter = options.loginLimiter || new RateLimiter();
  const logger = options.logger || console;
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use((req, res, next) => {
    const started = Date.now();
    res.once('finish', () => {
      if (config.logRequests && logger && typeof logger.log === 'function') {
        logger.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
    next();
  });
  app.use(express.json({ limit: config.inputLimit, strict: true }));

  const requireCreateAccess = (req, res, next) => {
    if (hasCreateAccess(req, config)) return next();
    return res.status(401).json({ error: 'create_auth_required', message: 'The scribe’s chamber is locked.' });
  };

  app.get('/api/tablets', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tablets: await repository.list() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/create/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured: Boolean(config.createPassword), authenticated: hasCreateAccess(req, config) });
  });

  app.post('/api/create/login', (req, res) => {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const attempt = loginLimiter.check(address);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait before trying again.' });
    }
    if (!config.createPassword) {
      return res.status(503).json({ error: 'password_unconfigured', message: 'Create access has not been configured.' });
    }
    const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!safeEqual(supplied, config.createPassword)) {
      return res.status(401).json({ error: 'invalid_password', message: 'That password did not open the chamber.' });
    }
    const attributes = [
      `${CREATE_COOKIE}=${accessToken(config.createPassword)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${config.cookieTtlSeconds}`
    ];
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
    return res.json({ authenticated: true });
  });

  async function saveTablet(req, res, next, id = null) {
    try {
      const tablet = await repository.save(req.body || {}, id);
      res.status(id ? 200 : 201).json({ tablet });
    } catch (error) {
      if (error && (error.code === 'invalid_tablet' || error.code === 'invalid_tablet_id')) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      next(error);
    }
  }

  app.post('/api/tablets', requireCreateAccess, async (req, res, next) => {
    await saveTablet(req, res, next, req.body && req.body.id ? req.body.id : null);
  });
  app.put('/api/tablets/:id', requireCreateAccess, async (req, res, next) => {
    await saveTablet(req, res, next, req.params.id);
  });

  app.get(['/create', '/create.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const file = hasCreateAccess(req, config)
      ? path.join(__dirname, 'views', 'create.html')
      : path.join(__dirname, 'public', 'create-login.html');
    res.sendFile(file);
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(response, filePath) {
      if (/\.(?:html|css|js)$/i.test(filePath)) response.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.get('/health', async (req, res, next) => {
    try {
      res.json({
        status: 'ok',
        tablet_count: (await repository.list()).length,
        create_password_configured: Boolean(config.createPassword),
        shared_storage: Boolean(resolveRedisCredentials())
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON.' });
    }
    if (logger && typeof logger.error === 'function') logger.error('[server] request failed');
    return res.status(500).json({ error: 'internal_error', message: 'The archive could not complete that request.' });
  });

  app.locals.tabletRepository = repository;
  return app;
}

// Vercel recognizes app.js as an Express entry point, so its default CommonJS
// export must be the server itself. Attach the factory for local tests/tools.
const defaultApp = createApp();
defaultApp.RateLimiter = RateLimiter;
defaultApp.createApp = createApp;

module.exports = defaultApp;
