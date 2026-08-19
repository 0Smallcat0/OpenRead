/**
 * Opening a page in a language you have no pack for starts the download.
 *
 * Nothing is pressed. The reader opens an article and reads the first
 * paragraph; by the time they reach for the button the pack is on its way or
 * already there.
 *
 * The alternative — fetching all 39 target languages at install — was measured
 * and rejected: each additional language costs about 130 MB of its own
 * (`en`→`fr` +131.7 MB, `en`→`de` +133.4 MB, `en`→`ar` +127.8 MB, on a profile
 * that already held two), so the full set is roughly five gigabytes. A page
 * actually opened is the honest signal.
 *
 *   pnpm build && pnpm e2e:page-pack
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_BUILD, OPENREAD_PROFILE,
 * OPENREAD_URL. The default profile is a throwaway; the default page is a
 * Japanese one, because the install-time fetch guesses English and this is
 * about everything it cannot guess.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET =
  process.env.OPENREAD_URL ?? 'https://ja.wikipedia.org/wiki/Ollama';
const PORT = 9345;
const EXTENSION = resolve(process.env.OPENREAD_BUILD ?? '.output/chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-pagepack-'));
/** Comfortably more than the few hundred KB idle Chrome writes on its own. */
const GREW_ENOUGH = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (label, value) =>
  console.log(`${String(label).padEnd(26)} ${value}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      // A file Chrome deleted between the listing and the stat.
    }
  }
  return total;
}

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}.`);
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let grew = 0;
let declared = null;
try {
  await sleep(4000);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
    protocolTimeout: 0,
  });
  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });

  let workerTarget;
  for (let i = 0; i < 20 && !workerTarget; i++) {
    workerTarget = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!workerTarget) await sleep(500);
  }
  if (!workerTarget) throw new Error('the service worker never appeared');
  const worker = await workerTarget.worker();
  line('build', EXTENSION);
  line('profile', PROFILE);

  /**
   * The install-time fetch is a different feature and it is running right now.
   * Waiting it out is what leaves the page's own pair as the only thing that
   * could be downloading when the measurement starts.
   */
  for (let i = 0; i < 60; i++) {
    const state = await worker.evaluate(() =>
      Translator.availability({
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hant',
      }),
    );
    if (state === 'available') break;
    await sleep(5000);
  }
  line('install-time pack', 'settled');

  const baseline = dirSize(PROFILE);
  const t0 = Date.now();
  const page = await browser.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  declared = await page.evaluate(() =>
    document.documentElement.getAttribute('lang'),
  );
  line('page declares', declared ?? '(nothing)');

  for (let i = 0; i < 24; i++) {
    await sleep(10_000);
    grew = dirSize(PROFILE) - baseline;
    line(
      `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`,
      `profile +${mb(grew)}`,
    );
    if (grew > GREW_ENOUGH) break;
  }
  await browser.close().catch(() => undefined);
} catch (error) {
  console.error(`harness error: ${error.message}`);
} finally {
  chrome.kill();
}

const pass = grew > GREW_ENOUGH;
console.log(
  pass
    ? `\nPASS — ${mb(grew)} of ${declared ?? '?'} pack arrived with nothing pressed`
    : `\nFAIL — only ${mb(grew)}; opening the page started no download`,
);
process.exit(pass ? 0 : 1);
