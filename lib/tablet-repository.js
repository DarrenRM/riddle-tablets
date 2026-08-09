'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const GROUP_STATUSES = new Set(['open', 'ready', 'active', 'archived']);
const GROUP_MUTATION_LOCK_TTL_MS = 10_000;
const GROUP_MUTATION_LOCK_WAIT_MS = 5_000;
const RELEASE_GROUP_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    const error = new Error('Record id is invalid.');
    error.code = 'invalid_tablet_id';
    throw error;
  }
  return value;
}

function missingRecord(message = 'That inscription no longer exists.') {
  const error = new Error(message);
  error.code = 'record_not_found';
  return error;
}

function assertGroupStatusTransition(group, status) {
  if (group && group.completedAt && status !== 'archived') {
    const error = new Error('Mark this topic incomplete before reopening or activating it.');
    error.code = 'group_conflict';
    error.status = 409;
    throw error;
  }
}

function numericPosition(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function normalizeGroup(fields, id, previous = null) {
  const topic = clean(fields && fields.topic, 120);
  const requestedStatus = clean(fields && fields.status, 20);
  const status = GROUP_STATUSES.has(requestedStatus)
    ? requestedStatus
    : (previous && GROUP_STATUSES.has(previous.status) ? previous.status : 'open');
  if (!topic) {
    const error = new Error('A topic is required.');
    error.code = 'invalid_group';
    throw error;
  }

  const now = Date.now();
  const requestedCompletion = fields && Object.prototype.hasOwnProperty.call(fields, 'completedAt')
    ? fields.completedAt
    : undefined;
  const token = clean(fields && fields.submissionToken, 200)
    || (previous && previous.submissionToken)
    || crypto.randomBytes(24).toString('base64url');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    const error = new Error('Submission token is invalid.');
    error.code = 'invalid_group';
    throw error;
  }

  return {
    id: id || crypto.randomUUID(),
    topic,
    status,
    submissionToken: token,
    createdAt: previous ? previous.createdAt : now,
    updatedAt: now,
    activatedAt: status === 'active'
      ? (previous && previous.status === 'active' ? previous.activatedAt : now)
      : (previous && previous.activatedAt) || null,
    archivedAt: status === 'archived'
      ? (previous && previous.status === 'archived' ? previous.archivedAt : now)
      : null,
    completedAt: requestedCompletion === null
      ? null
      : (Number.isFinite(Number(requestedCompletion))
        ? Number(requestedCompletion)
        : (previous && Number.isFinite(Number(previous.completedAt)) ? Number(previous.completedAt) : null))
  };
}

function normalizeTablet(fields, id, previous = null) {
  const groupId = clean(fields && fields.groupId, 200)
    || clean(previous && previous.groupId, 200);
  if (groupId) validateId(groupId);
  const topic = clean(fields && fields.topic, 120)
    || clean(previous && previous.topic, 120);
  const author = clean(fields && fields.author, 120);
  const riddle = clean(fields && fields.riddle, 2000);
  if ((!groupId && !topic) || !author || !riddle) {
    const error = new Error('Topic or group, author, and riddle are all required.');
    error.code = 'invalid_tablet';
    throw error;
  }
  const now = Date.now();
  return {
    id: id || crypto.randomUUID(),
    groupId: groupId || null,
    topic,
    author,
    riddle,
    position: numericPosition(fields && fields.position, previous ? numericPosition(previous.position) : 0),
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

function sortGroups(groups) {
  const rank = { active: 0, open: 1, ready: 2, archived: 3 };
  return groups.sort((left, right) => {
    const statusDifference = (rank[left.status] ?? 9) - (rank[right.status] ?? 9);
    return statusDifference || Number(right.updatedAt) - Number(left.updatedAt);
  });
}

class MemoryGroupRepository {
  constructor(initial = []) {
    this.groups = initial.map((group) => ({ ...group }));
  }

  async list() {
    return sortGroups(this.groups.map((group) => ({ ...group })));
  }

  async get(id) {
    validateId(id);
    const group = this.groups.find((record) => record.id === id);
    return group ? { ...group } : null;
  }

  async getByToken(token) {
    const normalized = clean(token, 200);
    const group = this.groups.find((record) => record.submissionToken === normalized);
    return group ? { ...group } : null;
  }

  async getActive() {
    const group = this.groups.find((record) => record.status === 'active' && !record.completedAt);
    return group ? { ...group } : null;
  }

  async create(fields) {
    const group = normalizeGroup(fields, null);
    this.groups.unshift(group);
    return { ...group };
  }

  async update(id, fields) {
    validateId(id);
    const index = this.groups.findIndex((record) => record.id === id);
    if (index < 0) throw missingRecord('That topic no longer exists.');
    const previous = this.groups[index];
    const group = normalizeGroup({ ...previous, ...fields }, id, previous);
    this.groups[index] = group;
    return { ...group };
  }

  async setStatus(id, status) {
    validateId(id);
    if (!GROUP_STATUSES.has(status)) {
      const error = new Error('Group status is invalid.');
      error.code = 'invalid_group';
      throw error;
    }
    const index = this.groups.findIndex((record) => record.id === id);
    if (index < 0) throw missingRecord('That topic no longer exists.');
    assertGroupStatusTransition(this.groups[index], status);

    if (status === 'active') {
      this.groups = this.groups.map((record) => (
        record.id !== id && record.status === 'active'
          ? normalizeGroup({ ...record, status: 'archived' }, record.id, record)
          : record
      ));
    }
    const currentIndex = this.groups.findIndex((record) => record.id === id);
    const previous = this.groups[currentIndex];
    const group = normalizeGroup({ ...previous, status }, id, previous);
    this.groups[currentIndex] = group;
    return { ...group };
  }

  async rotateToken(id) {
    validateId(id);
    const index = this.groups.findIndex((record) => record.id === id);
    if (index < 0) throw missingRecord('That topic no longer exists.');
    const previous = this.groups[index];
    const group = normalizeGroup({
      ...previous,
      submissionToken: crypto.randomBytes(24).toString('base64url')
    }, id, previous);
    this.groups[index] = group;
    return { ...group };
  }

  async setCompleted(id, isCompleted) {
    validateId(id);
    const index = this.groups.findIndex((record) => record.id === id);
    if (index < 0) throw missingRecord('That topic no longer exists.');
    const previous = this.groups[index];
    const status = isCompleted || previous.completedAt ? 'archived' : previous.status;
    const group = normalizeGroup({
      ...previous,
      status,
      completedAt: isCompleted ? (previous.completedAt || Date.now()) : null
    }, id, previous);
    // Completion metadata alone is private. A status transition must remain
    // observable so public presentation polling notices active -> archived.
    if (status === previous.status) group.updatedAt = previous.updatedAt;
    this.groups[index] = group;
    return { ...group };
  }

  async delete(id) {
    validateId(id);
    const index = this.groups.findIndex((group) => group.id === id);
    if (index < 0) return false;
    this.groups.splice(index, 1);
    return true;
  }
}

class JsonGroupRepository extends MemoryGroupRepository {
  constructor(filePath) {
    let data = { groups: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Array.isArray(parsed.groups)) data = parsed;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    super(data.groups);
    this.filePath = filePath;
  }

  persist() {
    writeJsonAtomic(this.filePath, { version: 1, groups: this.groups });
  }

  async create(fields) {
    const group = await super.create(fields);
    this.persist();
    return group;
  }

  async update(id, fields) {
    const group = await super.update(id, fields);
    this.persist();
    return group;
  }

  async setStatus(id, status) {
    const group = await super.setStatus(id, status);
    this.persist();
    return group;
  }

  async rotateToken(id) {
    const group = await super.rotateToken(id);
    this.persist();
    return group;
  }

  async delete(id) {
    const deleted = await super.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  async setCompleted(id, isCompleted) {
    const group = await super.setCompleted(id, isCompleted);
    this.persist();
    return group;
  }
}

class UpstashGroupRepository {
  constructor({ url, token, key = 'riddle-groups:v1', redis = null }) {
    this.redis = redis || new Redis({ url, token, enableTelemetry: false });
    this.key = key;
    this.lockKey = `${key}:mutation-lock`;
  }

  async withMutationLock(callback) {
    const lockToken = crypto.randomUUID();
    const deadline = Date.now() + GROUP_MUTATION_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const acquired = await this.redis.set(this.lockKey, lockToken, {
        nx: true,
        px: GROUP_MUTATION_LOCK_TTL_MS
      });
      if (acquired) {
        try {
          return await callback();
        } finally {
          await this.redis.eval(RELEASE_GROUP_LOCK_SCRIPT, [this.lockKey], [lockToken]).catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const error = new Error('Another moderator action is still finishing. Please try again.');
    error.code = 'group_conflict';
    error.status = 409;
    throw error;
  }

  async list() {
    const records = await this.redis.hgetall(this.key) || {};
    return sortGroups(Object.values(records).filter((group) => group && typeof group === 'object'));
  }

  async get(id) {
    validateId(id);
    const group = await this.redis.hget(this.key, id);
    return group && typeof group === 'object' ? group : null;
  }

  async getByToken(token) {
    const groups = await this.list();
    return groups.find((group) => group.submissionToken === clean(token, 200)) || null;
  }

  async getActive() {
    const groups = await this.list();
    return groups.find((group) => group.status === 'active' && !group.completedAt) || null;
  }

  async create(fields) {
    const group = normalizeGroup(fields, null);
    await this.redis.hset(this.key, { [group.id]: group });
    return group;
  }

  async update(id, fields) {
    return this.withMutationLock(async () => {
      const previous = await this.get(id);
      if (!previous) throw missingRecord('That topic no longer exists.');
      const group = normalizeGroup({ ...previous, ...fields }, id, previous);
      await this.redis.hset(this.key, { [id]: group });
      return group;
    });
  }

  async setStatus(id, status) {
    if (!GROUP_STATUSES.has(status)) {
      const error = new Error('Group status is invalid.');
      error.code = 'invalid_group';
      throw error;
    }
    return this.withMutationLock(async () => {
      const groups = await this.list();
      const previous = groups.find((group) => group.id === id);
      if (!previous) throw missingRecord('That topic no longer exists.');
      assertGroupStatusTransition(previous, status);
      const writes = {};
      if (status === 'active') {
        groups.filter((group) => group.id !== id && group.status === 'active').forEach((group) => {
          writes[group.id] = normalizeGroup({ ...group, status: 'archived' }, group.id, group);
        });
      }
      const updated = normalizeGroup({ ...previous, status }, id, previous);
      writes[id] = updated;
      await this.redis.hset(this.key, writes);
      return updated;
    });
  }

  async rotateToken(id) {
    return this.update(id, { submissionToken: crypto.randomBytes(24).toString('base64url') });
  }

  async delete(id) {
    validateId(id);
    return this.withMutationLock(async () => Number(await this.redis.hdel(this.key, id)) > 0);
  }

  async setCompleted(id, isCompleted) {
    return this.withMutationLock(async () => {
      const previous = await this.get(id);
      if (!previous) throw missingRecord('That topic no longer exists.');
      const status = isCompleted || previous.completedAt ? 'archived' : previous.status;
      const group = normalizeGroup({
        ...previous,
        status,
        completedAt: isCompleted ? (previous.completedAt || Date.now()) : null
      }, id, previous);
      // Completion metadata alone is private. A status transition must remain
      // observable so public presentation polling notices active -> archived.
      if (status === previous.status) group.updatedAt = previous.updatedAt;
      await this.redis.hset(this.key, { [id]: group });
      return group;
    });
  }
}

class MemoryTabletRepository {
  constructor(initial = []) {
    this.tablets = initial.map((tablet) => ({ ...tablet }));
  }

  async list(groupId = null) {
    return this.tablets
      .filter((tablet) => !groupId || tablet.groupId === groupId)
      .map((tablet) => ({ ...tablet }))
      .sort((left, right) => numericPosition(left.position) - numericPosition(right.position)
        || Number(left.createdAt) - Number(right.createdAt));
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
    else this.tablets.push(tablet);
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

  async list(groupId = null) {
    const records = await this.redis.hgetall(this.key) || {};
    return Object.values(records)
      .filter((tablet) => tablet && typeof tablet === 'object')
      .filter((tablet) => !groupId || tablet.groupId === groupId)
      .sort((left, right) => numericPosition(left.position) - numericPosition(right.position)
        || Number(left.createdAt) - Number(right.createdAt));
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

  async list(status = null, groupId = null) {
    return this.submissions
      .filter((submission) => !status || submission.status === status)
      .filter((submission) => !groupId || submission.groupId === groupId)
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

  async list(status = null, groupId = null) {
    const records = await this.redis.hgetall(this.key) || {};
    return Object.values(records)
      .filter((submission) => submission && typeof submission === 'object')
      .filter((submission) => !status || submission.status === status)
      .filter((submission) => !groupId || submission.groupId === groupId)
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

function isVercelProductionRuntime(environment = process.env) {
  return String(environment.VERCEL || '').trim() === '1'
    && String(environment.VERCEL_ENV || '').trim().toLowerCase() === 'production'
    && Boolean(String(environment.VERCEL_URL || '').trim());
}

function resolveStorageCredentials(environment = process.env) {
  const requestedMode = String(environment.RIDDLE_TABLETS_STORAGE || '').trim().toLowerCase();
  if (requestedMode === 'local' || requestedMode === 'json' || requestedMode === 'file') return null;
  if (requestedMode === 'redis' || requestedMode === 'remote') {
    if (!isVercelProductionRuntime(environment)) {
      throw new Error('Remote Riddle Tablets storage is restricted to the Vercel production runtime. Local runs use the test database in data/*.local.json.');
    }
  }
  if (!isVercelProductionRuntime(environment)) return null;
  return resolveRedisCredentials(environment);
}

function createDefaultGroupRepository(rootDirectory, environment = process.env) {
  const credentials = resolveStorageCredentials(environment);
  if (credentials) return new UpstashGroupRepository(credentials);
  return new JsonGroupRepository(path.join(rootDirectory, 'data', 'groups.local.json'));
}

function createDefaultTabletRepository(rootDirectory, environment = process.env) {
  const credentials = resolveStorageCredentials(environment);
  if (credentials) return new UpstashTabletRepository(credentials);
  return new JsonTabletRepository(path.join(rootDirectory, 'data', 'tablets.local.json'));
}

function createDefaultSubmissionRepository(rootDirectory, environment = process.env) {
  const credentials = resolveStorageCredentials(environment);
  if (credentials) return new UpstashSubmissionRepository(credentials);
  return new JsonSubmissionRepository(path.join(rootDirectory, 'data', 'submissions.local.json'));
}

module.exports = {
  GROUP_STATUSES,
  JsonGroupRepository,
  JsonSubmissionRepository,
  JsonTabletRepository,
  MemoryGroupRepository,
  MemorySubmissionRepository,
  MemoryTabletRepository,
  UpstashGroupRepository,
  UpstashSubmissionRepository,
  UpstashTabletRepository,
  createDefaultGroupRepository,
  createDefaultSubmissionRepository,
  createDefaultTabletRepository,
  isVercelProductionRuntime,
  normalizeGroup,
  normalizeSubmission,
  normalizeTablet,
  resolveRedisCredentials,
  resolveStorageCredentials,
  validateId
};
