'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { createApp } = require('../app');
const { MemoryTabletRepository } = require('../lib/tablet-repository');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

test('save, edit, masonry reveal, and local reveal/completion state work', { timeout: 60000 }, async (t) => {
  const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) return t.skip('No supported local Chromium browser was found.');
  const app = createApp({
    tabletRepository: new MemoryTabletRepository(),
    config: { createPassword: 'browser-password', logRequests: false },
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
    await page.goto(`${origin}/create`, { waitUntil: 'domcontentloaded' });
    await page.locator('#create-password').fill('browser-password');
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.locator('#tablet-form').waitFor();

    async function save(topic, author, riddle) {
      await page.locator('#topic-input').fill(topic);
      await page.locator('#author-input').fill(author);
      await page.locator('#riddle-input').fill(riddle);
      await page.locator('#save-tablet-btn').click();
      await page.getByText(`Saved “${topic}”.`).waitFor();
    }
    await save('Moon', 'First Scribe', 'I borrow the sun and return it pale.');
    assert.equal(await page.locator('#save-toast').isVisible(), true);
    await page.locator('#save-toast:not(.visible)').waitFor();
    await page.locator('.saved-tablet-row').first().getByRole('button', { name: 'Edit' }).click();
    await page.locator('#topic-input').fill('Moonlight');
    await page.locator('#save-tablet-btn').click();
    await page.getByText('Saved changes to “Moonlight”.').waitFor();
    await save('Fire', 'Ash Keeper', 'I die when I drink.');
    await save('Echo', 'Cave Listener', Array(120).fill('you can').join(' '));
    await save('Newest', 'Layout Scribe', 'I should sit directly beneath the first tablet.');
    await save('Time', 'Last Scribe', 'I am held by none.');

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const cards = page.locator('#tablet-grid .riddle-tablet');
    assert.equal(await cards.count(), 5);
    const boxes = await Promise.all(Array.from({ length: 4 }, (_, index) => cards.nth(index).boundingBox()));
    assert.ok(boxes.every((box) => box && Math.abs(box.y - boxes[0].y) < 1));
    const fifthClosedBox = await cards.nth(4).boundingBox();
    const gridGap = await page.locator('#tablet-grid').evaluate((element) => parseFloat(getComputedStyle(element).columnGap));
    assert.ok(Math.abs(fifthClosedBox.x - boxes[0].x) < 1);
    assert.ok(Math.abs(fifthClosedBox.y - (boxes[0].y + boxes[0].height + gridGap)) < 2);
    assert.equal(await cards.first().getAttribute('aria-expanded'), 'false');
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
    assert.equal(
      await cards.first().locator('.tablet-open-prompt').evaluate((element) => getComputedStyle(element).display),
      'block'
    );
    assert.equal(await cards.first().locator('.tablet-open-prompt').textContent(), 'Mark as complete');
    assert.equal(
      await cards.first().locator('.tablet-open-prompt').evaluate((element) => getComputedStyle(element).opacity),
      '1'
    );
    assert.equal(
      await cards.first().locator('.riddle-topic').evaluate((element) => getComputedStyle(element).fontSize),
      await cards.first().locator('.riddle-text').evaluate((element) => getComputedStyle(element).fontSize)
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.riddle-tablet').first().getAttribute('aria-expanded'), 'true');
    assert.match(await page.locator('.riddle-tablet').first().locator('.riddle-text').textContent(), /held by none/i);
    await page.locator('#tablet-grid .riddle-tablet').first().locator('.tablet-toggle').click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.riddle-tablet').first().getAttribute('aria-expanded'), 'false');
    const reclosedBox = await page.locator('.riddle-tablet').first().boundingBox();
    assert.ok(reclosedBox.height < openBox.height);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').first().getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').first().locator('.riddle-text').textContent(), '');

    await page.locator('#tablet-grid .riddle-tablet').first().locator('.tablet-toggle').click();
    await page.locator('#tablet-grid .riddle-tablet').first().evaluate((element) => new Promise((resolve) => {
      const done = () => element.classList.contains('revealed') ? resolve() : requestAnimationFrame(done);
      done();
    }));
    await page.locator('#tablet-grid .riddle-tablet').first().getByRole('button', { name: 'Mark as complete' }).click();
    await page.locator('#completed-tablet-grid .riddle-tablet').waitFor();
    assert.equal(await page.locator('#tablet-grid .riddle-tablet').count(), 4);
    assert.equal(await page.locator('#completed-tablet-grid .riddle-tablet').count(), 1);
    assert.equal(await page.locator('#completed-tablet-grid .riddle-topic').textContent(), 'Time');
    assert.equal(
      await page.locator('#completed-tablet-grid .tablet-open-prompt').textContent(),
      'Return to active'
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#completed-tablet-grid .riddle-tablet').count(), 1);
    await page.locator('#completed-tablet-grid .riddle-tablet').getByRole('button', { name: 'Return to active' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#tablet-grid .riddle-tablet').length === 5);
    assert.equal(await page.locator('#completed-section').isHidden(), true);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
