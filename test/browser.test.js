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

test('save, edit, compact accordion reveal, glyph flicker, and local reveal restoration work', { timeout: 60000 }, async (t) => {
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
    await save('Echo', 'Cave Listener', 'I never speak first.');
    await save('Time', 'Last Scribe', 'I am held by none.');

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.riddle-tablet');
    assert.equal(await cards.count(), 4);
    const boxes = await Promise.all(Array.from({ length: 4 }, (_, index) => cards.nth(index).boundingBox()));
    assert.ok(boxes.every((box) => box && Math.abs(box.y - boxes[0].y) < 1));
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
    await page.waitForFunction(
      () => Boolean(document.querySelector('.riddle-tablet:not(.revealed) .riddle-topic .glyph-char')),
      null,
      { timeout: 8500 }
    );
    await cards.first().click();
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
    await cards.first().locator('.tablet-open-prompt').evaluate((element) => new Promise((resolve) => {
      const settled = () => parseFloat(getComputedStyle(element).maxHeight) < 0.5
        ? resolve()
        : requestAnimationFrame(settled);
      settled();
    }));
    assert.ok(
      parseFloat(await cards.first().locator('.tablet-open-prompt').evaluate((element) => getComputedStyle(element).maxHeight)) < 0.5
    );
    assert.equal(
      await cards.first().locator('.tablet-open-prompt').evaluate((element) => getComputedStyle(element).opacity),
      '0'
    );
    assert.equal(
      await cards.first().locator('.riddle-topic').evaluate((element) => getComputedStyle(element).fontSize),
      await cards.first().locator('.riddle-text').evaluate((element) => getComputedStyle(element).fontSize)
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.riddle-tablet').first().getAttribute('aria-expanded'), 'true');
    assert.match(await page.locator('.riddle-tablet').first().locator('.riddle-text').textContent(), /held by none/i);
    await page.locator('.riddle-tablet').first().click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.riddle-tablet').first().getAttribute('aria-expanded'), 'false');
    const reclosedBox = await page.locator('.riddle-tablet').first().boundingBox();
    assert.ok(reclosedBox.height < openBox.height);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.riddle-tablet').first().getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.riddle-tablet').first().locator('.riddle-text').textContent(), '');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
