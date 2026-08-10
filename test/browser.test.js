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
  const submissionRepository = new MemorySubmissionRepository();
  const app = createApp({
    groupRepository,
    tabletRepository,
    submissionRepository,
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
    assert.equal(await page.locator('h1').textContent(), 'Riddle Groups');

    await page.locator('#new-group-button').click();
    await page.locator('#create-group-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#create-group-dialog').getByText(/Discord URL/i).count(), 0);
    await page.locator('#new-group-topic').fill('The Work');
    await page.locator('#create-group-submit').click();
    await page.locator('#create-group-success').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#created-group-topic').textContent(), 'The Work');
    assert.equal(await page.locator('#open-created-group-form').count(), 0);
    const submissionUrl = await page.locator('#created-group-link').textContent();
    assert.match(submissionUrl, new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/submit/[A-Za-z0-9_-]+$`));
    await page.locator('#create-group-success').getByRole('button', { name: 'Done' }).click();
    assert.equal(await page.locator('.group-list-item').count(), 1);
    const [sidebarBox, topicNameSize] = await Promise.all([
      page.locator('.group-sidebar').boundingBox(),
      page.locator('.group-list-item strong').evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    ]);
    assert.ok(sidebarBox.width >= 360);
    assert.ok(topicNameSize >= 13);
    const topicControlBoxes = await Promise.all([
      page.locator('#group-topic-input').boundingBox(),
      page.locator('#save-group-topic').boundingBox()
    ]);
    const topicControlCenters = topicControlBoxes.map((box) => box.y + (box.height / 2));
    assert.ok(Math.max(...topicControlCenters) - Math.min(...topicControlCenters) < 1);
    assert.equal(await page.locator('#group-submission-link').evaluate((element) => element.tagName), 'CODE');
    assert.equal(await page.locator('#group-submission-link').textContent(), submissionUrl);
    const [controlsBox, linkBox] = await Promise.all([
      page.locator('.group-controls').boundingBox(),
      page.locator('#group-workspace .group-link-panel').boundingBox()
    ]);
    assert.ok(controlsBox.y >= linkBox.y + linkBox.height);
    assert.equal(await page.locator('.group-link-panel input').count(), 0);
    assert.equal(await page.locator('#delete-group').getAttribute('aria-label'), 'Delete topic');
    assert.equal(await page.locator('#delete-group svg').count(), 1);
    const [linkValueBox, copyButtonBox, copyIconBox, deleteIconBox] = await Promise.all([
      page.locator('#group-submission-link').boundingBox(),
      page.locator('#copy-group-link').boundingBox(),
      page.locator('#copy-group-link svg').boundingBox(),
      page.locator('#delete-group svg').boundingBox()
    ]);
    assert.ok(copyButtonBox.x - (linkValueBox.x + linkValueBox.width) <= 12);
    assert.ok(copyIconBox.width >= 16 && copyIconBox.height >= 16);
    assert.equal(
      await page.locator('#copy-group-link').evaluate((element) => getComputedStyle(element).borderTopWidth),
      '0px'
    );
    assert.match(
      await page.locator('#copy-group-link').evaluate((element) => getComputedStyle(element).backgroundColor),
      /rgba\(0, 0, 0, 0\)/
    );
    assert.ok(deleteIconBox.width >= 20 && deleteIconBox.height >= 20);

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
    for (const selector of ['#preview-group', '#open-group-form', '#reset-group-link', '#group-status-badge']) {
      assert.equal(await page.locator(selector).count(), 0);
    }
    assert.equal(await page.locator('#delete-group').count(), 1);
    assert.match(await page.getByRole('button', { name: /Pending/ }).textContent(), /2/);
    assert.equal(await page.locator('.moderation-row').count(), 2);

    await page.locator('.moderation-row').first().getByRole('button', { name: 'Approve' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 1);
    await page.locator('.moderation-row').first().getByRole('button', { name: 'Approve' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 0);
    await page.getByRole('button', { name: /Approved/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 2);
    assert.equal(await page.locator('.moderation-row').first().getByRole('button', { name: 'Move clue up' }).isDisabled(), true);
    assert.equal(await page.locator('.moderation-row').last().getByRole('button', { name: 'Move clue down' }).isDisabled(), true);
    await page.route('**/api/moderation/groups/*', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.locator('#group-topic-input').fill('An unsaved topic title');
    await page.locator('#group-multi-step').check();
    assert.equal(await page.locator('#save-group-topic').isDisabled(), true);
    assert.equal(await page.locator('#activate-group').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('.moderation-meta')?.textContent.includes('Step 1'));
    assert.equal(await page.locator('#group-topic-input').evaluate((element) => element.value), 'An unsaved topic title');
    assert.equal(await page.locator('#save-group-topic').isEnabled(), true);
    assert.equal(await page.locator('#activate-group').isEnabled(), true);
    assert.equal(await page.locator('.moderation-row').first().getByRole('button', { name: 'Move step up' }).isDisabled(), true);
    assert.equal(await page.locator('.moderation-row').last().getByRole('button', { name: 'Move step down' }).isDisabled(), true);
    await page.locator('#group-topic-input').fill('The Work');
    await page.locator('#group-multi-step').uncheck();
    await page.waitForFunction(() => document.querySelector('.moderation-meta')?.textContent.includes('Clue 1'));
    await page.unroute('**/api/moderation/groups/*');
    await page.route('**/api/moderation/groups/*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Settings could not be saved.' })
    }));
    await page.locator('#group-multi-step').check();
    await page.waitForFunction(() => document.querySelector('#moderation-status')?.textContent.includes('Settings could not be saved.'));
    assert.equal(await page.locator('#group-multi-step').isChecked(), false);
    assert.equal(await page.locator('#save-group-topic').isEnabled(), true);
    assert.equal(await page.locator('#activate-group').isEnabled(), true);
    await page.unroute('**/api/moderation/groups/*');
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
      assert.equal(confirmation.message(), 'Add this topic to the live page? It will be the only active topic.');
      confirmation.accept();
    });
    await page.locator('#activate-group').click();
    await page.waitForFunction(() => document.querySelector('#activate-group').textContent === 'Deactivate');
    assert.equal(await page.locator('#group-multi-step').isEnabled(), false);
    await page.locator('#delete-group').click();
    await page.locator('#delete-group-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#delete-group-warning').textContent(), /currently live/i);
    assert.equal(await page.locator('#delete-group-confirmation').isDisabled(), true);
    assert.equal(await page.locator('#confirm-delete-group').isDisabled(), true);
    await page.locator('#cancel-delete-group').click();
    await waitingPage.locator('.active-topic .topic-heading').waitFor({ state: 'visible', timeout: 12000 });
    assert.equal(await waitingPage.locator('.active-topic .topic-heading').textContent(), 'The Work');
    await waitingPage.close();

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.active-topic .topic-heading').textContent(), 'The Work');
    assert.equal(await page.locator('#hide-main-riddle-names').isChecked(), false);
    await page.locator('#hide-main-riddle-names').check();
    assert.equal(await page.locator('.active-topic .topic-heading.archive-topic-name-hidden').count(), 1);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('riddle-main-topic-names-hidden.v1')),
      'true'
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#hide-main-riddle-names').isChecked(), true);
    assert.equal(await page.locator('.active-topic .topic-heading.archive-topic-name-hidden').count(), 1);
    assert.match(
      await page.locator('.active-topic .topic-heading').evaluate((heading) => getComputedStyle(heading).fontFamily),
      /NoitaGlyph/
    );
    await page.locator('#hide-main-riddle-names').uncheck();
    await page.waitForFunction(() => {
      const heading = document.querySelector('.active-topic .topic-heading');
      return heading && !heading.classList.contains('archive-topic-name-hidden')
        && heading.querySelectorAll('.glyph-char').length === 0;
    });
    assert.equal(
      await page.evaluate(() => localStorage.getItem('riddle-main-topic-names-hidden.v1')),
      'false'
    );
    assert.equal(await page.locator('.active-topic .topic-heading').textContent(), 'The Work');
    const workSection = page.locator('.active-topic').filter({ hasText: 'The Work' });
    const cards = workSection.locator('.tablet-grid .riddle-tablet');
    assert.equal(await cards.count(), 2);
    const workGrid = workSection.locator('.tablet-grid');
    await page.waitForFunction(() => document.querySelector('.active-topic .tablet-grid').classList.contains('masonry-ready'));
    assert.equal(await workGrid.evaluate((grid) => grid.classList.contains('two-tablet-grid')), true);
    const [workGridBox, firstWorkCardBox, secondWorkCardBox] = await Promise.all([
      workGrid.boundingBox(),
      cards.first().boundingBox(),
      cards.nth(1).boundingBox()
    ]);
    assert.ok(firstWorkCardBox.width > 400);
    assert.ok(Math.abs(
      (workGridBox.x + workGridBox.width / 2)
      - (firstWorkCardBox.x + (secondWorkCardBox.x + secondWorkCardBox.width - firstWorkCardBox.x) / 2)
    ) < 1);
    assert.equal(await cards.first().getAttribute('aria-expanded'), 'false');
    assert.equal(await cards.first().locator('.riddle-author').textContent(), 'Inscribed by');
    assert.match(
      await cards.first().locator('.riddle-author-name').evaluate((element) => getComputedStyle(element).color),
      /168, 102, 255/
    );
    assert.equal(await workSection.locator('.solve-topic-button').isVisible(), false);

    await cards.first().getByRole('button', { name: 'Reveal tablet' }).click();
    await page.waitForFunction(() => document.querySelector('.active-topic .tablet-grid .riddle-tablet').classList.contains('revealed'));
    assert.equal(await cards.first().getByRole('button', { name: 'Close tablet' }).isVisible(), true);
    assert.equal(await workSection.locator('.solve-topic-button').isVisible(), true);
    assert.equal(await workSection.locator('.solve-topic-button img').getAttribute('src'), '/images/sampo.png');
    assert.equal(await workSection.locator('.solve-topic-button small').count(), 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.active-topic .tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => { Math.random = () => 0.75; });
    await page.locator('.active-topic .solve-topic-button').click();
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
    const solvedHeadingRowBox = await page.locator('.solved-topic-heading-row').boundingBox();
    assert.ok(Math.abs((solvedHeadingRowBox.x + (solvedHeadingRowBox.width / 2)) - 720) < 1);
    const [solvedLabelBox, solvedMenuButtonBox] = await Promise.all([
      page.locator('.solved-topic .topic-heading').boundingBox(),
      page.locator('.solved-topic-menu-toggle').boundingBox()
    ]);
    assert.ok(Math.abs(
      (solvedLabelBox.y + (solvedLabelBox.height / 2))
      - (solvedMenuButtonBox.y + (solvedMenuButtonBox.height / 2))
    ) < 1);
    assert.equal(await page.locator('#active-topics').isVisible(), false);
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

    const solvedOptions = page.getByRole('button', { name: 'More options for The Work' });
    const removeFromSolved = page.getByRole('menuitem', { name: 'Remove from Solved' });
    const replaySuccess = page.getByRole('menuitem', { name: 'Replay Success' });
    assert.equal(await solvedOptions.getAttribute('aria-expanded'), 'false');
    await solvedOptions.click();
    assert.equal(await solvedOptions.getAttribute('aria-expanded'), 'true');
    assert.equal(await removeFromSolved.isVisible(), true);
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Remove from Solved', 'Replay Success']);
    await page.evaluate(() => { Math.random = () => 0.75; });
    await replaySuccess.click();
    await page.locator('#completion-celebration[data-phase="success"]').waitFor();
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    assert.match(await page.locator('#ancient-sound').getAttribute('src'), /noita-ancient-02\.mp3/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');

    await solvedOptions.click();
    await removeFromSolved.press('Escape');
    assert.equal(await solvedOptions.getAttribute('aria-expanded'), 'false');
    await solvedOptions.click();
    await page.locator('body').click({ position: { x: 4, y: 4 } });
    assert.equal(await solvedOptions.getAttribute('aria-expanded'), 'false');

    const storagePage = await context.newPage();
    await storagePage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await storagePage.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    await solvedOptions.click();
    await removeFromSolved.click();
    await page.locator('.active-topic .topic-heading').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.active-topic .topic-heading').textContent(), 'The Work');
    assert.equal(await page.locator('.solved-topic').count(), 0);
    assert.equal((await groupRepository.get(groupRepository.groups[0].id)).status, 'active');
    await storagePage.locator('.active-topic .topic-heading').waitFor({ state: 'visible' });
    assert.equal(await storagePage.locator('.solved-topic').count(), 0);
    await storagePage.close();

    await page.locator('.active-topic .solve-topic-button').click();
    await page.locator('.solved-topic .topic-heading').waitFor({ state: 'visible' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');

    const freshContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const freshPage = await freshContext.newPage();
    await freshPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await freshPage.locator('#active-topics').isVisible(), true);
    assert.equal(await freshPage.locator('.solved-topic').count(), 0);
    assert.equal(await freshPage.locator('.active-topic .tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'false');
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
    assert.equal(await page.locator('.active-topic .topic-heading').textContent(), 'The Moon');
    assert.equal(await page.locator('.solved-topic').count(), 1);
    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: The Work');
    assert.equal(await page.getByRole('link', { name: 'Past topics' }).count(), 0);

    const multiContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const multiPage = await multiContext.newPage();
    await multiPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await multiPage.locator('.active-topic').count(), 2);
    assert.deepEqual(
      (await multiPage.locator('.active-topic .topic-heading').allTextContents()).sort(),
      ['The Moon', 'The Work'].sort()
    );
    assert.equal(await multiPage.locator('#active-topics').evaluate((element) => element.classList.contains('multiple-active-topics')), true);
    await multiContext.close();

    const singleGrid = page.locator('.active-topic .tablet-grid');
    const singleCard = singleGrid.locator('.riddle-tablet');
    await page.waitForFunction(() => document.querySelector('.active-topic .tablet-grid').classList.contains('masonry-ready'));
    const [singleGridBox, singleCardBox] = await Promise.all([singleGrid.boundingBox(), singleCard.boundingBox()]);
    assert.equal(await singleGrid.evaluate((element) => element.classList.contains('single-tablet-grid')), true);
    assert.ok(singleGridBox.width <= 720);
    assert.ok(Math.abs((singleCardBox.x + (singleCardBox.width / 2)) - 720) < 1);
    assert.equal(await page.locator('.active-topic .solve-topic-button').isVisible(), false);

    await singleCard.getByRole('button', { name: 'Reveal tablet' }).click();
    await page.waitForFunction(() => document.querySelector('.active-topic .tablet-grid .riddle-tablet').classList.contains('revealed'));
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
    assert.equal(await page.locator('.active-topic .solve-topic-button').isVisible(), false);

    await page.goto(`${origin}/preview/topics/${nextGroup.id}`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.active-topic .tablet-grid .riddle-tablet').getByRole('button', { name: 'Close tablet' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Mark as Solved' }).count(), 0);
    assert.equal(await page.locator('.active-topic .solve-topic-button').isVisible(), false);

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
    assert.equal(await page.locator('.group-list-item-active .group-mini-status').count(), 1);
    assert.equal(await page.locator('.group-list-item-archived .status-done').count(), 1);
    assert.deepEqual(
      (await page.locator('.group-list-item').evaluateAll((items) => items.map((item) => item.querySelector('strong').textContent))).sort(),
      ['The Moon', 'The Work'].sort()
    );

    const solvedAfterCompletionPage = await context.newPage();
    await solvedAfterCompletionPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await solvedAfterCompletionPage.locator('#waiting-state').isVisible(), true);
    assert.deepEqual(
      (await solvedAfterCompletionPage.locator('.solved-topic .topic-heading').allTextContents()).sort(),
      ['Solved: The Moon', 'Solved: The Work'].sort()
    );
    await solvedAfterCompletionPage.close();

    const completedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const completedPage = await completedContext.newPage();
    await completedPage.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await completedPage.locator('#waiting-state').isVisible(), false);
    assert.equal(await completedPage.locator('.active-topic').count(), 1);
    assert.equal(await completedPage.locator('.solved-topic').count(), 0);
    assert.equal(await completedPage.locator('.active-topic .topic-heading').textContent(), 'The Work');

    await page.locator('.group-list-item').filter({ hasText: 'The Work' }).click();
    await page.locator('#toggle-group-completion').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-list-item-active').length === 0);
    assert.equal(await page.locator('.group-list-item-archived .status-done').count(), 2);
    await completedPage.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await completedPage.locator('#waiting-state').isVisible(), true);
    assert.equal(await completedPage.locator('#active-topics').isVisible(), false);
    await completedContext.close();

    const audienceGroup = await groupRepository.create({ topic: 'Audience Preview', status: 'ready' });
    await tabletRepository.save({
      groupId: audienceGroup.id,
      topic: audienceGroup.topic,
      author: 'Archive Scribe',
      riddle: 'Approved before activation.',
      position: 0
    });
    await tabletRepository.save({
      groupId: audienceGroup.id,
      topic: audienceGroup.topic,
      author: 'Second Archive Scribe',
      riddle: 'A second approved inscription.',
      position: 1
    });
    await tabletRepository.save({
      groupId: audienceGroup.id,
      topic: audienceGroup.topic,
      author: 'Third Archive Scribe',
      riddle: 'A third approved inscription.',
      position: 2
    });

    const revealStateBeforeArchive = await page.evaluate(() => localStorage.getItem('riddle-tablet-reveals.v1'));
    await page.goto(`${origin}/archive`, { waitUntil: 'domcontentloaded' });
    await page.locator('.archive-topic').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.archive-topic').count(), 3);
    assert.deepEqual(
      (await page.locator('.archive-topic-name').allTextContents()).sort(),
      ['Audience Preview', 'The Moon', 'The Work'].sort()
    );
    assert.equal(await page.locator('#hide-riddle-names').isChecked(), true);
    assert.equal(await page.locator('.archive-topic-name-hidden').count(), 3);
    assert.deepEqual(
      await page.locator('.archive-topic-name').evaluateAll((headings) => headings.map((heading) => heading.getAttribute('aria-label'))),
      ['Riddle name hidden', 'Riddle name hidden', 'Riddle name hidden']
    );
    assert.match(
      await page.locator('.archive-topic-name').first().evaluate((heading) => getComputedStyle(heading).fontFamily),
      /NoitaGlyph/
    );

    await page.locator('#hide-riddle-names').uncheck();
    await page.waitForFunction(() => [...document.querySelectorAll('.archive-topic-name')].every((heading) => (
      !heading.classList.contains('archive-topic-name-hidden')
      && heading.querySelectorAll('.glyph-char').length === 0
      && heading.querySelectorAll('.pixel-char').length > 0
    )));
    assert.deepEqual(
      (await page.locator('.archive-topic-name').allTextContents()).sort(),
      ['Audience Preview', 'The Moon', 'The Work'].sort()
    );
    await page.locator('#hide-riddle-names').check();
    assert.equal(await page.locator('.archive-topic-name-hidden').count(), 3);
    assert.equal(await page.locator('.archive-topic .riddle-tablet').count(), 6);
    const audienceArchiveGrid = page.locator(`.archive-topic[data-group-id="${audienceGroup.id}"] .tablet-grid`);
    assert.equal(await audienceArchiveGrid.evaluate((grid) => grid.classList.contains('three-tablet-grid')), true);
    assert.equal(await page.locator('.archive-topic .riddle-tablet.revealed').count(), 0);
    const firstArchiveTablet = page.locator('.archive-topic .riddle-tablet').first();
    await firstArchiveTablet.getByRole('button', { name: 'Reveal tablet' }).click();
    await page.waitForFunction(() => document.querySelector('.archive-topic .riddle-tablet').classList.contains('revealed'));
    assert.equal(
      await page.evaluate(() => localStorage.getItem('riddle-tablet-reveals.v1')),
      revealStateBeforeArchive
    );

    const deleteGroup = await groupRepository.create({ topic: 'Delete Me' });
    await tabletRepository.save({
      groupId: deleteGroup.id,
      topic: deleteGroup.topic,
      author: 'Approved Scribe',
      riddle: 'An approved clue.',
      position: 0
    });
    await submissionRepository.create({
      groupId: deleteGroup.id,
      topic: deleteGroup.topic,
      author: 'Pending Scribe',
      riddle: 'A pending clue.',
      status: 'pending'
    });
    await page.goto(`${origin}/approve`, { waitUntil: 'domcontentloaded' });
    await page.locator('.group-list-item').filter({ hasText: 'Delete Me' }).click();
    await page.locator('#delete-group').click();
    await page.locator('#delete-group-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#delete-group-topic').textContent(), /Delete Me/);
    assert.deepEqual(await page.locator('#delete-group-counts li').allTextContents(), [
      '1 approved clue',
      '1 pending clue',
      '0 rejected clues'
    ]);
    assert.equal(await page.locator('#confirm-delete-group').isDisabled(), true);
    await page.locator('#delete-group-confirmation').fill('delete');
    assert.equal(await page.locator('#confirm-delete-group').isDisabled(), true);
    await page.locator('#delete-group-confirmation').fill('DELETE');
    assert.equal(await page.locator('#confirm-delete-group').isDisabled(), false);
    await page.locator('#confirm-delete-group').click();
    await page.locator('#delete-group-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => ![...document.querySelectorAll('.group-list-item')].some((item) => item.textContent.includes('Delete Me')));
    assert.equal(await groupRepository.get(deleteGroup.id), null);
    assert.deepEqual(await tabletRepository.list(deleteGroup.id), []);
    assert.deepEqual(await submissionRepository.list(null, deleteGroup.id), []);

    const racePage = await context.newPage();
    await racePage.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 10000) return window.setTimeout(callback, 75, ...args);
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
    await racePage.locator('.active-topic .topic-heading').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await racePage.locator('.active-topic .topic-heading').textContent(), 'Fresh Topic');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await racePage.locator('.active-topic .topic-heading').textContent(), 'Fresh Topic');
    await racePage.close();

  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('multi-step quests unlock in order, complete on the final step, and reset locally', { timeout: 60000 }, async (t) => {
  const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) return t.skip('No supported local Chromium browser was found.');

  const groupRepository = new MemoryGroupRepository();
  const tabletRepository = new MemoryTabletRepository();
  const submissionRepository = new MemorySubmissionRepository();
  const group = await groupRepository.create({ topic: 'The Fourfold Trial', multiStep: true });
  for (let index = 0; index < 4; index += 1) {
    await tabletRepository.save({
      groupId: group.id,
      topic: group.topic,
      author: `Scribe ${index + 1}`,
      riddle: `Inscription ${index + 1}`,
      position: index
    });
  }
  await groupRepository.setStatus(group.id, 'active');
  const app = createApp({
    groupRepository,
    tabletRepository,
    submissionRepository,
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('.active-topic .topic-heading').textContent(), 'Multi-step: The Fourfold Trial');
    assert.equal(await page.locator('.quest-step').count(), 4);
    assert.equal(await page.locator('.quest-step-current').count(), 1);
    assert.equal(await page.locator('.quest-step-locked').count(), 3);
    assert.equal(await page.locator('.solve-topic-button:visible').count(), 0);
    assert.equal(await page.locator('.quest-step-locked .riddle-text').first().textContent(), '');

    await page.locator('.quest-step-locked').first().click();
    await page.locator('.quest-step-locked.quest-step-denied').waitFor({ state: 'attached', timeout: 1000 });

    await page.locator('.quest-step-current .tablet-toggle').click();
    await page.locator('.quest-step-current.revealed').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.quest-step-current .riddle-text').textContent(), 'Inscription 1');
    assert.equal(await page.locator('.quest-step-current .tablet-open-prompt').textContent(), 'Mark step complete');

    await page.locator('.quest-step-current .tablet-open-prompt').click();
    await page.locator('.quest-step-current.revealed .riddle-text').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.quest-step-completed').count(), 1);
    assert.equal(await page.locator('.quest-step-current .riddle-text').textContent(), 'Inscription 2');
    assert.equal(await page.locator('.quest-step-completed .quest-step-complete-label').textContent(), 'Step Complete');
    await page.mouse.move(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(
      await page.locator('.quest-step-completed .quest-step-close-label').evaluate((element) => getComputedStyle(element).opacity),
      '0'
    );
    await page.locator('.quest-step-completed .tablet-open-prompt').hover();
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(
      await page.locator('.quest-step-completed .quest-step-close-label').evaluate((element) => getComputedStyle(element).opacity),
      '1'
    );

    for (let completed = 2; completed <= 3; completed += 1) {
      await page.locator('.quest-step-current .tablet-open-prompt').click();
      await page.waitForFunction((count) => document.querySelectorAll('.quest-step-completed').length === count, completed);
      await page.locator('.quest-step-current.revealed').waitFor({ state: 'attached' });
    }
    assert.equal(await page.locator('.quest-step-current .riddle-text').textContent(), 'Inscription 4');
    await page.locator('.quest-step-current .tablet-open-prompt').click();
    await page.locator('#completion-celebration.visible').waitFor({ state: 'visible' });
    await page.locator('#completion-celebration.dismissible').waitFor({ state: 'attached', timeout: 3000 });
    await page.locator('#completion-close').click();
    await page.locator('#completion-celebration').waitFor({ state: 'hidden' });

    assert.equal(await page.locator('.solved-topic .topic-heading').textContent(), 'Solved: Multi-step: The Fourfold Trial');
    await page.locator('.solved-topic-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Remove from Solved' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.quest-step-current').length === 1);
    assert.equal(await page.locator('.quest-step-completed').count(), 0);
    assert.equal(await page.locator('.quest-step-locked').count(), 3);
    assert.equal((await groupRepository.get(group.id)).status, 'active');

    await page.locator('.quest-step-current .tablet-open-prompt').click();
    await page.waitForFunction(() => document.querySelectorAll('.quest-step-completed').length === 1);
    await groupRepository.setStatus(group.id, 'ready');
    await groupRepository.update(group.id, { multiStep: false });
    const restartedQuest = await groupRepository.update(group.id, { multiStep: true });
    assert.equal(restartedQuest.questRevision, 2);
    await groupRepository.setStatus(group.id, 'active');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.quest-step-completed').count(), 0);
    assert.equal(await page.locator('.quest-step-current .riddle-author-name').textContent(), 'Scribe 1');

    await page.locator('.quest-step-current .tablet-open-prompt').click();
    await page.waitForFunction(() => document.querySelectorAll('.quest-step-completed').length === 1);
    const reordered = await tabletRepository.list(group.id);
    await tabletRepository.save({ ...reordered[0], position: 1 }, reordered[0].id);
    await tabletRepository.save({ ...reordered[1], position: 0 }, reordered[1].id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.quest-step-completed').count(), 0);
    assert.equal(await page.locator('.quest-step-current .riddle-author-name').textContent(), 'Scribe 2');
    assert.equal(await page.locator('.quest-step-locked').count(), 3);

    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
