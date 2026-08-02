/**
 * Whole-page translation, verified in a real browser against a real model.
 *
 * Every unit test in this repository runs in jsdom, which cannot tell you
 * whether an extension loads, whether a content script is injected, or whether
 * the service worker is awake when a message arrives. Three shipped defects
 * (2.2.11, 2.2.12, 2.2.13) were invisible until the built extension was loaded
 * into Chrome, and the script that did that loading used to live in a scratch
 * directory and get thrown away — so the README claimed a harness the
 * repository did not contain. This is that harness, kept.
 *
 * What it asserts, end to end:
 *   1. the built extension loads and injects into a live page
 *   2. the popup's message actually reaches the content script
 *   3. blocks are translated by the real local model, not a stub
 *   4. the original text survives (bilingual, not replacement)
 *   5. short chrome is skipped rather than burning a round trip
 *   6. toggling again restores the page byte for byte
 *
 * Requires a local Ollama with the model pulled, and a Chrome on disk. Not in
 * CI: GitHub's runners have no GPU and no model, and a translation harness that
 * stubs the model is measuring the stub.
 *
 *   pnpm build
 *   OLLAMA_ORIGINS='chrome-extension://*' ollama serve
 *   pnpm e2e:page
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_MODEL, OPENREAD_URL.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODEL = process.env.OPENREAD_MODEL ?? 'qwen3:latest';
const TARGET = process.env.OPENREAD_URL ?? 'https://example.com/';
const PORT = 9333;

const EXTENSION = fileURLToPath(
  new URL('../.output/chrome-mv3', import.meta.url),
);

/**
 * A fragment example.com has carried for years, used to prove the original
 * survived. Deliberately not the whole sentence: the page's wording has
 * changed once already, and an over-specific assertion fails as a product bug
 * when it is really a copy edit upstream.
 */
const ORIGINAL_MARKER = 'This domain is for use in';

/** Below `MIN_BLOCK_CHARS`, so it must be skipped rather than translated. */
const SKIPPED_CHROME = 'Learn more';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'openread-e2e-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    // Chrome 150+ ignores --load-extension; the extension goes in over CDP,
    // and this flag is what permits that.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browser;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });

  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
  console.log(`extension ${id}`);
  await sleep(1500);

  // The service worker is the extension's own context: settings are written
  // there, and the popup's message is sent from there, so this drives exactly
  // the path the toolbar button drives.
  let workerTarget;
  for (let i = 0; i < 20 && !workerTarget; i++) {
    workerTarget = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!workerTarget) await sleep(500);
  }
  if (!workerTarget) throw new Error('the service worker never appeared');
  const worker = await workerTarget.worker();

  await worker.evaluate(
    async (model) =>
      chrome.storage.sync.set({
        baseUrl: 'http://localhost:11434',
        modelId: model,
        targetLang: 'Traditional Chinese',
      }),
    MODEL,
  );

  const page = await browser.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  // A tab that existed before the extension loaded has no content script. A
  // reload is what puts it there.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);

  const before = await page.evaluate(() => document.body.innerText);

  const translatePage = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return 'no active tab';
      await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      return 'sent';
    });

  console.log(`message: ${await translatePage()}`);

  let state = null;
  for (let i = 0; i < 90; i++) {
    state = await page.evaluate(
      (marker, chromeText) => ({
        badge:
          document.getElementById('oit-page-progress')?.textContent ?? null,
        nodes: Array.from(document.querySelectorAll('.oit-bilingual')).map(
          (node) => node.textContent,
        ),
        failed: document.querySelectorAll('.oit-bilingual[data-oit-failed]')
          .length,
        originalIntact: document.body.innerText.includes(marker),
        chromeUntouched: Array.from(document.querySelectorAll('p')).some(
          (p) =>
            p.textContent?.trim() === chromeText &&
            !p.hasAttribute('data-oit-translated'),
        ),
      }),
      ORIGINAL_MARKER,
      SKIPPED_CHROME,
    );
    if (state.badge?.startsWith('Done') || state.badge?.startsWith('Nothing')) {
      break;
    }
    await sleep(2000);
  }

  console.log('\n--- translated ---');
  console.log(`badge:    ${state.badge}`);
  console.log(`inserted: ${state.nodes.length}   failed: ${state.failed}`);
  for (const node of state.nodes) console.log(`  > ${node}`);

  check(state.nodes.length > 0, 'no translations were inserted');
  check(state.failed === 0, `${state.failed} block(s) reported a failure`);
  check(state.originalIntact, 'the original text did not survive');
  check(
    state.chromeUntouched,
    `"${SKIPPED_CHROME}" is under the length floor and should have been skipped`,
  );
  check(
    state.badge?.startsWith('Done'),
    `the run never finished (badge: ${state.badge})`,
  );

  await translatePage();
  await sleep(1200);

  const after = await page.evaluate(() => ({
    remaining: document.querySelectorAll('.oit-bilingual').length,
    marked: document.querySelectorAll('[data-oit-translated]').length,
    text: document.body.innerText,
  }));

  console.log('\n--- after undo ---');
  console.log(`remaining: ${after.remaining}   markers: ${after.marked}`);

  check(after.remaining === 0, 'undo left translations on the page');
  check(after.marked === 0, 'undo left translation markers behind');
  check(
    after.text.trim() === before.trim(),
    'undo did not restore the original page text',
  );
} catch (error) {
  failures.push(error?.message ?? String(error));
} finally {
  await browser?.disconnect();
  chrome.kill();
}

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS');
