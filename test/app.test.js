'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, RateLimiter } = require('../app');
const {
  MemoryGroupRepository,
  MemorySubmissionRepository,
  MemoryTabletRepository,
  JsonGroupRepository,
  JsonSubmissionRepository,
  JsonTabletRepository,
  UpstashGroupRepository,
  createDefaultGroupRepository,
  createDefaultSubmissionRepository,
  createDefaultTabletRepository,
  isVercelProductionRuntime,
  resolveRedisCredentials,
  resolveStorageCredentials
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
    groupRepository: options.groupRepository || new MemoryGroupRepository(),
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

async function createGroup(app, headers, topic = 'The Work', fields = {}) {
  const created = await request(app, 'POST', '/api/moderation/groups', { topic, ...fields }, headers);
  assert.equal(created.status, 201);
  return created.body.group;
}

async function submitClue(app, group, author, riddle) {
  return request(app, 'POST', `/api/submission-groups/${group.submissionToken}/submissions`, {
    author,
    riddle,
    website: ''
  });
}

test('groups keep clues private until moderators approve and activate the topic', async () => {
  const app = createTestApp();
  const initial = await request(app, 'GET', '/api/presentation');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.group, null);
  assert.deepEqual(initial.body.tablets, []);

  const genericSubmit = await request(app, 'GET', '/submit');
  assert.equal(genericSubmit.status, 200);
  assert.doesNotMatch(genericSubmit.body, /name="topic"/);
  assert.equal((await request(app, 'POST', '/api/submissions', { author: 'No group', riddle: 'No clue' })).status, 400);

  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };
  const group = await createGroup(app, headers);
  assert.equal(group.status, 'open');
  assert.ok(group.submissionToken.length >= 20);

  const context = await request(app, 'GET', `/api/submission-groups/${group.submissionToken}`);
  assert.equal(context.body.group.topic, 'The Work');
  assert.equal(context.body.accepting, true);
  assert.equal((await request(app, 'POST', `/api/submission-groups/${group.submissionToken}/submissions`, {
    author: 'Bot', riddle: 'Spam', website: 'https://spam.example'
  })).status, 202);

  const submitted = await submitClue(app, group, 'Public Scribe', 'Look beneath the mountain.');
  assert.equal(submitted.status, 202);
  assert.equal((await request(app, 'GET', '/api/presentation')).body.group, null);
  assert.equal((await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`)).status, 401);

  let queue = await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`, undefined, headers);
  assert.equal(queue.body.pending.length, 1);
  assert.equal(queue.body.pending[0].topic, 'The Work');
  const id = queue.body.pending[0].id;

  const approved = await request(app, 'POST', `/api/moderation/submissions/${id}/approve`, {
    author: 'Reviewed Scribe',
    riddle: 'Look beneath the snowy mountain.'
  }, headers);
  assert.equal(approved.status, 200);
  assert.equal((await request(app, 'GET', '/api/presentation')).body.group, null);

  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/close`, undefined, headers)).body.group.status, 'ready');
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers)).body.group.status, 'active');

  const publicPresentation = await request(app, 'GET', '/api/presentation');
  assert.equal(publicPresentation.body.group.topic, 'The Work');
  assert.equal(publicPresentation.body.group.submissionToken, undefined);
  assert.equal(publicPresentation.body.tablets.length, 1);
  assert.equal(publicPresentation.body.tablets[0].author, 'Reviewed Scribe');
  assert.equal(publicPresentation.body.tablets[0].topic, 'The Work');

  queue = await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`, undefined, headers);
  assert.equal(queue.body.pending.length, 0);
  assert.equal(queue.body.approved.length, 1);
});

test('multi-step quest settings persist and require at least two approved steps', async () => {
  const app = createTestApp();
  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };
  const group = await createGroup(app, headers, 'The Fourfold Trial', { multiStep: true });
  assert.equal(group.multiStep, true);
  assert.equal(group.questRevision, 1);

  const firstSubmission = await submitClue(app, group, 'First Scribe', 'The first seal waits.');
  assert.equal(firstSubmission.status, 202);
  let queue = await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`, undefined, headers);
  await request(app, 'POST', `/api/moderation/submissions/${queue.body.pending[0].id}/approve`, {
    author: 'First Scribe',
    riddle: 'The first seal waits.'
  }, headers);

  const tooSoon = await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers);
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.message, /at least two steps/i);

  const secondSubmission = await submitClue(app, group, 'Second Scribe', 'The second seal follows.');
  assert.equal(secondSubmission.status, 202);
  queue = await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`, undefined, headers);
  await request(app, 'POST', `/api/moderation/submissions/${queue.body.pending[0].id}/approve`, {
    author: 'Second Scribe',
    riddle: 'The second seal follows.'
  }, headers);
  const thirdSubmission = await submitClue(app, group, 'Third Scribe', 'The third seal follows.');
  assert.equal(thirdSubmission.status, 202);

  const activated = await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.group.multiStep, true);
  const presentation = await request(app, 'GET', '/api/presentation');
  assert.equal(presentation.body.group.multiStep, true);
  assert.equal(presentation.body.group.questRevision, 1);
  assert.deepEqual(presentation.body.tablets.map((tablet) => tablet.author), ['First Scribe', 'Second Scribe']);

  queue = await request(app, 'GET', `/api/moderation/groups/${group.id}/queue`, undefined, headers);
  const blockedApproval = await request(app, 'POST', `/api/moderation/submissions/${queue.body.pending[0].id}/approve`, {
    author: 'Third Scribe',
    riddle: 'The third seal follows.'
  }, headers);
  assert.equal(blockedApproval.status, 409);
  assert.match(blockedApproval.body.message, /deactivate/i);

  const approvedIds = queue.body.approved.map((tablet) => tablet.id);
  const blockedReorder = await request(app, 'PUT', `/api/moderation/groups/${group.id}/tablet-order`, {
    ids: [...approvedIds].reverse()
  }, headers);
  assert.equal(blockedReorder.status, 409);
  const blockedUnpublish = await request(app, 'POST', `/api/moderation/tablets/${approvedIds[0]}/unpublish`, {}, headers);
  assert.equal(blockedUnpublish.status, 409);

  const renamedWithoutFlag = await request(app, 'PUT', `/api/moderation/groups/${group.id}`, {
    topic: 'The Renamed Trial'
  }, headers);
  assert.equal(renamedWithoutFlag.body.group.multiStep, true);
  const disabledWhileActive = await request(app, 'PUT', `/api/moderation/groups/${group.id}`, {
    topic: 'The Renamed Trial',
    multiStep: false
  }, headers);
  assert.equal(disabledWhileActive.status, 409);

  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/deactivate`, undefined, headers)).status, 200);
  const disabled = await request(app, 'PUT', `/api/moderation/groups/${group.id}`, {
    topic: 'The Renamed Trial',
    multiStep: false
  }, headers);
  assert.equal(disabled.body.group.multiStep, false);
  assert.equal(disabled.body.group.questRevision, 1);
  const reenabled = await request(app, 'PUT', `/api/moderation/groups/${group.id}`, {
    topic: 'The Renamed Trial',
    multiStep: true
  }, headers);
  assert.equal(reenabled.body.group.multiStep, true);
  assert.equal(reenabled.body.group.questRevision, 2);

  assert.equal((await request(app, 'PUT', `/api/moderation/groups/${group.id}/tablet-order`, {
    ids: [...approvedIds].reverse()
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${queue.body.pending[0].id}/approve`, {
    author: 'Third Scribe',
    riddle: 'The third seal follows.'
  }, headers)).status, 200);
});

test('public archive lists approved tablets from every group status without exposing submissions', async () => {
  const groupRepository = new MemoryGroupRepository();
  const tabletRepository = new MemoryTabletRepository();
  const submissionRepository = new MemorySubmissionRepository();
  const expectedTopics = [];

  for (const status of ['open', 'ready', 'active', 'archived']) {
    const group = await groupRepository.create({ topic: `${status} approved`, status });
    expectedTopics.push(group.topic);
    await tabletRepository.save({
      groupId: group.id,
      topic: group.topic,
      author: `${status} scribe`,
      riddle: `${status} approved clue`
    });
  }

  const pendingOnly = await groupRepository.create({ topic: 'Pending only', status: 'open' });
  await submissionRepository.create({
    groupId: pendingOnly.id,
    topic: pendingOnly.topic,
    author: 'Private scribe',
    riddle: 'This clue is not approved.',
    status: 'pending'
  });
  await groupRepository.create({ topic: 'Empty group', status: 'ready' });

  const app = createTestApp({ groupRepository, tabletRepository, submissionRepository });
  const archive = await request(app, 'GET', '/api/archive');
  assert.equal(archive.status, 200);
  assert.equal(archive.headers['cache-control'], 'no-store');
  assert.deepEqual(
    archive.body.presentations.map((presentation) => presentation.group.topic).sort(),
    expectedTopics.sort()
  );
  archive.body.presentations.forEach((presentation) => {
    assert.equal(presentation.tablets.length, 1);
    assert.equal(Object.hasOwn(presentation.group, 'submissionToken'), false);
    assert.equal(Object.hasOwn(presentation.group, 'completedAt'), false);
  });
  assert.equal(
    archive.body.presentations.some((presentation) => presentation.tablets.some((tablet) => tablet.author === 'Private scribe')),
    false
  );
});

test('completing a topic atomically archives it without removing its clues or submissions', async () => {
  const app = createTestApp();
  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };
  const group = await createGroup(app, headers, 'Finished Topic');
  const submitted = await submitClue(app, group, 'Scribe', 'A preserved clue.');
  const submissionId = submitted.body.submission.id;
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${submissionId}/approve`, {
    author: 'Scribe', riddle: 'A preserved clue.'
  }, headers)).status, 200);
  assert.equal((await submitClue(app, group, 'Waiting Scribe', 'A preserved pending clue.')).status, 202);
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers)).status, 200);
  assert.equal((await request(app, 'GET', '/api/presentation')).body.group.status, 'active');

  const completed = await request(app, 'POST', `/api/moderation/groups/${group.id}/complete`, undefined, headers);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.group.status, 'archived');
  assert.ok(completed.body.group.completedAt);
  assert.equal((await request(app, 'GET', '/api/presentation')).body.group, null);
  assert.equal((await app.locals.tabletRepository.list(group.id)).length, 1);
  assert.equal((await app.locals.submissionRepository.list(null, group.id)).length, 1);
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/open`, undefined, headers)).status, 409);
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers)).status, 409);

  const incomplete = await request(app, 'POST', `/api/moderation/groups/${group.id}/incomplete`, undefined, headers);
  assert.equal(incomplete.status, 200);
  assert.equal(incomplete.body.group.status, 'archived');
  assert.equal(incomplete.body.group.completedAt, null);
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/activate`, undefined, headers)).status, 200);
});

test('legacy active plus completed records are treated as archived by public APIs', async () => {
  const groups = new MemoryGroupRepository();
  const group = await groups.create({ topic: 'Legacy Done Topic' });
  await groups.setStatus(group.id, 'active');
  groups.groups[0].completedAt = Date.now();
  const tablets = new MemoryTabletRepository();
  await tablets.save({ groupId: group.id, topic: group.topic, author: 'Scribe', riddle: 'Still preserved.' });
  const app = createTestApp({ groupRepository: groups, tabletRepository: tablets });

  assert.equal((await request(app, 'GET', '/api/presentation')).body.group, null);
  const presentations = await request(app, 'GET', '/api/presentations');
  assert.equal(presentations.body.presentations[0].group.status, 'archived');
  assert.equal(presentations.body.presentations[0].tablets.length, 1);
});

test('moderators manage group status, clue order, rejection, and unapproval', async () => {
  const app = createTestApp();
  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };
  const firstGroup = await createGroup(app, headers, 'First Topic');

  const first = await submitClue(app, firstGroup, 'One', 'First clue');
  const second = await submitClue(app, firstGroup, 'Two', 'Second clue');
  const firstId = first.body.submission.id;
  const secondId = second.body.submission.id;

  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${firstId}/reject`, {
    author: 'One edited', riddle: 'Rejected clue'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${firstId}/restore`, {
    author: 'One restored', riddle: 'First clue restored'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${firstId}/approve`, {
    author: 'One final', riddle: 'First final clue'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${secondId}/approve`, {
    author: 'Two final', riddle: 'Second final clue'
  }, headers)).status, 200);

  let queue = await request(app, 'GET', `/api/moderation/groups/${firstGroup.id}/queue`, undefined, headers);
  assert.deepEqual(queue.body.approved.map((tablet) => tablet.id), [firstId, secondId]);
  assert.equal((await request(app, 'PUT', `/api/moderation/groups/${firstGroup.id}/tablet-order`, {
    ids: [secondId, firstId]
  }, headers)).status, 200);
  queue = await request(app, 'GET', `/api/moderation/groups/${firstGroup.id}/queue`, undefined, headers);
  assert.deepEqual(queue.body.approved.map((tablet) => tablet.id), [secondId, firstId]);

  assert.equal((await request(app, 'POST', `/api/moderation/groups/${firstGroup.id}/activate`, undefined, headers)).status, 200);
  const secondGroup = await createGroup(app, headers, 'Second Topic');
  const third = await submitClue(app, secondGroup, 'Three', 'Third clue');
  assert.equal((await request(app, 'POST', `/api/moderation/submissions/${third.body.submission.id}/approve`, {
    author: 'Three', riddle: 'Third clue'
  }, headers)).status, 200);
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${secondGroup.id}/activate`, undefined, headers)).status, 200);

  const deactivated = await request(app, 'POST', `/api/moderation/groups/${secondGroup.id}/deactivate`, undefined, headers);
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.group.status, 'ready');
  assert.equal((await request(app, 'POST', `/api/moderation/groups/${secondGroup.id}/activate`, undefined, headers)).status, 200);

  const groups = await request(app, 'GET', '/api/moderation/groups', undefined, headers);
  assert.equal(groups.body.groups.find((group) => group.id === firstGroup.id).status, 'active');
  assert.equal(groups.body.groups.find((group) => group.id === secondGroup.id).status, 'active');
  const archive = await request(app, 'GET', '/api/topics');
  assert.ok(archive.body.topics.some((group) => group.id === firstGroup.id && group.status === 'active'));
  const presentations = await request(app, 'GET', '/api/presentations');
  assert.equal(presentations.status, 200);
  assert.deepEqual(
    presentations.body.presentations.map((presentation) => presentation.group.topic),
    ['Second Topic', 'First Topic']
  );
  const publicBeforeCompletion = await request(app, 'GET', `/api/topics/${firstGroup.id}`);
  const completed = await request(app, 'POST', `/api/moderation/groups/${firstGroup.id}/complete`, undefined, headers);
  assert.equal(completed.status, 200);
  assert.ok(completed.body.group.completedAt);
  const publicCompleted = await request(app, 'GET', `/api/topics/${firstGroup.id}`);
  assert.equal(publicCompleted.status, 200);
  assert.equal(publicCompleted.body.group.completedAt, undefined);
  assert.ok(publicCompleted.body.group.updatedAt >= publicBeforeCompletion.body.group.updatedAt);
  const sortedGroups = await request(app, 'GET', '/api/moderation/groups', undefined, headers);
  assert.deepEqual(sortedGroups.body.groups.map((group) => group.topic), ['Second Topic', 'First Topic']);
  const incompleted = await request(app, 'POST', `/api/moderation/groups/${firstGroup.id}/incomplete`, undefined, headers);
  assert.equal(incompleted.status, 200);
  assert.equal(incompleted.body.group.completedAt, null);

  assert.equal((await request(app, 'POST', `/api/moderation/tablets/${secondId}/unpublish`, {
    author: 'Two final', riddle: 'Second final clue'
  }, headers)).status, 200);
  queue = await request(app, 'GET', `/api/moderation/groups/${firstGroup.id}/queue`, undefined, headers);
  assert.equal(queue.body.rejected.length, 1);
  assert.equal((await request(app, 'DELETE', `/api/moderation/submissions/${secondId}`, undefined, headers)).status, 204);

  assert.equal((await request(app, 'DELETE', `/api/moderation/groups/${firstGroup.id}`)).status, 401);
  assert.equal((await request(app, 'DELETE', `/api/moderation/groups/${secondGroup.id}`, {
    confirmation: 'DELETE', topic: secondGroup.topic
  }, headers)).status, 409);
  assert.equal((await request(app, 'DELETE', `/api/moderation/groups/${firstGroup.id}`, undefined, headers)).status, 409);
  assert.equal((await request(app, 'DELETE', `/api/moderation/groups/${firstGroup.id}`, {
    confirmation: 'DELETE', topic: 'Stale Topic Name'
  }, headers)).status, 409);
  assert.equal((await request(app, 'DELETE', `/api/moderation/groups/${firstGroup.id}`, {
    confirmation: 'DELETE', topic: firstGroup.topic
  }, headers)).status, 204);
  assert.deepEqual(await app.locals.tabletRepository.list(firstGroup.id), []);
  assert.deepEqual(await app.locals.submissionRepository.list(null, firstGroup.id), []);
  assert.equal((await request(app, 'GET', `/api/moderation/groups/${firstGroup.id}/queue`, undefined, headers)).status, 404);
  assert.equal((await request(app, 'GET', `/api/topics/${firstGroup.id}`)).status, 404);
  assert.equal((await request(app, 'GET', '/api/presentations')).body.presentations.length, 1);
});

test('closing and rotating a group submission link is enforced by the server', async () => {
  const app = createTestApp();
  const cookie = await moderatorCookie(app);
  const headers = { Cookie: cookie };
  const group = await createGroup(app, headers, 'Secret Topic');

  assert.equal((await request(app, 'POST', `/api/moderation/groups/${group.id}/close`, undefined, headers)).status, 200);
  const closedContext = await request(app, 'GET', `/api/submission-groups/${group.submissionToken}`);
  assert.equal(closedContext.body.accepting, false);
  assert.equal((await submitClue(app, group, 'Late', 'Too late')).status, 409);

  const rotated = await request(app, 'POST', `/api/moderation/groups/${group.id}/rotate-token`, undefined, headers);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.group.submissionToken, group.submissionToken);
  assert.equal((await request(app, 'GET', `/api/submission-groups/${group.submissionToken}`)).status, 404);
  assert.equal((await request(app, 'GET', `/api/submission-groups/${rotated.body.group.submissionToken}`)).status, 200);
});

test('group submission rate limiting returns a retry window', async () => {
  const app = createTestApp({ submissionLimiter: new RateLimiter({ max: 1, windowMs: 60_000 }) });
  const cookie = await moderatorCookie(app);
  const group = await createGroup(app, { Cookie: cookie }, 'Rate Topic');
  assert.equal((await submitClue(app, group, 'One', 'First')).status, 202);
  const limited = await submitClue(app, group, 'Two', 'Second');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('group, tablet, and submission validation reject incomplete records', async () => {
  const groups = new MemoryGroupRepository();
  const tablets = new MemoryTabletRepository();
  const submissions = new MemorySubmissionRepository();
  await assert.rejects(() => groups.create({ topic: '' }), /topic/i);
  await assert.rejects(() => tablets.save({ author: 'Missing group', riddle: 'Missing topic' }), /required/i);
  await assert.rejects(() => submissions.create({ groupId: 'valid-group', author: '', riddle: 'Missing author' }), /required/i);
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

test('local storage stays on JSON files even when remote credentials are present', () => {
  const remoteEnvironment = {
    UPSTASH_REDIS_REST_URL: 'https://production.example',
    UPSTASH_REDIS_REST_TOKEN: 'production-token',
    VERCEL: '1',
    VERCEL_ENV: 'development',
    VERCEL_URL: 'local-preview.example'
  };
  assert.equal(isVercelProductionRuntime(remoteEnvironment), false);
  assert.equal(resolveStorageCredentials(remoteEnvironment), null);

  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'riddle-tablets-local-'));
  try {
    assert.ok(createDefaultGroupRepository(rootDirectory, remoteEnvironment) instanceof JsonGroupRepository);
    assert.ok(createDefaultTabletRepository(rootDirectory, remoteEnvironment) instanceof JsonTabletRepository);
    assert.ok(createDefaultSubmissionRepository(rootDirectory, remoteEnvironment) instanceof JsonSubmissionRepository);
  } finally {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('only the live Vercel production runtime can select Redis storage', () => {
  const productionEnvironment = {
    UPSTASH_REDIS_REST_URL: 'https://production.example',
    UPSTASH_REDIS_REST_TOKEN: 'production-token',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_URL: 'riddle-tablets.vercel.app'
  };
  assert.equal(isVercelProductionRuntime(productionEnvironment), true);
  assert.deepEqual(resolveStorageCredentials(productionEnvironment), {
    url: 'https://production.example',
    token: 'production-token'
  });
  assert.equal(resolveStorageCredentials({
    ...productionEnvironment,
    RIDDLE_TABLETS_STORAGE: 'local'
  }), null);
  assert.throws(() => resolveStorageCredentials({
    ...productionEnvironment,
    VERCEL_ENV: 'development',
    RIDDLE_TABLETS_STORAGE: 'redis'
  }), /restricted to the Vercel production runtime/);
});

test('collection endpoints batch tablet and submission reads', async () => {
  class CountingTabletRepository extends MemoryTabletRepository {
    constructor() {
      super();
      this.listCalls = 0;
    }

    async list(groupId = null) {
      this.listCalls += 1;
      return super.list(groupId);
    }
  }

  class CountingSubmissionRepository extends MemorySubmissionRepository {
    constructor() {
      super();
      this.listCalls = 0;
    }

    async list(status = null, groupId = null) {
      this.listCalls += 1;
      return super.list(status, groupId);
    }
  }

  const groups = new MemoryGroupRepository();
  const tablets = new CountingTabletRepository();
  const submissions = new CountingSubmissionRepository();
  const app = createTestApp({ groupRepository: groups, tabletRepository: tablets, submissionRepository: submissions });
  const first = await groups.create({ topic: 'First' });
  const second = await groups.create({ topic: 'Second' });
  await tablets.save({ groupId: first.id, topic: first.topic, author: 'One', riddle: 'First clue' });
  await tablets.save({ groupId: second.id, topic: second.topic, author: 'Two', riddle: 'Second clue' });
  await submissions.create({ groupId: second.id, topic: second.topic, author: 'Pending', riddle: 'Pending clue' });
  await groups.setStatus(first.id, 'archived');
  await groups.setStatus(second.id, 'active');

  tablets.listCalls = 0;
  assert.equal((await request(app, 'GET', '/api/presentations')).status, 200);
  assert.equal(tablets.listCalls, 1);

  tablets.listCalls = 0;
  assert.equal((await request(app, 'GET', '/api/topics')).status, 200);
  assert.equal(tablets.listCalls, 1);

  const headers = { Cookie: await moderatorCookie(app) };
  tablets.listCalls = 0;
  submissions.listCalls = 0;
  assert.equal((await request(app, 'GET', '/api/moderation/groups', undefined, headers)).status, 200);
  assert.equal(tablets.listCalls, 1);
  assert.equal(submissions.listCalls, 1);
});

test('shared group mutations preserve competing activations', async () => {
  class FakeRedis {
    constructor(records) {
      this.hash = new Map(Object.entries(records));
      this.values = new Map();
    }

    async hgetall() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Object.fromEntries([...this.hash].map(([id, group]) => [id, { ...group }]));
    }

    async hset(key, writes) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      Object.entries(writes).forEach(([id, group]) => this.hash.set(id, { ...group }));
      return Object.keys(writes).length;
    }

    async hget(key, id) {
      const group = this.hash.get(id);
      return group ? { ...group } : null;
    }

    async set(key, value, options = {}) {
      if (options.nx && this.values.has(key)) return null;
      this.values.set(key, value);
      return 'OK';
    }

    async eval(script, keys, args) {
      if (this.values.get(keys[0]) !== args[0]) return 0;
      this.values.delete(keys[0]);
      return 1;
    }
  }

  const now = Date.now();
  const record = (id, topic, status) => ({
    id,
    topic,
    status,
    submissionToken: `${id}${'x'.repeat(24)}`,
    createdAt: now,
    updatedAt: now,
    activatedAt: status === 'active' ? now : null,
    archivedAt: null,
    completedAt: null
  });
  const redis = new FakeRedis({
    current: record('current', 'Current', 'active'),
    second: record('second', 'Second', 'open'),
    third: record('third', 'Third', 'open')
  });
  const groups = new UpstashGroupRepository({ key: 'groups', redis });

  await Promise.all([
    groups.setStatus('second', 'active'),
    groups.setStatus('third', 'active')
  ]);

  const records = await groups.list();
  assert.equal(records.filter((group) => group.status === 'active').length, 3);
  const active = records.find((group) => group.status === 'active');
  const completed = await groups.setCompleted(active.id, true);
  assert.equal(completed.status, 'archived');
  assert.ok(completed.completedAt);
  assert.equal((await groups.list()).filter((group) => group.status === 'active').length, 2);
  assert.ok(await groups.getActive());
  await assert.rejects(() => groups.setStatus(active.id, 'active'), (error) => error.code === 'group_conflict');
  const incomplete = await groups.setCompleted(active.id, false);
  assert.equal(incomplete.status, 'archived');
  assert.equal(incomplete.completedAt, null);
});
