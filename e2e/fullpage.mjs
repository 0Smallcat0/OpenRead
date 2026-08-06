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
 *   7. a long page translates what the reader can see, not all of it
 *   8. scrolling and later-loading content are picked up with no second press
 *   9. the appearance settings reach the page, and switching one restyles a
 *      page that is already translated without translating it again
 *  10. holding a key and pointing at a paragraph translates that paragraph
 *  11. a text box is translated in place, and Ctrl+Z still takes it back
 *  12. a PDF is translated page by page in the bundled viewer, and undone
 *
 * The last two cannot be tested anywhere else. jsdom lays nothing out, so every
 * block sits at 0,0 and "near the viewport" is true of all of them, and it has
 * no IntersectionObserver at all.
 *
 * Requires a Chrome on disk, and a local Ollama with the model pulled if
 * `OPENREAD_ENGINE=ollama`. Not in CI: GitHub's runners have no GPU and no
 * model, and a translation harness that stubs the model is measuring the stub.
 *
 *   pnpm build
 *   pnpm e2e:page
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_MODEL, OPENREAD_URL,
 * OPENREAD_ENGINE, OPENREAD_PROFILE.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODEL = process.env.OPENREAD_MODEL ?? 'qwen3:latest';
const ENGINE = process.env.OPENREAD_ENGINE ?? 'builtin';
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

/**
 * A throwaway profile by default, so a run cannot pass on state a previous one
 * left behind.
 *
 * The cost is that Chrome's translation language pack reports "downloadable"
 * in a profile that has never seen it, and registering it again takes 30-130 s
 * at the front of every run — which is also how a once-ever setup cost got
 * mistaken for a per-use one and sent a whole performance investigation down
 * the wrong road. `OPENREAD_PROFILE` reuses a directory when iterating, and is
 * closer to what a real user has.
 */
const profile =
  process.env.OPENREAD_PROFILE ?? mkdtempSync(join(tmpdir(), 'openread-e2e-'));
mkdirSync(profile, { recursive: true });
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
    async (model, engine) =>
      chrome.storage.sync.set({
        engine,
        baseUrl: 'http://localhost:11434',
        modelId: model,
        targetLang: 'Traditional Chinese',
      }),
    MODEL,
    ENGINE,
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

  // ---- a page longer than a screen ----
  //
  // Built in place rather than fetched, so the assertions below are about the
  // extension rather than about whatever Wikipedia shipped this week. The tab
  // keeps its origin and its already-injected content script.
  const TALL_BLOCKS = 60;
  await page.evaluate((count) => {
    const main = document.createElement('main');
    for (let i = 0; i < count; i++) {
      const p = document.createElement('p');
      p.id = `tall-${String(i)}`;
      p.style.minHeight = '200px';
      p.textContent = `Paragraph number ${String(i)} of a long article, written out at enough length to be worth translating.`;
      main.appendChild(p);
    }
    document.body.replaceChildren(main);
    window.scrollTo(0, 0);
  }, TALL_BLOCKS);
  await sleep(600);

  console.log(`\nmessage: ${await translatePage()}`);

  /**
   * Poll until the page shows a specific change, or give up loudly.
   *
   * Deliberately not "wait until the count stops moving": that version passed
   * and failed on the same code depending on whether a batch happened to land
   * inside its window, which is worse than either verdict on its own.
   */
  const waitUntil = async (label, wanted, timeoutMs = 30000) => {
    const read = () =>
      page.evaluate(() => ({
        total: document.querySelectorAll('.oit-bilingual').length,
        first: Boolean(document.querySelector('#tall-0 .oit-bilingual')),
        last: Boolean(document.querySelector('#tall-59 .oit-bilingual')),
        badge:
          document.getElementById('oit-page-progress')?.textContent ?? null,
      }));
    let state = await read();
    for (let waited = 0; waited < timeoutMs && !wanted(state); waited += 500) {
      await sleep(500);
      state = await read();
    }
    console.log(
      `  ${label}: ${state.total}/${TALL_BLOCKS} translated` +
        `  (first ${state.first ? 'yes' : 'no'}, last ${state.last ? 'yes' : 'no'})`,
    );
    return state;
  };

  console.log('\n--- a page longer than a screen ---');
  // Settled, not merely started: the badge stops saying "Translating" only when
  // this batch has drained, and the whole claim is about what it left alone.
  const visible = await waitUntil(
    'after the press',
    (s) => s.total > 0 && !s.badge?.startsWith('Translating'),
  );

  check(visible.total > 0, 'a long page translated nothing at all');
  check(
    visible.total < TALL_BLOCKS,
    `all ${String(TALL_BLOCKS)} blocks were translated — the reader can see about six, and the rest is their battery`,
  );
  check(visible.first, 'the block at the top of the page was not translated');
  check(
    !visible.last,
    'the block at the very bottom was translated before the reader got near it',
  );

  // Scrolling is the whole point: no second press, no keyboard shortcut.
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  const scrolled = await waitUntil(
    'after scrolling to the bottom',
    (s) => s.last && s.total > visible.total,
  );

  check(
    scrolled.total > visible.total,
    'scrolling to the bottom translated nothing new',
  );
  check(scrolled.last, 'the block scrolled to was still not translated');

  // And content that arrives after the fact, which is most of an infinite feed.
  await page.evaluate(() => {
    const fresh = document.createElement('p');
    fresh.id = 'appended';
    fresh.textContent =
      'A paragraph the feed appended long after the first pass, which nobody pressed anything for.';
    document.querySelector('main')?.appendChild(fresh);
    fresh.scrollIntoView();
  });
  let appended = false;
  for (let waited = 0; waited < 30000 && !appended; waited += 500) {
    await sleep(500);
    appended = await page.evaluate(() =>
      Boolean(document.querySelector('#appended .oit-bilingual')),
    );
  }
  console.log(`  appended paragraph translated: ${appended ? 'yes' : 'no'}`);
  check(appended, 'content added after the run was never translated');

  // ---- translating without being asked ----
  //
  // Nothing below sends a message. The only thing that can produce a
  // translation here is the content script deciding for itself on load, which
  // is a path no unit test reaches: it starts at `chrome.storage`, runs in a
  // content script, and is triggered by a navigation.
  console.log('\n--- without being asked ---');

  const configure = (values) =>
    worker.evaluate(
      async (settings) => chrome.storage.sync.set(settings),
      values,
    );

  /**
   * Reload, then watch for up to `waitMs`.
   *
   * The badge is watched as well as the translations, because it is the only
   * evidence that separates "decided not to translate" from "decided to, and
   * found nothing worth translating" — which is exactly the difference between
   * the two modes. It removes itself a couple of seconds after finishing, so
   * it has to be caught rather than read at the end.
   */
  const afterReload = async (label, waitMs = 20000) => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    let count = 0;
    let badged = false;
    for (let waited = 0; waited < waitMs; waited += 400) {
      await sleep(400);
      const seen = await page.evaluate(() => ({
        count: document.querySelectorAll('.oit-bilingual').length,
        badge: Boolean(document.getElementById('oit-page-progress')),
      }));
      count = seen.count;
      badged ||= seen.badge;
      if (count > 0) break;
    }
    console.log(
      `  ${label}: ${count} translated, badge ${badged ? 'shown' : 'never'}`,
    );
    return { count, badged };
  };

  await configure({
    autoTranslate: 'foreign',
    targetLang: 'Traditional Chinese',
    autoTranslateExcept: [],
  });
  const auto = await afterReload('a foreign page, auto on');
  check(auto.count > 0, 'auto-translate was on and the page was left in English');

  // The failure that matters most: rewriting a page the reader can already
  // read. example.com declares `lang="en"`, so asking for English must be a
  // no-op — and not a quiet one either, since nothing should have started.
  await configure({ targetLang: 'English' });
  const same = await afterReload('a page already in the target', 6000);
  check(same.count === 0, 'an English page was auto-translated into English');
  check(!same.badged, 'auto-translate started a run it should have skipped');

  // `always` is the same page, the same target, one setting apart. It has to
  // reach the engine and find nothing to do, or the two modes are the same
  // mode with different labels.
  await configure({ autoTranslate: 'always' });
  const always = await afterReload('the same page on `always`', 10000);
  check(
    always.badged,
    '`always` behaved like `foreign` and never started a run',
  );

  await configure({
    autoTranslate: 'foreign',
    targetLang: 'Traditional Chinese',
    autoTranslateExcept: ['example.com'],
  });
  const excluded = await afterReload('an excluded host', 6000);
  check(
    excluded.count === 0,
    'the per-site exception did not stop auto-translation',
  );
  check(!excluded.badged, 'the excluded host still started a run');

  // ---- the language pack, said before it is needed ----
  //
  // The longest wait in the product — 30 s to two minutes, once per language
  // pair per profile — and until now it was only ever met as an unexplained
  // pause after a first press.
  console.log('\n--- the language pack ---');
  const popup = await browser.newPage();
  // The popup is the one surface here with no visible failure mode: a throw in
  // its controller leaves every control inert and says nothing.
  popup.on('pageerror', (error) => {
    console.log(`  popup error: ${error.message}`);
  });
  popup.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`  popup ${message.type()}: ${message.text()}`);
    }
  });
  await popup.goto(`chrome-extension://${id}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  // The popup asks the *active* tab what language it is in, so the page has to
  // be the active one — otherwise this would only ever exercise the fallback.
  await page.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const packState = () =>
    popup.evaluate(() => ({
      hidden: document.getElementById('pack')?.hasAttribute('hidden') ?? true,
      note: document.getElementById('packNote')?.textContent ?? '',
      offered: !(
        document.getElementById('downloadPack')?.hasAttribute('hidden') ?? true
      ),
    }));

  // The popup is one document and one controller, wired by matching ids. A
  // rename on either side leaves `collect()` returning null and the whole popup
  // inert — no options in the dropdowns, no listeners, and nothing said about
  // it. Filling the language list is the cheapest proof the controller ran.
  const mounted = await popup.evaluate(() => ({
    languages: document.getElementById('targetLang')?.children.length ?? 0,
    inputLanguages:
      document.getElementById('inputTargetLang')?.children.length ?? 0,
    controls: [
      'engine',
      'targetLang',
      'inputTargetLang',
      'displayMode',
      'translationStyle',
      'translationScale',
      'hoverTranslate',
      'autoTranslate',
      'obsidianVault',
      'obsidianFolder',
    ].filter((id) => !document.getElementById(id)),
  }));
  console.log(`  popup mounted: ${JSON.stringify(mounted)}`);
  check(
    mounted.controls.length === 0,
    `the popup is missing controls: ${mounted.controls.join(', ')}`,
  );
  check(
    mounted.languages > 30 && mounted.inputLanguages > 30,
    'the popup did not fill its language lists, so the controller never ran',
  );

  const first = await packState();
  console.log(`  on open: ${JSON.stringify(first)}`);
  check(!first.hidden, 'the popup said nothing about the language pack');
  check(
    first.note.includes('en → zh-Hant'),
    `the pack line did not name the pair it will use (${first.note})`,
  );

  // A different target is a different pair, and that is the common way to meet
  // a download at all.
  await popup.evaluate(() => {
    const select = document.getElementById('targetLang');
    select.value = 'Japanese';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1500);
  const switched = await packState();
  console.log(`  after switching to Japanese: ${JSON.stringify(switched)}`);
  check(
    switched.note.includes('en → ja'),
    `switching target language did not re-ask (${switched.note})`,
  );

  // Whichever state this profile is in, the end state is the same: ready. On a
  // fresh profile that means clicking through a real download.
  if (switched.offered) {
    // A real gesture, not `element.click()`. Chrome gates starting a language
    // pack download on user activation, and a synthetic click carries none —
    // measured here, the create promise then simply never settles rather than
    // rejecting, which reads as a seven-minute download that never finishes.
    // Fronted first. The page had to be the active tab while the popup asked it
    // what language it is in, but a real user pressing Download is looking at
    // the popup — and a background tab is throttled, which is what a download
    // that sits at nothing for seven minutes looks like.
    await popup.bringToFront();
    const popupCdp = await popup.createCDPSession();
    await popupCdp.send('Runtime.evaluate', {
      expression: `document.getElementById('downloadPack').click()`,
      userGesture: true,
    });
    // Generous, and it says how long it took. A fresh profile fetches two packs
    // in one run — the target language, then whatever this phase switches to —
    // and a single one was measured at 81 s on a fast connection. A harness
    // that goes red on a slow network is one nobody reads the output of twice.
    let note = '';
    let waited = 0;
    for (; waited < 420000; waited += 2000) {
      await sleep(2000);
      note = (await packState()).note;
      if (note.startsWith('Ready') || note.startsWith('Could not')) break;
      if (waited % 30000 === 0) console.log(`    ${String(waited / 1000)}s: ${note}`);
    }
    console.log(`  after downloading (${String(Math.round(waited / 1000))} s): ${note}`);
    check(note.startsWith('Ready'), `the download did not finish (${note})`);
    // Hand the page back. Everything after this addresses "the active tab", and
    // leaving the popup in front sends those messages to a document with no
    // content script — "Receiving end does not exist", from a phase that has
    // nothing to do with popups.
    await page.bringToFront();
  } else {
    check(
      switched.note.startsWith('Ready'),
      `neither ready nor offered (${switched.note})`,
    );
  }

  // ---- how it looks ----
  //
  // jsdom has no cascade, so "the original is hidden" and "the translation is
  // larger" are claims only a real browser can settle.
  console.log('\n--- appearance ---');
  await configure({
    autoTranslate: 'off',
    targetLang: 'Traditional Chinese',
    displayMode: 'translationOnly',
    translationStyle: 'highlight',
    translationScale: 'large',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await translatePage();
  for (let waited = 0; waited < 20000; waited += 500) {
    await sleep(500);
    const n = await page.evaluate(
      () => document.querySelectorAll('.oit-bilingual').length,
    );
    if (n > 0) break;
  }

  const styled = await page.evaluate(() => {
    const original = document.querySelector('.oit-original');
    const translated = document.querySelector('.oit-bilingual');
    if (!original || !translated) return null;
    const block = translated.parentElement;
    return {
      originalDisplay: getComputedStyle(original).display,
      translationSize: parseFloat(getComputedStyle(translated).fontSize),
      blockSize: parseFloat(getComputedStyle(block).fontSize),
      background: getComputedStyle(translated).backgroundColor,
      text: translated.textContent ?? '',
    };
  });
  console.log(`  translation-only + highlight + large: ${JSON.stringify(styled)}`);

  check(styled !== null, 'nothing was translated, so nothing could be styled');
  check(
    styled?.originalDisplay === 'none',
    `translation-only left the original showing (display: ${String(styled?.originalDisplay)})`,
  );
  check(
    (styled?.translationSize ?? 0) > (styled?.blockSize ?? 0),
    'the "larger" size setting did not reach the page',
  );
  check(
    styled?.background !== undefined &&
      styled.background !== 'rgba(0, 0, 0, 0)' &&
      styled.background !== 'transparent',
    `the "tinted background" style did not reach the page (${String(styled?.background)})`,
  );

  // Switching back must restyle what is already there rather than re-run.
  const beforeSwitch = await page.evaluate(
    () => document.querySelectorAll('.oit-bilingual').length,
  );
  await configure({ displayMode: 'bilingual' });
  await sleep(2500);
  const restyled = await page.evaluate(() => ({
    originals: document.querySelectorAll('.oit-original').length,
    translations: document.querySelectorAll('.oit-bilingual').length,
    firstVisible: document.querySelector('main p, p')?.textContent ?? '',
  }));
  console.log(`  after switching back to bilingual: ${JSON.stringify(restyled)}`);

  check(
    restyled.originals === 0,
    'switching back to bilingual left the original wrapped and hidden',
  );
  check(
    restyled.translations === beforeSwitch,
    'switching the display mode re-translated the page instead of restyling it',
  );


  // ---- one paragraph, by pointing at it ----
  //
  // jsdom has no hit testing, so `elementFromPoint` is a stub there and the
  // gesture is only ever exercised for real here.
  console.log('\n--- pointing at a paragraph ---');
  await configure({ displayMode: 'bilingual', hoverTranslate: 'alt' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.evaluate(() => {
    const main = document.createElement('main');
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('p');
      el.id = `point-${String(i)}`;
      el.style.minHeight = '80px';
      el.textContent = `Paragraph number ${String(i)} of a page nobody asked to have translated whole.`;
      main.appendChild(el);
    }
    document.body.replaceChildren(main);
  });
  await sleep(400);

  const box = await page.evaluate(() => {
    const el = document.getElementById('point-1');
    const rect = el?.getBoundingClientRect();
    return rect ? { x: rect.x + 20, y: rect.y + 10 } : null;
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x, box.y);
  await page.keyboard.up('Alt');

  let pointed = null;
  for (let waited = 0; waited < 20000; waited += 500) {
    await sleep(500);
    pointed = await page.evaluate(() => ({
      one: Boolean(document.querySelector('#point-1 .oit-bilingual')),
      total: document.querySelectorAll('.oit-bilingual').length,
    }));
    if (pointed.one) break;
  }
  console.log(`  after Alt + point at paragraph 1: ${JSON.stringify(pointed)}`);
  check(pointed?.one === true, 'holding Alt and pointing at a paragraph did not translate it');
  check(
    pointed?.total === 1,
    `pointing at one paragraph translated ${String(pointed?.total)} of them`,
  );


  // ---- the box you are typing in ----
  //
  // jsdom implements neither `execCommand` nor an undo stack, so the reason it
  // is used rather than assigning `value` — the page learns the field changed,
  // and Ctrl+Z can take the translation back — is only testable here.
  console.log('\n--- the box you are typing in ---');
  await configure({ inputTargetLang: 'English', targetLang: 'Traditional Chinese' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const typed = '這是一段用中文寫的留言，需要翻成英文再送出。';
  await page.evaluate((text) => {
    const box = document.createElement('textarea');
    box.id = 'compose';
    box.style.width = '400px';
    box.style.height = '80px';
    document.body.replaceChildren(box);
    box.focus();
    // Typed rather than assigned, so the undo stack has something in it to
    // return to — which is the whole property being measured.
    document.execCommand('insertText', false, text);
  }, typed);
  await sleep(300);

  const beforeInput = await page.evaluate(
    () => document.getElementById('compose').value,
  );
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined)
      await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_INPUT' });
  });

  let boxed = beforeInput;
  for (let waited = 0; waited < 25000; waited += 500) {
    await sleep(500);
    boxed = await page.evaluate(
      () => document.getElementById('compose').value,
    );
    if (boxed !== beforeInput) break;
  }
  console.log(`  typed:      ${beforeInput}`);
  console.log(`  translated: ${boxed}`);
  check(boxed !== beforeInput, 'the text box was never translated');
  check(
    /[A-Za-z]{3,}/.test(boxed),
    `what came back does not look like English (${boxed})`,
  );

  // The point of `execCommand` over assigning `value`.
  await page.focus('#compose');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  await sleep(600);
  const undone = await page.evaluate(
    () => document.getElementById('compose').value,
  );
  console.log(`  after Ctrl+Z: ${undone}`);
  check(
    undone === beforeInput,
    'Ctrl+Z did not take the translation back, so the undo stack was wiped',
  );


  // ---- the bundled PDF viewer ----
  //
  // The viewer's own sample paper: two columns, fourteen pages, and a text
  // layer the viewer only builds for the pages it has drawn.
  console.log('\n--- the bundled PDF viewer ---');
  const pdf = await browser.newPage();
  await pdf.setViewport({ width: 1200, height: 900 });
  const sample = `chrome-extension://${id}/pdfjs/web/compressed.tracemonkey-pldi-09.pdf`;
  await pdf.goto(
    `chrome-extension://${id}/pdfjs/web/viewer.html?file=${encodeURIComponent(sample)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await pdf.bringToFront();
  await sleep(7000);

  const askPdf = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined)
        await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
    });

  const pdfState = () =>
    pdf.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll('.oit-pdf-translation'));
      return {
        pages: blocks.length,
        paragraphs: blocks.reduce((n, b) => n + b.children.length, 0),
        badge: document.getElementById('oit-page-progress')?.textContent ?? '',
        sample: (blocks[0]?.textContent ?? '').slice(0, 40),
        // Placed after the page, not inside it — which is the whole design.
        placedAfterPage: blocks.every(
          (b) => b.previousElementSibling?.classList.contains('page') === true,
        ),
      };
    });

  await askPdf();
  let pdfDone = await pdfState();
  for (let waited = 0; waited < 120000; waited += 2000) {
    await sleep(2000);
    pdfDone = await pdfState();
    if (pdfDone.badge.startsWith('Done') || pdfDone.badge.startsWith('Nothing')) break;
  }
  console.log(`  translated: ${JSON.stringify(pdfDone)}`);

  check(pdfDone.pages > 0, 'the PDF viewer translated no pages');
  check(
    pdfDone.paragraphs > 5,
    `only ${String(pdfDone.paragraphs)} paragraphs came out of a two-column paper`,
  );
  check(
    pdfDone.placedAfterPage,
    'a translation landed somewhere other than after its page',
  );
  check(
    /[一-鿿]/.test(pdfDone.sample),
    `what came back is not in the target language (${pdfDone.sample})`,
  );

  // The same control, the same second meaning it has everywhere else.
  await askPdf();
  await sleep(2000);
  const pdfCleared = await pdfState();
  console.log(`  after undo: ${JSON.stringify({ pages: pdfCleared.pages })}`);
  check(pdfCleared.pages === 0, 'pressing again did not put the document back');
  await pdf.close();
  await page.bringToFront();

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
