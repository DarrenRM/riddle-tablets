'use strict';

const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const { Redis } = require('@upstash/redis');
const {
  createDefaultGroupRepository,
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
  constructor({ url, token, max = 10, windowSeconds = 60 * 60, prefix = 'riddle-submit-rate:v2' }) {
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

function publicGroup(group) {
  if (!group) return null;
  const { submissionToken, completedAt, ...safe } = group;
  return safe;
}

function recordsByGroup(records) {
  const grouped = new Map();
  records.forEach((record) => {
    if (!record || !record.groupId) return;
    const groupRecords = grouped.get(record.groupId) || [];
    groupRecords.push(record);
    grouped.set(record.groupId, groupRecords);
  });
  return grouped;
}

function httpError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
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

  const groups = options.groupRepository || createDefaultGroupRepository(__dirname);
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
    if (error && ['invalid_tablet', 'invalid_tablet_id', 'invalid_group', 'group_required'].includes(error.code)) {
      return res.status(error.status || 400).json({ error: error.code, message: error.message });
    }
    if (error && error.code === 'group_closed') {
      return res.status(409).json({ error: error.code, message: error.message });
    }
    if (error && error.code === 'record_not_found') {
      return res.status(404).json({ error: error.code, message: error.message });
    }
    if (error && error.code === 'group_conflict') {
      return res.status(error.status || 409).json({ error: error.code, message: error.message });
    }
    return next(error);
  };

  const presentationFromRecords = (group, tablets) => ({
    group: publicGroup(group),
    tablets: group ? tablets : []
  });

  const presentationFor = async (group) => presentationFromRecords(
    group,
    group ? await repository.list(group.id) : []
  );

  const summarizeGroup = (group, approved, groupSubmissions) => ({
    ...group,
    counts: {
      pending: groupSubmissions.filter((submission) => submission.status === 'pending').length,
      approved: approved.length,
      rejected: groupSubmissions.filter((submission) => submission.status === 'rejected').length
    }
  });

  const groupSummary = async (group) => {
    const [groupSubmissions, approved] = await Promise.all([
      submissions.list(null, group.id),
      repository.list(group.id)
    ]);
    return summarizeGroup(group, approved, groupSubmissions);
  };

  app.get('/api/presentation', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await presentationFor(await groups.getActive()));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/presentations', async (req, res, next) => {
    try {
      const [groupRecords, tabletRecords] = await Promise.all([groups.list(), repository.list()]);
      const visible = groupRecords.filter((group) => ['active', 'archived'].includes(group.status));
      const tabletsByGroup = recordsByGroup(tabletRecords);
      const presentations = visible.map((group) => presentationFromRecords(group, tabletsByGroup.get(group.id) || []));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ presentations });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/topics', async (req, res, next) => {
    try {
      const [groupRecords, tabletRecords] = await Promise.all([groups.list(), repository.list()]);
      const visible = groupRecords.filter((group) => ['active', 'archived'].includes(group.status));
      const tabletsByGroup = recordsByGroup(tabletRecords);
      const topics = visible.map((group) => ({
        ...publicGroup(group),
        tabletCount: (tabletsByGroup.get(group.id) || []).length
      }));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ topics });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/topics/:id', async (req, res, next) => {
    try {
      const group = await groups.get(req.params.id);
      if (!group || !['active', 'archived'].includes(group.status)) {
        return res.status(404).json({ error: 'record_not_found', message: 'That topic is not available.' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await presentationFor(group));
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  // Backward-compatible public read used by any stale gallery tab.
  app.get('/api/tablets', async (req, res, next) => {
    try {
      const group = await groups.getActive();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tablets: group ? await repository.list(group.id) : [], group: publicGroup(group) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/submission-groups/:token', async (req, res, next) => {
    try {
      const group = await groups.getByToken(req.params.token);
      if (!group) return res.status(404).json({ error: 'record_not_found', message: 'That submission link is not available.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ group: { topic: group.topic }, accepting: group.status === 'open' });
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  app.post('/api/submission-groups/:token/submissions', async (req, res, next) => {
    try {
      const group = await groups.getByToken(req.params.token);
      if (!group) throw httpError('record_not_found', 'That submission link is not available.', 404);
      if (group.status !== 'open') throw httpError('group_closed', 'Submissions for this topic are closed.', 409);
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
      const submission = await submissions.create({
        groupId: group.id,
        topic: group.topic,
        author: body.author,
        riddle: body.riddle
      });
      return res.status(202).json({ submitted: true, submission: { id: submission.id } });
    } catch (error) {
      return sendKnownError(error, res, next);
    }
  });

  app.post('/api/submissions', (req, res) => res.status(400).json({
    error: 'group_required',
    message: 'Use the submission link supplied for a specific topic.'
  }));

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

  app.get('/api/moderation/groups', requireModeratorAccess, async (req, res, next) => {
    try {
      const [records, allTablets, allSubmissions] = await Promise.all([
        groups.list(),
        repository.list(),
        submissions.list()
      ]);
      const tabletsByGroup = recordsByGroup(allTablets);
      const submissionsByGroup = recordsByGroup(allSubmissions);
      const summaries = records.map((group) => summarizeGroup(
        group,
        tabletsByGroup.get(group.id) || [],
        submissionsByGroup.get(group.id) || []
      ));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        groups: summaries,
        legacy: {
          tablets: allTablets.filter((tablet) => !tablet.groupId).length,
          submissions: allSubmissions.filter((submission) => !submission.groupId).length
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/moderation/groups', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.create({ topic: req.body && req.body.topic });
      res.status(201).json({ group: await groupSummary(group) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.put('/api/moderation/groups/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.update(req.params.id, { topic: req.body && req.body.topic });
      const [tablets, pending, rejected] = await Promise.all([
        repository.list(group.id),
        submissions.list('pending', group.id),
        submissions.list('rejected', group.id)
      ]);
      await Promise.all([
        ...tablets.map((tablet) => repository.save({ ...tablet, topic: group.topic }, tablet.id)),
        ...pending.map((submission) => submissions.update(submission.id, { ...submission, topic: group.topic })),
        ...rejected.map((submission) => submissions.update(submission.id, { ...submission, topic: group.topic }))
      ]);
      res.json({ group: await groupSummary(group) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  const setGroupStatus = (status) => async (req, res, next) => {
    try {
      if (status === 'active' && (await repository.list(req.params.id)).length === 0) {
        throw httpError('invalid_group', 'Approve at least one clue before activating this topic.');
      }
      const group = await groups.setStatus(req.params.id, status);
      res.json({ group: await groupSummary(group) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  };

  app.post('/api/moderation/groups/:id/open', requireModeratorAccess, setGroupStatus('open'));
  app.post('/api/moderation/groups/:id/close', requireModeratorAccess, setGroupStatus('ready'));
  app.post('/api/moderation/groups/:id/activate', requireModeratorAccess, setGroupStatus('active'));
  app.post('/api/moderation/groups/:id/archive', requireModeratorAccess, setGroupStatus('archived'));

  const setGroupCompletion = (completed) => async (req, res, next) => {
    try {
      const group = await groups.setCompleted(req.params.id, completed);
      res.json({ group: await groupSummary(group) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  };

  app.post('/api/moderation/groups/:id/complete', requireModeratorAccess, setGroupCompletion(true));
  app.post('/api/moderation/groups/:id/incomplete', requireModeratorAccess, setGroupCompletion(false));

  app.delete('/api/moderation/groups/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.get(req.params.id);
      if (!group) throw httpError('record_not_found', 'That topic no longer exists.', 404);
      const [tablets, groupSubmissions] = await Promise.all([
        repository.list(group.id),
        submissions.list(null, group.id)
      ]);
      await Promise.all([
        ...tablets.map((tablet) => repository.delete(tablet.id)),
        ...groupSubmissions.map((submission) => submissions.delete(submission.id))
      ]);
      await groups.delete(group.id);
      res.status(204).end();
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/groups/:id/rotate-token', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.rotateToken(req.params.id);
      res.json({ group: await groupSummary(group) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.get('/api/moderation/groups/:id/queue', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.get(req.params.id);
      if (!group) throw httpError('record_not_found', 'That topic no longer exists.', 404);
      const [pending, rejected, approved] = await Promise.all([
        submissions.list('pending', group.id),
        submissions.list('rejected', group.id),
        repository.list(group.id)
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ group, pending, rejected, approved });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.get('/api/moderation/groups/:id/presentation', requireModeratorAccess, async (req, res, next) => {
    try {
      const group = await groups.get(req.params.id);
      if (!group) throw httpError('record_not_found', 'That topic no longer exists.', 404);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await presentationFor(group));
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.put('/api/moderation/groups/:id/tablet-order', requireModeratorAccess, async (req, res, next) => {
    try {
      const tablets = await repository.list(req.params.id);
      const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
      const expected = new Set(tablets.map((tablet) => tablet.id));
      if (ids.length !== tablets.length || ids.some((id) => !expected.has(id)) || new Set(ids).size !== ids.length) {
        throw httpError('invalid_group', 'The clue order is incomplete or invalid.');
      }
      const byId = new Map(tablets.map((tablet) => [tablet.id, tablet]));
      await Promise.all(ids.map((id, index) => repository.save({ ...byId.get(id), position: index }, id)));
      res.json({ approved: await repository.list(req.params.id) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/groups/import-legacy', requireModeratorAccess, async (req, res, next) => {
    try {
      const [allTablets, allSubmissions, existingGroups] = await Promise.all([
        repository.list(),
        submissions.list(),
        groups.list()
      ]);
      const legacyTablets = allTablets.filter((tablet) => !tablet.groupId);
      const legacySubmissions = allSubmissions.filter((submission) => !submission.groupId);
      const topics = new Map();
      [...legacyTablets, ...legacySubmissions].forEach((record) => {
        const topic = record.topic || 'Imported topic';
        if (!topics.has(topic)) topics.set(topic, { tablets: [], submissions: [] });
        topics.get(topic)[record.status ? 'submissions' : 'tablets'].push(record);
      });
      let imported = 0;
      for (const [topic, records] of topics) {
        let group = existingGroups.find((candidate) => candidate.topic.toLocaleLowerCase() === topic.toLocaleLowerCase());
        if (!group) group = await groups.create({ topic, status: records.tablets.length ? 'archived' : 'open' });
        await Promise.all(records.tablets.map((tablet, index) => repository.save({
          ...tablet,
          groupId: group.id,
          topic: group.topic,
          position: index
        }, tablet.id)));
        await Promise.all(records.submissions.map((submission) => submissions.update(submission.id, {
          ...submission,
          groupId: group.id,
          topic: group.topic
        })));
        imported += records.tablets.length + records.submissions.length;
      }
      res.json({ imported });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.put('/api/moderation/submissions/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const previous = await submissions.get(req.params.id);
      if (!previous) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      const group = previous.groupId ? await groups.get(previous.groupId) : null;
      res.json({ submission: await submissions.update(req.params.id, {
        ...previous,
        ...req.body,
        groupId: previous.groupId,
        topic: group ? group.topic : previous.topic
      }) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/approve', requireModeratorAccess, async (req, res, next) => {
    try {
      const previous = await submissions.get(req.params.id);
      if (!previous) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      if (!previous.groupId) throw httpError('group_required', 'Import this legacy inscription before approving it.');
      const group = await groups.get(previous.groupId);
      if (!group) throw httpError('record_not_found', 'That topic no longer exists.', 404);
      const approved = await repository.list(group.id);
      const submission = await submissions.update(req.params.id, {
        ...previous,
        ...req.body,
        groupId: group.id,
        topic: group.topic
      });
      const nextPosition = approved.reduce((highest, tablet) => Math.max(highest, Number(tablet.position) || 0), -1) + 1;
      const tablet = await repository.save({ ...submission, position: nextPosition }, submission.id);
      await submissions.delete(submission.id);
      res.json({ tablet });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/reject', requireModeratorAccess, async (req, res, next) => {
    try {
      const previous = await submissions.get(req.params.id);
      if (!previous) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      const group = previous.groupId ? await groups.get(previous.groupId) : null;
      const submission = await submissions.setStatus(req.params.id, 'rejected', {
        ...previous,
        ...req.body,
        groupId: previous.groupId,
        topic: group ? group.topic : previous.topic
      });
      res.json({ submission });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/submissions/:id/restore', requireModeratorAccess, async (req, res, next) => {
    try {
      const previous = await submissions.get(req.params.id);
      if (!previous) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      const group = previous.groupId ? await groups.get(previous.groupId) : null;
      const submission = await submissions.setStatus(req.params.id, 'pending', {
        ...previous,
        ...req.body,
        groupId: previous.groupId,
        topic: group ? group.topic : previous.topic
      });
      res.json({ submission });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.delete('/api/moderation/submissions/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const deleted = await submissions.delete(req.params.id);
      if (!deleted) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      res.status(204).end();
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.put('/api/moderation/tablets/:id', requireModeratorAccess, async (req, res, next) => {
    try {
      const previous = await repository.get(req.params.id);
      if (!previous) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      const group = previous.groupId ? await groups.get(previous.groupId) : null;
      res.json({ tablet: await repository.save({
        ...previous,
        ...req.body,
        groupId: previous.groupId,
        topic: group ? group.topic : previous.topic
      }, req.params.id) });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

  app.post('/api/moderation/tablets/:id/unpublish', requireModeratorAccess, async (req, res, next) => {
    try {
      const tablet = await repository.get(req.params.id);
      if (!tablet) throw httpError('record_not_found', 'That inscription no longer exists.', 404);
      const group = tablet.groupId ? await groups.get(tablet.groupId) : null;
      const supplied = req.body && Object.keys(req.body).length ? req.body : tablet;
      const rejected = await submissions.upsert({
        ...tablet,
        ...supplied,
        groupId: tablet.groupId,
        topic: group ? group.topic : tablet.topic
      }, tablet.id, 'rejected');
      await repository.delete(tablet.id);
      res.json({ submission: rejected });
    } catch (error) {
      sendKnownError(error, res, next);
    }
  });

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

  app.get(['/submit', '/submit.html', '/submit/:token'], (req, res) => {
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

  app.get('/preview/topics/:id', (req, res) => {
    if (!hasModeratorAccess(req, config)) return res.redirect(302, '/approve');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get(['/topics/:id', '/archive'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get(['/create', '/create.html'], (req, res) => res.redirect(302, '/submit'));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(response, filePath) {
      if (/\.(?:html|css|js)$/i.test(filePath)) response.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.get('/health', async (req, res, next) => {
    try {
      const [tablets, pending, rejected, groupRecords, active] = await Promise.all([
        repository.list(),
        submissions.list('pending'),
        submissions.list('rejected'),
        groups.list(),
        groups.getActive()
      ]);
      res.json({
        status: 'ok',
        tablet_count: tablets.length,
        pending_count: pending.length,
        rejected_count: rejected.length,
        group_count: groupRecords.length,
        active_group_configured: Boolean(active),
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

  app.locals.groupRepository = groups;
  app.locals.tabletRepository = repository;
  app.locals.submissionRepository = submissions;
  return app;
}

const defaultApp = createApp();
defaultApp.RateLimiter = RateLimiter;
defaultApp.RedisWindowRateLimiter = RedisWindowRateLimiter;
defaultApp.createApp = createApp;

module.exports = defaultApp;
