/**
 * What a brand-new install actually does, on a brand-new profile.
 *
 * Every other harness in here runs against a machine that has already
 * translated something once — often deliberately, because a language pack is a
 * once-per-profile download and paying it on every run hides real timings. The
 * cost of that is a blind spot exactly where users are: the first five minutes
 * after installing from the Chrome Web Store, on a computer that has never
 * seen this extension, with no Ollama running and no language pack on disk.
 *
 * Reported rather than asserted. There is no single right answer to "is the
 * built-in translator available here" — the honest output is what Chrome said,
 * what the popup showed the user, and what pressing the button produced, so a
 * failure on somebody else's computer can be compared against a known-good
 * transcript from this one.
 *
 *   pnpm build && pnpm e2e:first-run
 *   OPENREAD_BUILD=.output/store-2.18.1 pnpm e2e:first-run   # the shipped one
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_BUILD, OPENREAD_URL.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET = process.env.OPENREAD_URL ?? 'https://en.wikipedia.org/wiki/Ollama';
const PORT = 9338;

const EXTENSION = process.env.OPENREAD_BUILD
  ? resolve(process.env.OPENREAD_BUILD)
  : fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}.`);
  process.exit(1);
}

// Never reused. The whole point is a profile that has never translated.
const profile = mkdtempSync(join(tmpdir(), 'openread-firstrun-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    // Reproduce a machine where Chrome's built-in translator is not on offer —
    // an older Chrome, an ineligible one, or one an enterprise policy has
    // turned it off on. That is what a computer this extension "does not work
    // on" most often turns out to be.
    ...(process.env.OPENREAD_CHROME_ARGS
      ? process.env.OPENREAD_CHROME_ARGS.split(' ').filter(Boolean)
      : []),
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

  console.log('\n--- the machine ---');
  line('chrome', await browser.version());
  line('platform', `${process.platform} ${process.arch}`);
  line('build under test', EXTENSION);

  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
  await sleep(2000);

  let workerTarget;
  for (let i = 0; i < 20 && !workerTarget; i++) {
    workerTarget = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!workerTarget) await sleep(500);
  }
  if (!workerTarget) throw new Error('the service worker never appeared');
  const worker = await workerTarget.worker();

  /**
   * Point the extension at an engine that cannot answer.
   *
   * `--disable-features=TranslationAPI` turned out not to reach every context
   * the same way run to run — one run had the API absent in the worker and one
   * had it absent only in the popup — so a harness that depends on it is
   * measuring Chrome's field trials. Selecting Ollama with no server running
   * fails on every block, every time, which is what a check on the failure
   * path needs.
   */
  if (process.env.OPENREAD_ENGINE) {
    await worker.evaluate(
      async (engine, baseUrl) =>
        chrome.storage.sync.set(baseUrl ? { engine, baseUrl } : { engine }),
      process.env.OPENREAD_ENGINE,
      process.env.OPENREAD_BASE_URL ?? '',
    );
  }

  console.log('\n--- what Chrome offers this extension ---');
  const capability = await worker.evaluate(async () => {
    const out = {
      version: chrome.runtime.getManifest().version,
      hasTranslator: 'Translator' in self,
      hasDetector: 'LanguageDetector' in self,
      availability: null,
      error: null,
    };
    try {
      if (out.hasTranslator) {
        out.availability = await Translator.availability({
          sourceLanguage: 'en',
          targetLanguage: 'zh-Hant',
        });
      }
    } catch (error) {
      out.error = `${error.name}: ${error.message}`;
    }
    return out;
  });
  line('extension version', capability.version);
  line('Translator API', capability.hasTranslator ? 'present' : 'ABSENT');
  line('LanguageDetector API', capability.hasDetector ? 'present' : 'ABSENT');
  line('en -> zh-Hant', capability.availability ?? '(not asked)');
  if (capability.error) line('availability threw', capability.error);

  const commands = await worker.evaluate(() => chrome.commands.getAll());
  console.log('\n--- keyboard shortcuts Chrome actually bound ---');
  for (const command of commands) {
    if (command.name === '_execute_action') continue;
    line(command.name, command.shortcut || 'UNBOUND');
  }

  console.log('\n--- what the popup tells the user ---');
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(4000);
  const shown = await popup.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
    const hidden = (id) => document.getElementById(id)?.hidden;
    return {
      engine: document.getElementById('engine')?.value,
      engineNote: text('engineNote'),
      packHidden: hidden('pack'),
      packNote: text('packNote'),
      connection: text('connection'),
      connectionHidden: document.getElementById('ollamaOnly')?.hidden,
    };
  });
  line('engine selected', shown.engine);
  line('engine note', shown.engineNote || '(none)');
  line('pack banner shown', shown.packHidden === false ? 'yes' : 'no');
  line('pack note', shown.packNote || '(none)');
  line('ollama section hidden', String(shown.connectionHidden));
  await popup.close();

  console.log('\n--- pressing translate, on a page, cold ---');
  const page = await browser.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  // A tab that was already open when the extension arrived has no content
  // script in it until it is reloaded — which is the state of every tab a user
  // had open when they installed from the Web Store. `OPENREAD_NO_RELOAD=1`
  // leaves it that way on purpose.
  if (!process.env.OPENREAD_NO_RELOAD) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await sleep(1500);

  // What the page and the worker say while this happens. A failure whose only
  // symptom is silence is exactly the one worth reading a console for.
  const noise = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      noise.push(`page ${message.type()}: ${message.text().slice(0, 160)}`);
    }
  });
  page.on('pageerror', (error) => noise.push(`page threw: ${error.message}`));

  const started = Date.now();
  // Reported rather than swallowed: "no receiver" is the exact failure a tab
  // that predates the install produces, and the popup's own handler used to
  // discard it.
  const delivery = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      return 'delivered';
    } catch (error) {
      return `rejected: ${error.message}`;
    }
  });
  line('message to the page', delivery);

  /**
   * Sampled every two seconds at first, then every fifteen.
   *
   * The badge is the only thing this extension says to a reader, and it takes
   * itself off the screen when it is done. A run that fails in three seconds
   * and clears looks identical, at a fifteen-second sample, to a run that
   * never started — and those are opposite bugs.
   */
  let sawBadge = '(never appeared)';
  let last = '';
  let settled = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(i < 60 ? 1000 : 5000);
    const state = await page.evaluate(() => ({
      badge:
        document
          .getElementById('oit-page-progress')
          ?.innerText?.replace(/\n/g, ' ') ?? '(no badge)',
      inserted: document.querySelectorAll('.oit-bilingual').length,
      failed: [...document.querySelectorAll('.oit-bilingual')].filter((node) =>
        node.innerText.includes('⚠'),
      ).length,
    }));
    const now = `${String(state.inserted)}|${String(state.failed)}|${state.badge}`;
    if (now !== last) {
      last = now;
      settled = 0;
      if (state.badge !== '(no badge)') sawBadge = state.badge;
      line(
        `t+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`,
        `${String(state.inserted - state.failed).padStart(3)} ok, ${String(state.failed).padStart(2)} failed · ${state.badge}`,
      );
    } else if (++settled >= 8 && state.inserted > 0) {
      break;
    }
  }

  const outcome = await page.evaluate(() => {
    const first = document.querySelector('.oit-bilingual');
    return {
      inserted: document.querySelectorAll('.oit-bilingual').length,
      sample: first?.innerText?.slice(0, 70) ?? '(nothing)',
      badge:
        document.getElementById('oit-page-progress')?.innerText?.replace(/\n/g, ' ') ??
        '(no badge)',
    };
  });
  console.log('\n--- outcome ---');
  line('blocks translated', outcome.inserted);
  line('first translation', outcome.sample);
  line('badge now', outcome.badge);
  line('last badge seen', sawBadge);
  if (noise.length > 0) {
    console.log('\n--- what the page complained about ---');
    for (const item of noise.slice(0, 10)) console.log(`  ${item}`);
  }
} catch (error) {
  console.error(`\nharness error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  chrome.kill();
}
