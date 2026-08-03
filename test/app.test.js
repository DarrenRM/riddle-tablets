'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp, RateLimiter } = require('../app');
const {
  MemorySubmissionRepository,
  MemoryTabletRepository,
  resolveRedisCredentials
} = require('../lib/tablet-repository');

async function request(app, method, route, body, extraHeaders = {}) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    return await new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const client = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: route,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders
        }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try { parsed = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, headers: response.headers, body: parsed });
        });
      });
      client.on('error', reject);
      if (payload) client.write(payload);
      client.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createTestApp(options = {}) {
  return createApp({
    tabletRepository: options.tabletRepository || new MemoryTabletRepository(),
    submissionRepository: options.submissionRepository || new MemorySubmissionRepository(),
    submissionLimiter: options.submissionLimiter || new RateLimiter({ max: 20, windowMs: 60_000 }),
    config: { moderatorPassword: 'test-password', logRequests: false },
    logger: { log() {}, error() {} }
  });
}

async function moderatorCookie(app) {
  const login = await request(app, 'POST', '/api/moderation/login', { password: 'test-password' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  return login.headers['set-cookie'][0].split(';')[0];
}

test('public submissions stay private until a moderator approves them', async () => {
  const app = createTestApp();
  const landing = await request(app, 'GET', '/');
  assert.equal(landing.status, 200);
  assert.doesNotMatch(landing.body, /\/approve/);

  const submitPage = await request(app, 'GET', '/submit');
  assert.equal(submitPage.status, 200);
  assert.match(submitPage.body, /id="submission-form"/);
  assert.doesNotMatch(submitPage.body, /saved-tablets/);
  const oldCreate = await request(app, 'GET', '/create');
  assert.equal(oldCreate.status, 302);
  assert.equal(oldCreate.headers.location, '/submit');

  const invalid = await request(app, 'POST', '/api/submissions', { topic: 'Missing fields' });
  assert.equal(invalid.status, 400);
  const trapped = await request(app, 'POST', '/api/submissions', {
    topic: 'Bot', author: 'Bot', riddle: 'Spam', website: 'https://spam.example'
  });
  assert.equal(trapped.status, 202);

  const submitted = await request(app, 'POST', '/api/submissions', {
    topic: 'Hidden clue', author: 'First author', riddle: 'Pending answer', website: ''
  });
  assert.equal(submitted.status, 202);
  assert.equal((await request(app, 'GET', '/api/tablets')).body.tablets.length, 0);
  assert.equal((await request(app, 'GET', '/api/moderation/queue')).status, 401);
  const lockedApprove = await request(app, 'GET', '/approve');
  assert.match(lockedApprove.body, /id="approve-login-form"/);

  const cookie = await moderatorCookie(app);
  const approvePage = await request(app, 'GET', '/approve', undefined, { Cookie: cookie });
  assert.match(approvePage.body, /id="moderation-tabs"/);
  const queue = await request(app, 'GET', '/api/moderation/queue', undefined, { Cookie: cookie });
  assert.equal(queue.body.pending.length, 1);
  assert.equal(queue.body.rejected.length, 0);
  const id = queue.body.pending[0].id;

  const approved = await request(app, 'POST', `/api/moderation/submissions/${id}/approve`, {
    topic: 'Reviewed clue', author: 'Reviewed author', riddle: 'Reviewed answer'
  }, { Cookie: cookie });
  assert.equal(approved.status, 200);
  const publicList = await request(app, 'GET', '/api/tablets');
  assert.equal(publicList.body.tablets.length, 1);
  assert.equal(publicList.body.tablets[0].topic, 'Reviewed clue');
  const after = await request(app, 'GET', '/api/moderation/queue', undefined, { Cookie: cookie });
  assert.equal(after.body.pending.length, 0);
  assert.equal(after.body.published.length, 1);
});

test('moderators can reject, restore, edit, unpublish, and permanently delete', async () => {
  const app = createTestApp();
  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };

  const first = await request(app, 'POST', '/api/submissions', {
    topic: 'Candidate', author: 'Scribe', riddle: 'Draft'
  });
  const id = first.body.submission.id;
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${id}/reject`, {
    topic: 'Candidate edited', author: 'Scribe', riddle: 'Rejected draft'
  }, headers)).status, 200);
  let queue = await request(app, 'GET', '/api/moderation/queue', undefined, headers);
  assert.equal(queue.body.rejected[0].topic, 'Candidate edited');

  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${id}/restore`, {
    topic: 'Restored candidate', author: 'Scribe', riddle: 'Restored draft'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${id}/approve`, {
    topic: 'Published candidate', author: 'Scribe', riddle: 'Final draft'
  }, headers)).status, 200);
  assert.equal((await request(app, 'PUT', `/api/moderation/tablets/${id}`, {
    topic: 'Published edit', author: 'Scribe', riddle: 'Final edit'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/tablets/${id}/unpublish`, {
    topic: 'Published edit', author: 'Scribe', riddle: 'Final edit'
  }, headers)).status, 200);
  assert.equal((await request(app, 'GET', '/api/tablets')).body.tablets.length, 0);

  queue = await request(app, 'GET', '/api/moderation/queue', undefined, headers);
  assert.equal(queue.body.rejected.length, 1);
  assert.equal((await request(app, 'DELETE', `/api/moderation/submissions/${id}`, undefined, headers)).status, 204);
  queue = await request(app, 'GET', '/api/moderation/queue', undefined, headers);
  assert.equal(queue.body.rejected.length, 0);
});

test('public submission rate limiting returns a retry window', async () => {
  const app = createTestApp({ submissionLimiter: new RateLimiter({ max: 1, windowMs: 60_000 }) });
  const fields = { topic: 'One', author: 'Scribe', riddle: 'First' };
  assert.equal((await request(app, 'POST', '/api/submissions', fields)).status, 202);
  const limited = await request(app, 'POST', '/api/submissions', { ...fields, topic: 'Two' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('tablet and submission validation reject incomplete records', async () => {
  const tablets = new MemoryTabletRepository();
  const submissions = new MemorySubmissionRepository();
  await assert.rejects(() => tablets.save({ topic: 'Missing fields' }), /all required/i);
  await assert.rejects(() => submissions.create({ topic: 'Missing fields' }), /all required/i);
});

test('shared storage accepts both Upstash and Vercel KV environment names', () => {
  assert.deepEqual(resolveRedisCredentials({
    UPSTASH_REDIS_REST_URL: 'https://upstash.example',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
  }), { url: 'https://upstash.example', token: 'upstash-token' });

  assert.deepEqual(resolveRedisCredentials({
    KV_REST_API_URL: 'https://kv.example',
    KV_REST_API_TOKEN: 'kv-token'
  }), { url: 'https://kv.example', token: 'kv-token' });
});
