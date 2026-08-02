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

class MemoryTabletRepository {
  constructor(initial = []) {
    this.tablets = initial.map((tablet) => ({ ...tablet }));
  }

  async list() {
    return this.tablets.map((tablet) => ({ ...tablet }));
  }

  async save(fields, requestedId = null) {
    const id = requestedId ? validateId(requestedId) : null;
    const index = id ? this.tablets.findIndex((tablet) => tablet.id === id) : -1;
    const tablet = normalizeTablet(fields, id, index >= 0 ? this.tablets[index] : null);
    if (index >= 0) this.tablets[index] = tablet;
    else this.tablets.unshift(tablet);
    return { ...tablet };
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

  async save(fields, requestedId = null) {
    const tablet = await super.save(fields, requestedId);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, tablets: this.tablets }, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, this.filePath);
    return tablet;
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

  async save(fields, requestedId = null) {
    const id = requestedId ? validateId(requestedId) : crypto.randomUUID();
    const previous = await this.redis.hget(this.key, id);
    const tablet = normalizeTablet(fields, id, previous && typeof previous === 'object' ? previous : null);
    await this.redis.hset(this.key, { [id]: tablet });
    return tablet;
  }
}

function createDefaultTabletRepository(rootDirectory) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashTabletRepository({ url, token });
  return new JsonTabletRepository(path.join(rootDirectory, 'data', 'tablets.local.json'));
}

module.exports = {
  JsonTabletRepository,
  MemoryTabletRepository,
  UpstashTabletRepository,
  createDefaultTabletRepository,
  normalizeTablet,
  validateId
};
