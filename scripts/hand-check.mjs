/**
 * Open a browser with the built extension in it, and leave it open.
 *
 * Every harness in `e2e/` drives Chrome and then kills it, which is right for
 * a test and useless for the thing that has found more defects than all of
 * them put together: somebody using the extension with a mouse. Nine of the
 * bugs fixed in 2.18.1 were found that way and not one was caught by a
 * harness first.
 *
 * So this does the setup a hand-check needs and then gets out of the way:
 * loads the unpacked build, writes settings worth starting from, waits for the
 * language pack so the first click is not a two-minute silence, opens a tab
 * per thing worth checking, and detaches. Chrome outlives this script.
 *
 *   pnpm build && pnpm check
 *
 * The profile is kept between runs, which is deliberate and the opposite of
 * what the harnesses do: a language pack is a once-per-profile download, and
 * paying it on every hand-check is how a once-ever cost gets mistaken for a
 * per-use one. Delete `.output/hand-check-profile` to test a first run.
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_PROFILE.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9222;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const EXTENSION = join(root, '.output', 'chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ?? join(root, '.output', 'hand-check-profile');

/**
 * A tab per thing that is worth a pair of eyes, in the order they are worth
 * looking at: what no automated test has ever touched comes first.
 */
const TABS = [
  {
    url: 'https://en.wikipedia.org/wiki/Ollama',
    what: 'whole page, hover-one-paragraph (hold Alt), select-to-translate',
  },
  {
    url: 'https://www.youtube.com/watch?v=aircAruvnKk',
    what: 'subtitles — press c for captions, then try fullscreen',
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe',
    what: 'iframes — live samples are real frames with real prose in them',
  },
  {
    url: 'https://arxiv.org/pdf/1706.03762',
    what: 'a whole PDF — check the translation can be selected and copied',
  },
];

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}
mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Detached, so Chrome is still there after this script exits. Without this the
// browser dies with the process and the whole point is lost.
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
  { stdio: 'ignore', detached: true },
);
chrome.unref();

let browser;
for (let attempt = 0; attempt < 60 && !browser; attempt++) {
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
      defaultViewport: null,
    });
  } catch {
    await sleep(250);
  }
}
if (!browser) {
  console.error('Could not attach to Chrome.');
  process.exit(1);
}

const cdp = await browser.target().createCDPSession();
const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
console.log(`extension ${id}`);
await sleep(1500);

let workerTarget;
for (let attempt = 0; attempt < 20 && !workerTarget; attempt++) {
  workerTarget = browser
    .targets()
    .find((t) => t.type() === 'service_worker' && t.url().includes(id));
  if (!workerTarget) await sleep(500);
}
if (!workerTarget) {
  console.error('The service worker never appeared.');
  process.exit(1);
}
const worker = await workerTarget.worker();

// A starting point, not a preference: subtitles on because they are off by
// default and the point of this run is to look at them, automatic translation
// off so nothing happens until it is asked for, and a glossary with something
// in it so the box is not empty when it is opened.
await worker.evaluate(async () =>
  chrome.storage.sync.set({
    engine: 'builtin',
    targetLang: 'Traditional Chinese',
    inputTargetLang: 'English',
    translateSubtitles: true,
    hoverTranslate: 'alt',
    autoTranslate: 'off',
    autoTranslateExcept: [],
    displayMode: 'bilingual',
    translationStyle: 'line',
    translationScale: 'same',
    glossary: ['OpenRead', 'Ollama', 'transformer = 轉換器'].join('\n'),
  }),
);

// The pack, before the first click rather than during it. A cold profile
// otherwise answers the first press with two minutes of nothing, which is the
// bug this project has now shipped twice.
const packStart = Date.now();
const packed = await worker.evaluate(async () => {
  try {
    const translator = await Translator.create({
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hant',
    });
    return await translator.translate('Warming the language pack.');
  } catch (error) {
    return `FAILED: ${error.message}`;
  }
});
console.log(
  `pack:     ${packed} (${Math.round((Date.now() - packStart) / 1000)} s)`,
);

console.log('\ntabs:');
for (const [index, tab] of TABS.entries()) {
  const page =
    index === 0 ? (await browser.pages())[0] : await browser.newPage();
  await page
    .goto(tab.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => undefined);
  console.log(`  ${index + 1}. ${tab.what}\n     ${tab.url}`);
}
await browser
  .newPage()
  .then((page) =>
    page.goto(`chrome-extension://${id}/popup.html`).catch(() => undefined),
  );
console.log(`  5. the settings form, as a full tab
     chrome-extension://${id}/popup.html`);

console.log(`
The toolbar icon opens the same settings in the popup. Shortcuts:
  Ctrl+Shift+U  translate this page
  Ctrl+Shift+Y  translate the selection
  Ctrl+Shift+K  translate the text box you are in
Every one of them also has a right-click entry — if a shortcut does nothing
and the right-click entry works, Chrome refused to bind the key, which is not
a bug in the extension and has happened before.

Chrome is left running. Close it when you are done.`);

// Detach rather than close: `browser.close()` would take the browser with it.
await browser.disconnect();
