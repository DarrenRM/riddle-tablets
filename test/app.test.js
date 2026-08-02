'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../app');
const { MemoryTabletRepository } = require('../lib/tablet-repository');

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

test('the editor is gated and authenticated writes are publicly readable', async () => {
  const app = createApp({
    tabletRepository: new MemoryTabletRepository(),
    config: { createPassword: 'test-password', logRequests: false },
    logger: { log() {}, error() {} }
  });
  const landing = await request(app, 'GET', '/');
  assert.equal(landing.status, 200);
  assert.match(landing.body, /id="tablet-grid"/);
  assert.doesNotMatch(landing.body, /\/create/);

  const locked = await request(app, 'GET', '/create');
  assert.match(locked.body, /id="create-login-form"/);
  assert.equal((await request(app, 'POST', '/api/create/login', { password: 'wrong' })).status, 401);
  assert.equal((await request(app, 'POST', '/api/tablets', { topic: 'T', author: 'A', riddle: 'R' })).status, 401);

  const login = await request(app, 'POST', '/api/create/login', { password: 'test-password' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const editor = await request(app, 'GET', '/create.html', undefined, { Cookie: cookie });
  assert.match(editor.body, /id="tablet-form"/);

  const saved = await request(app, 'POST', '/api/tablets', {
    topic: 'Min-max tips for healing', author: 'Field Surgeon', riddle: 'What closes every wound?'
  }, { Cookie: cookie });
  assert.equal(saved.status, 201);
  const publicList = await request(app, 'GET', '/api/tablets');
  assert.equal(publicList.body.tablets.length, 1);
  assert.equal(publicList.body.tablets[0].topic, 'Min-max tips for healing');
});

test('tablet validation rejects incomplete records', async () => {
  const repository = new MemoryTabletRepository();
  await assert.rejects(() => repository.save({ topic: 'Missing fields' }), /all required/i);
});
