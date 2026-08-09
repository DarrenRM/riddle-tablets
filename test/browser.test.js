'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { createApp, RateLimiter } = require('../app');
const {
  MemoryGroupRepository,
  MemorySubmissionRepository,
  MemoryTabletRepository
} = require('../lib/tablet-repository');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

test('topic creation, submission, moderation, presentation, and local group completion work', { timeout: 90000 }, async (t) => {
  const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) return t.skip('No supported local Chromium browser was found.');

  const groupRepository = new MemoryGroupRepository();
  const tabletRepository = new MemoryTabletRepository();
  const app = createApp({
    groupRepository,
    tabletRepository,
    submissionRepository: new MemorySubmissionRepository(),
    submissionLimiter: new RateLimiter({ max: 20, windowMs: 60_000 }),
    config: { moderatorPassword: 'browser-password', logRequests: false },
    logger: { log() {}, error() {} }
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#waiting-state').isVisible(), true);
    assert.equal(await page.locator('#waiting-state h1').textContent(), 'Hamis Waits');
    assert.equal(await page.locator('#waiting-state p').textContent(), 'No new topic has awakened.');
    assert.match(
      await page.locator('#waiting-state h1').evaluate((element) => getComputedStyle(element).fontFamily),
      /NoitaPixel/
    );
    assert.match(
      await page.locator('#waiting-state h1').evaluate((element) => getComputedStyle(element).color),
      /240, 192, 64/
    );
    assert.match(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).backgroundImage),
      /longleg\.png/
    );
    assert.equal(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).animationName),
      'longleg-idle'
    );
    assert.equal(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).animationDuration),
      '1.2s'
    );
    await page.locator('.longleg-sprite.hearting').waitFor({ state: 'attached', timeout: 9000 });
    assert.equal(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).animationName),
      'longleg-hearts'
    );
    assert.equal(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).animationDuration),
      '0.6s'
    );
    assert.match(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).backgroundPosition),
      /-141px/
    );
    await page.locator('.longleg-sprite.hearting').waitFor({ state: 'detached', timeout: 4000 });
    assert.equal(
      await page.locator('.longleg-sprite').evaluate((element) => getComputedStyle(element).animationName),
      'longleg-idle'
    );

    await page.goto(`${origin}/approve`, { waitUntil: 'domcontentloaded' });
    await page.locator('#approve-password').fill('browser-password');
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.locator('#new-group-button').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'Topic Groups');

    await page.locator('#new-group-button').click();
    await page.locator('#create-group-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#create-group-dialog').getByText(/Discord URL/i).count(), 0);
    await page.locator('#new-group-topic').fill('The Work');
    await page.locator('#create-group-submit').click();
    await page.locator('#create-group-success').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#created-group-topic').textContent(), 'The Work');
    assert.equal(await page.locator('#open-created-group-form').count(), 0);
    const submissionUrl = await page.locator('#created-group-link').inputValue();
    assert.match(submissionUrl, new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/submit/[A-Za-z0-9_-]+$`));
    await page.locator('#create-group-success').getByRole('button', { name: 'Done' }).click();
    assert.equal(await page.locator('.group-list-item').count(), 1);
    const topicControlBoxes = await Promise.all([
      page.locator('#group-topic-input').boundingBox(),
      page.locator('#save-group-topic').boundingBox()
    ]);
    const topicControlCenters = topicControlBoxes.map((box) => box.y + (box.height / 2));
    assert.ok(Math.max(...topicControlCenters) - Math.min(...topicControlCenters) < 1);

    await page.goto(submissionUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#submission-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#submission-topic').textContent(), 'The Work');
    assert.match(
      await page.locator('.submit-container h1').evaluate((element) => getComputedStyle(element).color),
      /71, 226, 136/
    );
    assert.equal(await page.locator('[name="topic"]').count(), 0);
    await page.locator('#author-input').fill('First Scribe');
    await page.locator('#riddle-input').fill('Look beneath the mountain.');
    await page.locator('#submit-tablet-btn').click();
    await page.locator('#submission-success').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#submission-form').isVisible(), false);
    assert.equal(await page.locator('#submit-tablet-btn').isVisible(), false);
    const secondSubmission = await page.evaluate(async ({ url }) => {
      const token = url.split('/').filter(Boolean).pop();
      const response = await fetch(`/api/submission-groups/${token}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'Second Scribe', riddle: 'The answer sleeps below the snow.', website: '' })
      });
      return { status: response.status, body: await response.json() };
    }, { url: submissionUrl });
    assert.equal(secondSubmission.status, 202);

    await page.goto(`${origin}/approve`, { waitUntil: 'domcontentloaded' });
    await page.locator('#group-workspace').waitFor({ state: 'visible' });
    for (const selector of ['#preview-group', '#delete-group', '#open-group-form', '#reset-group-link', '#group-status-badge']) {
      assert.equal(await page.locator(selector).count(), 0);
    }
    assert.match(await page.getByRole('button', { name: /Pending/ }).textContent(), /2/);
    assert.equal(await page.locator('.moderation-row').count(), 2);

    await page.locator('.moderation-row').first().getByRole('button', { name: 'Approve' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 1);
    await page.locator('.moderation-row').first().getByRole('button', { name: 'Approve' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 0);
    await page.getByRole('button', { name: /Approved/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 2);
    assert.equal(await page.locator('.moderation-row').first().getByRole('button', { name: 'Move up' }).isDisabled(), true);
    assert.equal(await page.locator('.moderation-row').last().getByRole('button', { name: 'Move down' }).isDisabled(), true);
    assert.equal(await page.locator('#toggle-group-completion').textContent(), 'Mark complete');
    await page.locator('#toggle-group-completion').click();
    await page.waitForFunction(() => document.querySelector('#toggle-group-completion').textContent === 'Mark incomplete');
    assert.equal(await page.locator('#toggle-group-submissions').isDisabled(), true);
    assert.equal(await page.locator('#activate-group').isDisabled(), true);
    assert.equal(await page.locator('#activate-group').textContent(), 'Mark incomplete first');
    await page.locator('#toggle-group-completion').click();
    await page.waitForFunction(() => document.querySelector('#toggle-group-completion').textContent === 'Mark complete');

    await page.locator('#toggle-group-submissions').click();
    await page.waitForFunction(() => document.querySelector('#toggle-group-submissions').textContent === 'Close submissions');
    await page.locator('#toggle-group-submissions').click();
    await page.waitForFunction(() => document.querySelector('#toggle-group-submissions').textContent === 'Reopen submissions');
    const waitingPage = await context.newPage();
    await waitingPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await waitingPage.locator('#waiting-state').isVisible(), true);
    page.once('dialog', (confirmation) => {
      assert.equal(confirmation.message(), 'Make this the active topic? The current active topic will no longer be active.');
      confirmation.accept();
    });
    await page.locator('#activate-group').click();
    await page.waitForFunction(() => document.querySelector('#activate-group').textContent === 'Currently active');
    await waitingPage.locator('#active-topic-heading').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await waitingPage.locator('#active-topic-heading').textContent(), 'The Work');
    await waitingPage.close();

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#active-topic-heading').textContent(), 'The Work');
    const cards = page.locator('#tablet-grid .riddle-tablet');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.first().getAttribute('aria-expanded'), 'false');
    assert.equal(await cards.first().locator('.riddle-author').textContent(), 'Inscribed by');
    assert.match(
      await cards.first().locator('.riddle-author-name').evaluate((element) => getComputedStyle(element).color),
      /168, 102, 255/
    );
    assert.equal(await page.locator('#solve-topic-button').isVisible(), false);

    await cards.first().getByRole('button', { name: 'Reveal tablet' }).click();
    await page.waitForFunction(() => document.querySelector('#tablet-grid .riddle-tablet').classList.contains('revealed'));
    assert.equal(await cards.first().getByRole('button', { name: 'Close tablet' }).isVisible(), true);
    assert.equal(await page.locator('#solve-topic-button').isVisible(), true);
    assert.equal(await page.locator('#solve-topic-button img').getAttribute('src'), '/images/sampo.png');
    assert.equal(await page.locator('#solve-topic-flavor').textContent(), "There's no undo button.");

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => { Math.random = () => 0.75; });
    await page.locator('#solve-topic-button').click();
    await page.locator('#completion-celebration[data-phase="success"]').waitFor();
    assert.equal(await page.locator('#completion-title').getAttribute('aria-label'), 'Success');
    assert.equal(await page.locator('#waiting-state').isVisible(), true);
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    assert.match(
      await page.locator('.solved-topic .topic-heading').evaluate((element) => getComputedStyle(element).color),
      /240, 192, 64/
    );
    assert.ok(
      await page.locator('.solved-topic .topic-heading').evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) < 13
    );
    assert.equal(await page.locator('.solved-topic .riddle-tablet').count(), 2);
    const solvedHeadingBox = await page.locator('.solved-topic .topic-heading').boundingBox();
    assert.ok(Math.abs((solvedHeadingBox.x + (solvedHeadingBox.width / 2)) - 720) < 1);
    assert.equal(await page.locator('#active-topic').isVisible(), false);
    await page.locator('#completion-celebration.dismissible').waitFor();
    await page.waitForFunction(
      () => document.querySelector('#ancient-sound').volume < 0.3,
      null,
      { timeout: 12000 }
    );
    await page.locator('#completion-celebration').waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(await page.locator('#completion-celebration').getAttribute('aria-hidden'), 'true');

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.solved-topic').isVisible(), true);
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    assert.equal(await page.locator('#return-topic-button').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Past topics' }).count(), 0);

    const freshContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const freshPage = await freshContext.newPage();
    await freshPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await freshPage.locator('#active-topic').isVisible(), true);
    assert.equal(await freshPage.locator('.solved-topic').count(), 0);
    assert.equal(await freshPage.locator('#tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'false');
    await freshContext.close();

    const nextGroup = await groupRepository.create({ topic: 'The Moon' });
    await tabletRepository.save({
      groupId: nextGroup.id,
      topic: nextGroup.topic,
      author: 'Moon Scribe',
      riddle: 'Borrowed light.',
      position: 0
    });
    await groupRepository.setStatus(nextGroup.id, 'active');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#active-topic-heading').textContent(), 'The Moon');
    assert.equal(await page.locator('.solved-topic').count(), 1);
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    assert.equal(await page.getByRole('link', { name: 'Past topics' }).count(), 0);

    const singleGrid = page.locator('#tablet-grid');
    const singleCard = singleGrid.locator('.riddle-tablet');
    await page.waitForFunction(() => document.querySelector('#tablet-grid').classList.contains('masonry-ready'));
    const [singleGridBox, singleCardBox] = await Promise.all([singleGrid.boundingBox(), singleCard.boundingBox()]);
    assert.equal(await singleGrid.evaluate((element) => element.classList.contains('single-tablet-grid')), true);
    assert.ok(singleGridBox.width <= 720);
    assert.ok(Math.abs((singleCardBox.x + (singleCardBox.width / 2)) - 720) < 1);
    assert.equal(await page.locator('#solve-topic-button').isVisible(), false);

    await singleCard.getByRole('button', { name: 'Reveal tablet' }).click();
    await page.waitForFunction(() => document.querySelector('#tablet-grid .riddle-tablet').classList.contains('revealed'));
    const integratedSolve = singleCard.getByRole('button', { name: 'Mark as Solved' });
    assert.equal(await integratedSolve.isVisible(), true);
    await page.waitForTimeout(250);
    assert.match(
      await integratedSolve.evaluate((element) => getComputedStyle(element).color),
      /98, 96, 112/
    );
    assert.equal(await integratedSolve.textContent(), 'Mark as Solved');
    assert.equal(
      await integratedSolve.evaluate((element) => getComputedStyle(element, '::before').content),
      'none'
    );
    await integratedSolve.hover();
    await page.waitForTimeout(250);
    assert.match(
      await integratedSolve.evaluate((element) => getComputedStyle(element).color),
      /240, 192, 64/
    );
    assert.equal(await page.locator('#solve-topic-button').isVisible(), false);

    await page.goto(`${origin}/preview/topics/${nextGroup.id}`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').getByRole('button', { name: 'Close tablet' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Mark as Solved' }).count(), 0);
    assert.equal(await page.locator('#solve-topic-button').isVisible(), false);

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { Math.random = () => 0.75; });
    await page.getByRole('button', { name: 'Mark as Solved' }).click();
    await page.locator('#completion-celebration[data-phase="success"]').waitFor();
    assert.equal(await page.locator('#waiting-state').isVisible(), true);
    assert.equal(await page.locator('.solved-topic').count(), 2);

    await page.goto(`${origin}/approve`, { waitUntil: 'domcontentloaded' });
    await page.locator('.group-list-item').filter({ hasText: 'The Moon' }).click();
    await page.locator('#toggle-group-completion').click();
    await page.waitForFunction(() => document.querySelector('#toggle-group-completion').textContent === 'Mark incomplete');
    assert.equal(await page.locator('.group-list-item-active .group-mini-status').count(), 0);
    assert.equal(await page.locator('.group-list-item-archived .status-done').count(), 1);
    assert.deepEqual(
      (await page.locator('.group-list-item').evaluateAll((items) => items.map((item) => item.querySelector('strong').textContent))).sort(),
      ['The Moon', 'The Work'].sort()
    );

    const completedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const completedPage = await completedContext.newPage();
    await completedPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await completedPage.locator('#waiting-state').isVisible(), true);
    assert.equal(await completedPage.locator('#active-topic').isVisible(), false);
    await completedContext.close();

    await page.goto(`${origin}/archive`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.topic-archive-card').count(), 2);
    assert.deepEqual(
      (await page.locator('.topic-archive-card strong').allTextContents()).sort(),
      ['The Moon', 'The Work'].sort()
    );
    await page.locator('.topic-archive-card').filter({ hasText: 'The Work' }).click();
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');

    const racePage = await context.newPage();
    await racePage.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 30000) return window.setTimeout(callback, 75, ...args);
        return nativeSetInterval(callback, delay, ...args);
      };
    });
    let presentationCalls = 0;
    await racePage.route('**/api/presentations', async (route) => {
      presentationCalls += 1;
      const call = presentationCalls;
      if (call === 1) await new Promise((resolve) => setTimeout(resolve, 400));
      const topic = call === 1 ? 'Stale Topic' : 'Fresh Topic';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          presentations: [{
            group: { id: call === 1 ? 'stale' : 'fresh', topic, status: 'active', updatedAt: call },
            tablets: []
          }]
        })
      });
    });
    await racePage.goto(origin, { waitUntil: 'domcontentloaded' });
    await racePage.locator('#active-topic-heading').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await racePage.locator('#active-topic-heading').textContent(), 'Fresh Topic');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await racePage.locator('#active-topic-heading').textContent(), 'Fresh Topic');
    await racePage.close();

  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
