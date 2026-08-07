/**
 * Record what Chrome's built-in translator does to the benchmark fixtures.
 *
 * Every quality number this project publishes — chrF 46.4, Simplified leakage
 * 0%, preamble 0% — was measured on the Ollama path. The default engine is
 * Chrome's on-device translator, and nothing in `eval/` mentioned it. So the
 * engine almost every user is served by was the one with no score attached,
 * and "good enough to be the default" was an assertion rather than a
 * measurement.
 *
 * It cannot be measured the way the rest of `eval/` is, because there is no
 * built-in translator in Node — it exists only inside Chrome. So this runs
 * one: a real browser, the built extension loaded, and two conditions per
 * fixture from the same browser and the same language pack.
 *
 *   raw      `Translator.translate()` called directly, which is what Chrome
 *            returns before this extension touches it.
 *   shipped  the same source driven through the extension's own
 *            `stream-translate` port — the broker the content script talks to
 *            — so it is the text a reader is actually shown.
 *
 * The difference between the two is the Taiwan vocabulary pass, and measuring
 * it was half the point: that pass was added on the strength of counting
 * substitutions in one article by hand, and has never been scored against
 * references.
 *
 * This half only records. Scoring is `report.ts`, which imports the same chrF
 * and the same detectors the model benchmark uses — browser code and scoring
 * code are separated because the first cannot be type-checked against Node's
 * lib and the second must be.
 *
 *   pnpm build && pnpm eval:builtin
 *
 * Not in CI, for the same reason the e2e harnesses are not: the first use of a
 * language pair makes Chrome fetch a model, and a runner that has to download
 * one before it can measure anything is a runner that will flake.
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_PROFILE.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9341;
const TARGET_LANG = 'Traditional Chinese';

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(here, '..', '..', '.output', 'chrome-mv3');
const RAW_PATH = join(here, '..', 'results', 'builtin-raw.json');

const fixtures = JSON.parse(
  readFileSync(join(here, '..', 'dataset', 'bench-fixtures.json'), 'utf8'),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const profile =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-eval-builtin-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const records = [];
let browser;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
    defaultViewport: null,
  });

  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
  console.log(`extension ${id}`);
  await sleep(1500);

  let workerTarget;
  for (let i = 0; i < 20 && !workerTarget; i++) {
    workerTarget = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!workerTarget) await sleep(500);
  }
  if (!workerTarget) throw new Error('the service worker never appeared');
  const worker = await workerTarget.worker();

  // Set explicitly rather than inherited from whatever profile this runs in:
  // the engine under test, and an empty glossary, since a glossary would
  // change the text before Chrome ever saw it.
  await worker.evaluate(
    async (target) =>
      chrome.storage.sync.set({
        engine: 'builtin',
        targetLang: target,
        glossary: '',
        autoTranslate: 'off',
      }),
    TARGET_LANG,
  );

  // An extension page rather than a web page: `chrome.runtime.connect` from
  // here reaches the service worker's `onConnect`, which a content script's
  // isolated world can also do but a worker cannot do to itself.
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });

  await page.evaluate((targetLang) => {
    self.__translateViaPort = (text) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'stream-translate' });
        let out = '';
        const timer = setTimeout(() => {
          port.disconnect();
          reject(new Error('timed out'));
        }, 600000);
        port.onMessage.addListener((message) => {
          if (message.status === 'streaming') out += message.chunk;
          else if (message.status === 'done') {
            clearTimeout(timer);
            port.disconnect();
            resolve(out);
          } else if (message.status === 'error') {
            clearTimeout(timer);
            port.disconnect();
            reject(new Error(message.message));
          }
        });
        port.postMessage({
          type: 'START_STREAM',
          text,
          targetLang,
          // Declared rather than detected, so a language-detector miss
          // cannot move a translation-quality score.
          sourceLang: 'en',
          model: 'unused-on-the-builtin-engine',
        });
      });
  }, TARGET_LANG);

  // The pack, once, before anything is timed. Chrome's download takes minutes
  // on a cold profile, and folding that into the first fixture would make one
  // segment look thousands of times slower than the rest.
  console.log('warming the en -> zh-Hant pack (minutes, on a cold profile)');
  const warmed = await page.evaluate(() =>
    self.__translateViaPort('Warming the language pack.'),
  );
  console.log(`  warm: ${warmed}`);

  for (const [index, fixture] of fixtures.entries()) {
    const label = `[${index + 1}/${fixtures.length}] ${fixture.id}`;
    try {
      const result = await page.evaluate(async (source) => {
        // Raw first: Chrome's own output, before this extension touches it.
        // The pack is present by now, so no user gesture is needed.
        const rawStart = performance.now();
        const translator = await Translator.create({
          sourceLanguage: 'en',
          targetLanguage: 'zh-Hant',
        });
        const raw = await translator.translate(source);
        const rawMs = performance.now() - rawStart;

        const shippedStart = performance.now();
        const shipped = await self.__translateViaPort(source);
        const shippedMs = performance.now() - shippedStart;
        return { raw, shipped, rawMs, shippedMs };
      }, fixture.source);
      records.push({ ...fixture, ...result });
      console.log(`${label}  ${result.shipped.slice(0, 44)}`);
    } catch (error) {
      records.push({
        ...fixture,
        raw: '',
        shipped: '',
        rawMs: 0,
        shippedMs: 0,
        error: error.message,
      });
      console.log(`${label}  FAILED: ${error.message}`);
    }
  }
} finally {
  if (browser) await browser.disconnect();
  chrome.kill();
}

mkdirSync(dirname(RAW_PATH), { recursive: true });
writeFileSync(RAW_PATH, JSON.stringify(records, null, 2));
console.log(`\nwrote ${RAW_PATH} (${records.length} records)`);
