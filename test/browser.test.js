'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { createApp, RateLimiter } = require('../app');
const { MemorySubmissionRepository, MemoryTabletRepository } = require('../lib/tablet-repository');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function fixture(id, topic, author, riddle, offset) {
  const timestamp = Date.now() - offset;
  return { id, topic, author, riddle, createdAt: timestamp, updatedAt: timestamp };
}

test('public submission, moderation, masonry, reveal, and completion flows work', { timeout: 90000 }, async (t) => {
  const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) return t.skip('No supported local Chromium browser was found.');
  const tablets = new MemoryTabletRepository([
    fixture('time', 'Time', 'Last Scribe', 'I am held by none.', 1000),
    fixture('newest', 'Newest', 'Layout Scribe', 'I should sit directly beneath the first tablet.', 2000),
    fixture('echo', 'Echo', 'Cave Listener', Array(120).fill('you can').join(' '), 3000),
    fixture('fire', 'Fire', 'Ash Keeper', 'I die when I drink.', 4000),
    fixture('moon', 'Moonlight', 'First Scribe', 'I borrow the sun and return it pale.', 5000)
  ]);
  const app = createApp({
    tabletRepository: tablets,
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const origin = `http://127.0.0.1:${server.address().port}`;

    await page.goto(`${origin}/submit`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#submission-form').isVisible(), true);
    assert.equal(await page.locator('.saved-section').count(), 0);
    assert.equal(await page.locator('.eyebrow').textContent(), 'Inscribe your own tablet for Crunchpuff');
    assert.equal(await page.locator('h1').textContent(), 'Submit a Spoiler / Riddle');
    assert.equal(await page.locator('.subtitle').textContent(), 'Mods will review and approve');
    assert.match(
      await page.locator('#submit-tablet-btn').evaluate((element) => getComputedStyle(element).fontFamily),
      /NoitaPixel/
    );
    await page.locator('#topic-input').fill('Review me');
    await page.locator('#author-input').fill('Public Scribe');
    const multilineRiddle = 'First line.\n\nThird line after an empty line.';
    await page.locator('#riddle-input').fill(multilineRiddle);
    await page.locator('#submit-tablet-btn').click();
    await page.getByText('Submitted for review.').waitFor();
    assert.equal(await page.locator('#topic-input').inputValue(), '');

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const cards = page.locator('#tablet-grid .riddle-tablet');
    assert.equal(await cards.count(), 5);
    assert.equal(await page.getByText('Review me').count(), 0);
    const boxes = await Promise.all(Array.from({ length: 4 }, (_, index) => cards.nth(index).boundingBox()));
    assert.ok(boxes.every((box) => box && Math.abs(box.y - boxes[0].y) < 1));
    const fifthClosedBox = await cards.nth(4).boundingBox();
    const gridGap = await page.locator('#tablet-grid').evaluate((element) => parseFloat(getComputedStyle(element).columnGap));
    assert.ok(Math.abs(fifthClosedBox.x - boxes[0].x) < 1);
    assert.ok(Math.abs(fifthClosedBox.y - (boxes[0].y + boxes[0].height + gridGap)) < 2);
    assert.equal(await cards.first().getAttribute('aria-expanded'), 'false');
    const sealOffset = await cards.first().evaluate((card) => {
      const cardBox = card.getBoundingClientRect();
      const sealBox = card.querySelector('.tablet-seal').getBoundingClientRect();
      return (sealBox.left + sealBox.width / 2) - (cardBox.left + cardBox.width / 2);
    });
    assert.ok(Math.abs(sealOffset + 1.6) < 0.5);
    const closedBox = await cards.first().boundingBox();
    assert.ok(closedBox.height < 220);
    assert.notEqual(
      await cards.first().locator('.riddle-author-label').evaluate((element) => getComputedStyle(element).color),
      await cards.first().locator('.riddle-author-name').evaluate((element) => getComputedStyle(element).color)
    );
    assert.notEqual(
      await cards.first().locator('.tablet-open-prompt').evaluate((element) => getComputedStyle(element).animationName),
      'none'
    );
    await cards.first().click({ position: { x: 6, y: 6 } });
    await page.waitForFunction(() => {
      const audio = document.querySelector('#tablet-open-sound');
      return !audio.paused && audio.currentTime > 0;
    });
    await cards.first().evaluate((element) => new Promise((resolve) => {
      const done = () => element.classList.contains('revealed') ? resolve() : requestAnimationFrame(done);
      done();
    }));
    await cards.first().click({ position: { x: 6, y: 6 } });
    await page.waitForTimeout(700);
    assert.equal(await cards.first().getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(
      () => Boolean(document.querySelector('.riddle-tablet:not(.revealed) .riddle-topic .glyph-char')),
      null,
      { timeout: 8500 }
    );

    await cards.nth(2).locator('.tablet-toggle').click();
    await cards.nth(2).evaluate((element) => new Promise((resolve) => {
      const done = () => element.classList.contains('revealed') ? resolve() : requestAnimationFrame(done);
      done();
    }));
    await page.waitForTimeout(500);
    const longBox = await cards.nth(2).boundingBox();
    const firstAfterLongReveal = await cards.first().boundingBox();
    const fifthAfterLongReveal = await cards.nth(4).boundingBox();
    assert.ok(longBox.height > 700);
    assert.ok(Math.abs(fifthAfterLongReveal.y - (firstAfterLongReveal.y + firstAfterLongReveal.height + gridGap)) < 2);
    assert.ok(fifthAfterLongReveal.y < longBox.y + longBox.height - 300);
    await cards.nth(2).locator('.tablet-toggle').click();
    await page.waitForTimeout(700);

    await cards.first().locator('.tablet-toggle').click();
    await cards.first().evaluate((element) => new Promise((resolve) => {
      const done = () => element.classList.contains('revealed') ? resolve() : requestAnimationFrame(done);
      done();
    }));
    const openBox = await cards.first().boundingBox();
    assert.ok(openBox.height > closedBox.height);
    assert.equal(await cards.first().locator('.tablet-open-prompt').textContent(), 'Mark as complete');
    assert.equal(
      await cards.first().locator('.riddle-topic').evaluate((element) => getComputedStyle(element).fontSize),
      await cards.first().locator('.riddle-text').evaluate((element) => getComputedStyle(element).fontSize)
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'true');
    const completeButton = page.locator('#tablet-grid .riddle-tablet').first().getByRole('button', { name: 'Mark as complete' });
    await completeButton.hover();
    await page.waitForTimeout(220);
    assert.equal(
      await completeButton.evaluate((element) => getComputedStyle(element).color),
      'rgb(240, 192, 64)'
    );
    await page.evaluate(() => { Math.random = () => 0.25; });
    await completeButton.click();
    await page.locator('#completion-celebration[data-phase="game-over"]').waitFor();
    assert.equal(await page.locator('#completion-title').getAttribute('aria-label'), 'Game Over');
    assert.equal(await page.locator('#completion-title .completion-letter').count(), 0);
    assert.notEqual(
      await page.locator('#completion-celebration').evaluate((element) => getComputedStyle(element).backdropFilter),
      'none'
    );
    const pulseCenter = await page.locator('.completion-pulse').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    assert.ok(Math.abs(pulseCenter.x - 720) < 1);
    assert.ok(Math.abs(pulseCenter.y - 500) < 1);
    assert.equal(await page.locator('#completion-sound').evaluate((element) => element.paused), false);
    assert.match(
      await page.locator('#completion-title').evaluate((element) => getComputedStyle(element).fontFamily),
      /NoitaBlackletter/
    );
    await page.locator('#completion-celebration[data-phase="scrambling"]').waitFor({ timeout: 3000 });
    const letterPositions = await page.locator('#completion-title .completion-letter').evaluateAll((letters) => (
      letters.map((letter) => letter.getBoundingClientRect().left)
    ));
    assert.equal(letterPositions.length, 9);
    assert.ok(letterPositions.every((position, index) => index === 0 || position > letterPositions[index - 1]));
    await page.locator('#completion-celebration[data-phase="success"]').waitFor({ timeout: 4000 });
    assert.equal(await page.locator('#completion-title').getAttribute('aria-label'), 'Success');
    assert.equal(await page.locator('#completion-title .completion-letter').count(), 0);
    assert.equal(await page.locator('#completion-celebration').evaluate((element) => element.classList.contains('dismissible')), true);
    assert.equal(await page.locator('#completion-close').isVisible(), true);
    assert.equal(await page.locator('#completed-tablet-grid .riddle-tablet').count(), 1);
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').count(), 4);
    await page.locator('#completion-sound').evaluate((audio) => {
      audio.currentTime = Math.max(0, audio.duration - 0.12);
    });
    await page.waitForFunction(() => {
      const audio = document.querySelector('#ancient-sound');
      return audio.src.includes('noita-ancient-01.mp3') && !audio.paused && audio.currentTime > 0;
    });
    await page.locator('#completion-celebration').click({ position: { x: 20, y: 20 } });
    await page.waitForFunction(() => document.querySelector('#completion-celebration').getAttribute('aria-hidden') === 'true');
    assert.equal(await page.locator('#completion-celebration').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#completion-sound').evaluate((audio) => audio.paused && audio.currentTime === 0), true);
    assert.equal(await page.locator('#ancient-sound').evaluate((audio) => audio.paused && audio.currentTime === 0), true);
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').count(), 4);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#completed-tablet-grid .riddle-tablet').count(), 1);
    await page.locator('#completed-tablet-grid .tablet-open-prompt').click();
    await page.waitForFunction(() => document.querySelectorAll('#tablet-grid .riddle-tablet').length === 5);

    await page.evaluate(() => { Math.random = () => 0.75; });
    const directCompleteButton = page.locator('#tablet-grid .riddle-tablet').first().getByRole('button', { name: 'Mark as complete' });
    await directCompleteButton.click();
    await page.locator('#completion-celebration[data-phase="success"]').waitFor();
    assert.equal(await page.locator('#completion-title').getAttribute('aria-label'), 'Success');
    assert.equal(await page.locator('#completed-tablet-grid .riddle-tablet').count(), 1);
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').count(), 4);
    assert.equal(await page.locator('#completion-sound').evaluate((audio) => audio.paused), true);
    await page.waitForFunction(() => {
      const audio = document.querySelector('#ancient-sound');
      return audio.src.includes('noita-ancient-02.mp3') && !audio.paused && audio.currentTime > 0;
    });
    await page.locator('#completion-celebration.dismissible').waitFor();
    await page.locator('#completion-close').click();
    await page.locator('#completed-tablet-grid .riddle-tablet').waitFor();
    assert.equal(await page.locator('#ancient-sound').evaluate((audio) => audio.paused && audio.currentTime === 0), true);
    await page.locator('#completed-tablet-grid .tablet-open-prompt').click();
    await page.waitForFunction(() => document.querySelectorAll('#tablet-grid .riddle-tablet').length === 5);

    await page.goto(`${origin}/approve`, { waitUntil: 'domcontentloaded' });
    await page.locator('#approve-password').fill('browser-password');
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.locator('#moderation-tabs').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'Riddle Review');
    assert.ok(parseFloat(await page.getByRole('button', { name: /Pending/ }).evaluate((element) => getComputedStyle(element).fontSize)) >= 13);
    assert.match(await page.getByRole('button', { name: /Pending/ }).textContent(), /1/);
    const pendingRow = page.locator('.moderation-row').first();
    assert.equal(await pendingRow.locator('[name="topic"]').inputValue(), 'Review me');
    assert.equal(await pendingRow.locator('[name="riddle"]').inputValue(), multilineRiddle);
    await pendingRow.locator('[name="topic"]').fill('Reviewed in browser');
    await pendingRow.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Inscription approved.').waitFor();
    await page.getByRole('button', { name: /Published/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.moderation-row').length === 6);
    const publishedTopics = await page.locator('.moderation-row [name="topic"]').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.ok(publishedTopics.includes('Reviewed in browser'));

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').count(), 6);
    assert.equal(await page.getByText('Reviewed in browser').count(), 1);
    const multilineCard = page.locator('#tablet-grid .riddle-tablet').filter({ hasText: 'Reviewed in browser' });
    await multilineCard.locator('.tablet-toggle').click();
    await multilineCard.evaluate((element) => new Promise((resolve) => {
      const done = () => element.classList.contains('revealed') ? resolve() : requestAnimationFrame(done);
      done();
    }));
    assert.equal(await multilineCard.locator('.riddle-text').textContent(), multilineRiddle);
    assert.equal(
      await multilineCard.locator('.riddle-text').evaluate((element) => getComputedStyle(element).whiteSpace),
      'pre-wrap'
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
