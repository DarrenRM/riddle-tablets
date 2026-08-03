'use strict';

const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const { Redis } = require('@upstash/redis');
const {
  createDefaultSubmissionRepository,
  createDefaultTabletRepository,
  resolveRedisCredentials
} = require('./lib/tablet-repository');

dotenv.config({ path: path.join(__dirname, '.env') });

const MODERATOR_COOKIE = 'riddle_moderator_access';

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

class RedisWindowRateLimiter {
  constructor({ url, token, max = 10, windowSeconds = 60 * 60, prefix = 'riddle-submit-rate:v1' }) {
    this.redis = new Redis({ url, token, enableTelemetry: false });
    this.max = max;
    this.windowSeconds = windowSeconds;
    this.prefix = prefix;
  }

  async check(identifier) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSeconds / this.windowSeconds);
    const key = `${this.prefix}:${bucket}:${identifier}`;
    const count = Number(await this.redis.incr(key));
    if (count === 1) await this.redis.expire(key, this.windowSeconds + 60);
    return {
      allowed: count <= this.max,
      retryAfter: count <= this.max ? 0 : this.windowSeconds - (nowSeconds % this.windowSeconds)
    };
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
  return crypto.createHmac('sha256', password).update('riddle-moderator-access-v1').digest('base64url');
}

function hasModeratorAccess(req, config) {
  if (!config.moderatorPassword) return false;
  return safeEqual(parseCookies(req.headers.cookie)[MODERATOR_COOKIE], accessToken(config.moderatorPassword));
}

function requestAddress(req) {
  const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'];
  return String(forwarded || req.ip || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function rateLimitIdentifier(req) {
  return crypto.createHash('sha256').update(requestAddress(req)).digest('hex').slice(0, 24);
}

function createDefaultSubmissionLimiter(config) {
  const credentials = resolveRedisCredentials();
  if (credentials) {
    return new RedisWindowRateLimiter({
      ...credentials,
      max: config.submissionLimit,
      windowSeconds: config.submissionWindowSeconds
    });
  }
  return new RateLimiter({
    max: config.submissionLimit,
    windowMs: config.submissionWindowSeconds * 1000
  });
}

function createApp(options = {}) {
  const optionConfig = options.config || {};
  const config = {
    moderatorPassword: optionConfig.moderatorPassword
      || optionConfig.createPassword
      || process.env.MODERATOR_PASSWORD
      || process.env.CREATE_PASSWORD
      || '',
    cookieTtlSeconds: Number(process.env.MODERATOR_COOKIE_TTL_SECONDS || process.env.CREATE_COOKIE_TTL_SECONDS) || 8 * 60 * 60,
    submissionLimit: Number(process.env.SUBMISSION_RATE_LIMIT) || 10,
    submissionWindowSeconds: Number(process.env.SUBMISSION_RATE_WINDOW_SECONDS) || 60 * 60,
    inputLimit: '8kb',
    logRequests: process.env.LOG_REQUESTS !== 'false',
    ...optionConfig
  };
  if (!config.moderatorPassword && optionConfig.createPassword) config.moderatorPassword = optionConfig.createPassword;

  const repository = options.tabletRepository || createDefaultTabletRepository(__dirname);
  const submissions = options.submissionRepository || createDefaultSubmissionRepository(__dirname);
  const loginLimiter = options.loginLimiter || new RateLimiter();
  const submissionLimiter = options.submissionLimiter || createDefaultSubmissionLimiter(config);
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

  const requireModeratorAccess = (req, res, next) => {
    if (hasModeratorAccess(req, config)) return next();
    return res.status(401).json({ error: 'moderator_auth_required', message: 'The moderation chamber is locked.' });
  };

  const sendKnownError = (error, res, next) => {
    if (error && (error.code === 'invalid_tablet' || error.code === 'invalid_tablet_id')) {
      return res.status(400).json({ error: error.code, message: error.message });
    }
    if (error && error.code === 'record_not_found') {
      return res.status(404).json({ error: error.code, message: error.message });
    }
    return next(error);
  };

  app.get('/api/tablets', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tablets: await repository.list() });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/submissions', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (typeof body.website === 'string' && body.website.trim()) {
        return res.status(202).json({ submitted: true });
      }
      const attempt = await submissionLimiter.check(rateLimitIdentifier(req));
      if (!attempt.allowed) {
        res.setHeader('Retry-After', String(attempt.retryAfter));
        return res.status(429).json({
          error: 'rate_limited',
          message: 'Too many submissions from this connection. Please return later.'
        });
      }
      const submission = await submissions.create(body);
      return res.status(202).json({ submitted: true, submission: { id: submission.id } });
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  app.get('/api/moderation/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured: Boolean(config.moderatorPassword), authenticated: hasModeratorAccess(req, config) });
  });

  app.post('/api/moderation/login', (req, res) => {
    const attempt = loginLimiter.check(rateLimitIdentifier(req));
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait before trying again.' });
    }
    if (!config.moderatorPassword) {
      return res.status(503).json({ error: 'password_unconfigured', message: 'Moderator access has not been configured.' });
    }
    const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!safeEqual(supplied, config.moderatorPassword)) {
      return res.status(401).json({ error: 'invalid_password', message: 'That password did not open the chamber.' });
    }
    const attributes = [
      `${MODERATOR_COOKIE}=${accessToken(config.moderatorPassword)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${config.cookieTtlSeconds}`
    ];
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
    return res.json({ authenticated: true });
  });

  app.get('/api/moderation/queue', requireModeratorAccess, async (req, res, next) => {
    try {
      const [pending, rejected, published] = await Promise.all([
        submissions.list('pending'),
        submissions.list('rejected'),
        repository.list()
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ pending, rejected, published });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/moderation/submissions/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      res.json({ submission: await submissions.update(req.params.id, req.body || {}) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/approve', requireModeratorAccess, async (req, res, next) => {
    try {
      const submission = await submissions.update(req.params.id, req.body || {});
      const tablet = await repository.save(submission, submission.id);
      await submissions.delete(submission.id);
      res.json({ tablet });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/reject', requireModeratorAccess, async (req, res, next) => {
    try {
      const submission = await submissions.setStatus(req.params.id, 'rejected', req.body || {});
      res.json({ submission });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/restore', requireModeratorAccess, async (req, res, next) => {
    try {
      const submission = await submissions.setStatus(req.params.id, 'pending', req.body || {});
      res.json({ submission });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.delete('/api/moderation/submissions/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const deleted = await submissions.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'record_not_found', message: 'That inscription no longer exists.' });
      return res.status(204).end();
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  app.put('/api/moderation/tablets/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      if (!await repository.get(req.params.id)) {
        return res.status(404).json({ error: 'record_not_found', message: 'That inscription no longer exists.' });
      }
      res.json({ tablet: await repository.save(req.body || {}, req.params.id) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/tablets/:id/unpublish', requireModeratorAccess, async (req, res, next) => {
    try {
      const tablet = await repository.get(req.params.id);
      if (!tablet) return res.status(404).json({ error: 'record_not_found', message: 'That inscription no longer exists.' });
      const supplied = req.body && Object.keys(req.body).length ? req.body : tablet;
      const rejected = await submissions.upsert(supplied, tablet.id, 'rejected');
      await repository.delete(tablet.id);
      return res.json({ submission: rejected });
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  // Backward-compatible authenticated write aliases for any stale editor tab.
  app.post('/api/tablets', requireModeratorAccess, async (req, res, next) => {
    try {
      const id = req.body && req.body.id ? req.body.id : null;
      res.status(id ? 200 : 201).json({ tablet: await repository.save(req.body || {}, id) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });
  app.put('/api/tablets/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      res.json({ tablet: await repository.save(req.body || {}, req.params.id) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.get(['/submit', '/submit.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'submit.html'));
  });

  app.get(['/approve', '/approve.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const file = hasModeratorAccess(req, config)
      ? path.join(__dirname, 'views', 'approve.html')
      : path.join(__dirname, 'public', 'approve-login.html');
    res.sendFile(file);
  });

  app.get(['/create', '/create.html'], (req, res) => res.redirect(302, '/submit'));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(response, filePath) {
      if (/\.(?:html|css|js)$/i.test(filePath)) response.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.get('/health', async (req, res, next) => {
    try {
      const [tablets, pending, rejected] = await Promise.all([
        repository.list(),
        submissions.list('pending'),
        submissions.list('rejected')
      ]);
      res.json({
        status: 'ok',
        tablet_count: tablets.length,
        pending_count: pending.length,
        rejected_count: rejected.length,
        moderator_password_configured: Boolean(config.moderatorPassword),
        create_password_configured: Boolean(config.moderatorPassword),
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
  app.locals.submissionRepository = submissions;
  return app;
}

const defaultApp = createApp();
defaultApp.RateLimiter = RateLimiter;
defaultApp.RedisWindowRateLimiter = RedisWindowRateLimiter;
defaultApp.createApp = createApp;

module.exports = defaultApp;
