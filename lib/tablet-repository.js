'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(value)) {
    const error = new Error('Tablet id is invalid.');
    error.code = 'invalid_tablet_id';
    throw error;
  }
  return value;
}

function missingRecord() {
  const error = new Error('That inscription no longer exists.');
  error.code = 'record_not_found';
  return error;
}

function normalizeTablet(fields, id, previous = null) {
  const topic = clean(fields && fields.topic, 120);
  const author = clean(fields && fields.author, 120);
  const riddle = clean(fields && fields.riddle, 2000);
  if (!topic || !author || !riddle) {
    const error = new Error('Topic, author, and riddle are all required.');
    error.code = 'invalid_tablet';
    throw error;
  }
  const now = Date.now();
  return {
    id: id || crypto.randomUUID(),
    topic,
    author,
    riddle,
    createdAt: previous ? previous.createdAt : now,
    updatedAt: now
  };
}

function normalizeSubmission(fields, id, previous = null, status = 'pending') {
  const tablet = normalizeTablet(fields, id, previous);
  const normalizedStatus = status === 'rejected' ? 'rejected' : 'pending';
  return {
    ...tablet,
    status: normalizedStatus,
    submittedAt: previous ? previous.submittedAt : tablet.createdAt,
    rejectedAt: normalizedStatus === 'rejected'
      ? (previous && previous.status === 'rejected' ? previous.rejectedAt : Date.now())
      : null
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, filePath);
}

class MemoryTabletRepository {
  constructor(initial = []) {
    this.tablets = initial.map((tablet) => ({ ...tablet }));
  }

  async list() {
    return this.tablets.map((tablet) => ({ ...tablet }));
  }

  async get(id) {
    validateId(id);
    const tablet = this.tablets.find((record) => record.id === id);
    return tablet ? { ...tablet } : null;
  }

  async save(fields, requestedId = null) {
    const id = requestedId ? validateId(requestedId) : null;
    const index = id ? this.tablets.findIndex((tablet) => tablet.id === id) : -1;
    const tablet = normalizeTablet(fields, id, index >= 0 ? this.tablets[index] : null);
    if (index >= 0) this.tablets[index] = tablet;
    else this.tablets.unshift(tablet);
    return { ...tablet };
  }

  async delete(id) {
    validateId(id);
    const index = this.tablets.findIndex((tablet) => tablet.id === id);
    if (index < 0) return false;
    this.tablets.splice(index, 1);
    return true;
  }
}

class JsonTabletRepository extends MemoryTabletRepository {
  constructor(filePath) {
    let data = { tablets: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Array.isArray(parsed.tablets)) data = parsed;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    super(data.tablets);
    this.filePath = filePath;
  }

  persist() {
    writeJsonAtomic(this.filePath, { version: 1, tablets: this.tablets });
  }

  async save(fields, requestedId = null) {
    const tablet = await super.save(fields, requestedId);
    this.persist();
    return tablet;
  }

  async delete(id) {
    const deleted = await super.delete(id);
    if (deleted) this.persist();
    return deleted;
  }
}

class UpstashTabletRepository {
  constructor({ url, token, key = 'riddle-tablets:v1' }) {
    this.redis = new Redis({ url, token, enableTelemetry: false });
    this.key = key;
  }

  async list() {
    const records = await this.redis.hgetall(this.key) || {};
    return Object.values(records)
      .filter((tablet) => tablet && typeof tablet === 'object')
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
  }

  async get(id) {
    validateId(id);
    const tablet = await this.redis.hget(this.key, id);
    return tablet && typeof tablet === 'object' ? tablet : null;
  }

  async save(fields, requestedId = null) {
    const id = requestedId ? validateId(requestedId) : crypto.randomUUID();
    const previous = await this.get(id);
    const tablet = normalizeTablet(fields, id, previous);
    await this.redis.hset(this.key, { [id]: tablet });
    return tablet;
  }

  async delete(id) {
    validateId(id);
    return Number(await this.redis.hdel(this.key, id)) > 0;
  }
}

class MemorySubmissionRepository {
  constructor(initial = []) {
    this.submissions = initial.map((submission) => ({ ...submission }));
  }

  async list(status = null) {
    return this.submissions
      .filter((submission) => !status || submission.status === status)
      .map((submission) => ({ ...submission }))
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
  }

  async get(id) {
    validateId(id);
    const submission = this.submissions.find((record) => record.id === id);
    return submission ? { ...submission } : null;
  }

  async create(fields) {
    const submission = normalizeSubmission(fields, null);
    this.submissions.unshift(submission);
    return { ...submission };
  }

  async upsert(fields, id, status = 'pending') {
    validateId(id);
    const index = this.submissions.findIndex((submission) => submission.id === id);
    const previous = index >= 0 ? this.submissions[index] : null;
    const submission = normalizeSubmission(fields, id, previous, status);
    if (index >= 0) this.submissions[index] = submission;
    else this.submissions.unshift(submission);
    return { ...submission };
  }

  async update(id, fields) {
    validateId(id);
    const index = this.submissions.findIndex((submission) => submission.id === id);
    if (index < 0) throw missingRecord();
    const previous = this.submissions[index];
    const submission = normalizeSubmission(fields, id, previous, previous.status);
    this.submissions[index] = submission;
    return { ...submission };
  }

  async setStatus(id, status, fields = null) {
    validateId(id);
    const index = this.submissions.findIndex((submission) => submission.id === id);
    if (index < 0) throw missingRecord();
    const previous = this.submissions[index];
    const submission = normalizeSubmission(fields || previous, id, previous, status);
    this.submissions[index] = submission;
    return { ...submission };
  }

  async delete(id) {
    validateId(id);
    const index = this.submissions.findIndex((submission) => submission.id === id);
    if (index < 0) return false;
    this.submissions.splice(index, 1);
    return true;
  }
}

class JsonSubmissionRepository extends MemorySubmissionRepository {
  constructor(filePath) {
    let data = { submissions: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Array.isArray(parsed.submissions)) data = parsed;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    super(data.submissions);
    this.filePath = filePath;
  }

  persist() {
    writeJsonAtomic(this.filePath, { version: 1, submissions: this.submissions });
  }

  async create(fields) {
    const submission = await super.create(fields);
    this.persist();
    return submission;
  }

  async update(id, fields) {
    const submission = await super.update(id, fields);
    this.persist();
    return submission;
  }

  async upsert(fields, id, status = 'pending') {
    const submission = await super.upsert(fields, id, status);
    this.persist();
    return submission;
  }

  async setStatus(id, status, fields = null) {
    const submission = await super.setStatus(id, status, fields);
    this.persist();
    return submission;
  }

  async delete(id) {
    const deleted = await super.delete(id);
    if (deleted) this.persist();
    return deleted;
  }
}

class UpstashSubmissionRepository {
  constructor({ url, token, key = 'riddle-submissions:v1' }) {
    this.redis = new Redis({ url, token, enableTelemetry: false });
    this.key = key;
  }

  async list(status = null) {
    const records = await this.redis.hgetall(this.key) || {};
    return Object.values(records)
      .filter((submission) => submission && typeof submission === 'object')
      .filter((submission) => !status || submission.status === status)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
  }

  async get(id) {
    validateId(id);
    const submission = await this.redis.hget(this.key, id);
    return submission && typeof submission === 'object' ? submission : null;
  }

  async create(fields) {
    const submission = normalizeSubmission(fields, null);
    await this.redis.hset(this.key, { [submission.id]: submission });
    return submission;
  }

  async upsert(fields, id, status = 'pending') {
    validateId(id);
    const previous = await this.get(id);
    const submission = normalizeSubmission(fields, id, previous, status);
    await this.redis.hset(this.key, { [id]: submission });
    return submission;
  }

  async update(id, fields) {
    const previous = await this.get(id);
    if (!previous) throw missingRecord();
    const submission = normalizeSubmission(fields, id, previous, previous.status);
    await this.redis.hset(this.key, { [id]: submission });
    return submission;
  }

  async setStatus(id, status, fields = null) {
    const previous = await this.get(id);
    if (!previous) throw missingRecord();
    const submission = normalizeSubmission(fields || previous, id, previous, status);
    await this.redis.hset(this.key, { [id]: submission });
    return submission;
  }

  async delete(id) {
    validateId(id);
    return Number(await this.redis.hdel(this.key, id)) > 0;
  }
}

function resolveRedisCredentials(environment = process.env) {
  const url = environment.UPSTASH_REDIS_REST_URL || environment.KV_REST_API_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN || environment.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function createDefaultTabletRepository(rootDirectory) {
  const credentials = resolveRedisCredentials();
  if (credentials) return new UpstashTabletRepository(credentials);
  return new JsonTabletRepository(path.join(rootDirectory, 'data', 'tablets.local.json'));
}

function createDefaultSubmissionRepository(rootDirectory) {
  const credentials = resolveRedisCredentials();
  if (credentials) return new UpstashSubmissionRepository(credentials);
  return new JsonSubmissionRepository(path.join(rootDirectory, 'data', 'submissions.local.json'));
}

module.exports = {
  JsonSubmissionRepository,
  JsonTabletRepository,
  MemorySubmissionRepository,
  MemoryTabletRepository,
  UpstashSubmissionRepository,
  UpstashTabletRepository,
  createDefaultSubmissionRepository,
  createDefaultTabletRepository,
  normalizeSubmission,
  normalizeTablet,
  resolveRedisCredentials,
  validateId
};
