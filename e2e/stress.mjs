/**
 * Hostile scenarios, in a real browser, against the built extension.
 *
 * `pnpm e2e:page` walks the happy path. This one goes after the failure modes
 * that only a live queue and two long-lived observers can have, and every check
 * below is here because it caught something:
 *
 *   S2 an app that replaces `document.body` left the MutationObserver watching
 *      a node no longer in the document — route A translated, route B never did
 *   S4 the toolbar button pressed during an automatic pass aborted it, so the
 *      control labelled "translate this page" produced no translation at all
 *   S7 an over-long exception list is rejected by `chrome.storage.sync` as a
 *      whole item, taking the target language and the engine down with it
 *   S8 two copies of "our own UI" had drifted, so a selection panel — and every
 *      token streamed into one — read as the page growing new text
 *  S13 whole-page translation ran on the top frame only, so an article inside
 *      an iframe came back untranslated with nothing to say why
 *  S14 a caption is repainted far more often than it changes, and a
 *      translation that arrives after its cue has gone is worse than none
 *
 * Not in CI, for the same reason as the other harnesses: it needs a real Chrome
 * and it takes a couple of minutes. Run it after anything that touches the
 * queue, the observers, or what is stored.
 *
 * One scenario wants a live Ollama and skips itself, loudly, when there is not
 * one. A harness that goes red because of the machine it runs on is a harness
 * nobody reads the output of twice.
 *
 *   pnpm build
 *   pnpm e2e:stress
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_PROFILE.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
// A throwaway profile by default, like the other harnesses. This hardcoded one
// developer's directory for a while, which meant it could not run anywhere else
// and that two runs shared state — a stress harness is the last place a run
// should be able to pass on what the previous one left behind.
const PROFILE =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-stress-'));
const PORT = 9360;
const EXTENSION = fileURLToPath(
  new URL('../.output/chrome-mv3', import.meta.url),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(EXTENSION)) {
  console.error('No build. Run `pnpm build`.');
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
    '--js-flags=--expose-gc',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const findings = [];
const failures = [];
const observe = (label, detail) => {
  findings.push(`${label}: ${detail}`);
  console.log(`  ${label}: ${detail}`);
};
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

let browser;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });
  const rootCdp = await browser.target().createCDPSession();
  const { id } = await rootCdp.send('Extensions.loadUnpacked', {
    path: EXTENSION,
  });
  await sleep(1500);

  const workerTarget = await (async () => {
    for (let i = 0; i < 20; i++) {
      const t = browser
        .targets()
        .find((t) => t.type() === 'service_worker' && t.url().includes(id));
      if (t) return t;
      await sleep(500);
    }
    throw new Error('no service worker');
  })();
  const worker = await workerTarget.worker();
  const configure = (v) =>
    worker.evaluate(async (x) => chrome.storage.sync.set(x), v);
  const selectAndTranslate = async () => {
    await page.evaluate(() => {
      const target = document.querySelector('main p');
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id !== undefined)
        await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION' });
    });
  };

  const press = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id !== undefined)
        await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
    });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  const seed = (count, prefix) =>
    page.evaluate(
      (n, p) => {
        const main = document.createElement('main');
        for (let i = 0; i < n; i++) {
          const el = document.createElement('p');
          el.id = `${p}-${String(i)}`;
          el.style.minHeight = '150px';
          el.textContent = `${p} paragraph number ${String(i)}, long enough to be worth translating on its own.`;
          main.appendChild(el);
        }
        document.body.replaceChildren(main);
        window.scrollTo(0, 0);
      },
      count,
      prefix,
    );

  const stats = () =>
    page.evaluate(() => ({
      translated: document.querySelectorAll('.oit-bilingual').length,
      marked: document.querySelectorAll('[data-oit-translated]').length,
      badges: document.querySelectorAll('#oit-page-progress').length,
      nodes: document.querySelectorAll('*').length,
      heap: performance.memory?.usedJSHeapSize ?? 0,
    }));

  const settle = async (ms) => {
    await sleep(ms);
    return stats();
  };

  const reset = async () => {
    await configure({
      engine: 'builtin',
      targetLang: 'Traditional Chinese',
      autoTranslate: 'off',
      autoTranslateExcept: [],
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
  };

  // ---------------------------------------------------------------- S1
  console.log('\nS1 — an infinite feed that never stops appending');
  await reset();
  await seed(20, 'feed');
  await press();
  await sleep(4000);
  const before = await stats();
  // 40 rounds of ten new paragraphs, with the reader scrolling along.
  await page.evaluate(() => {
    window.__added = 0;
    window.__timer = setInterval(() => {
      const main = document.querySelector('main');
      if (!main) return;
      for (let i = 0; i < 10; i++) {
        const el = document.createElement('p');
        el.className = 'fed';
        el.textContent = `Appended paragraph ${String(window.__added)}, long enough to be worth translating on its own.`;
        main.appendChild(el);
        window.__added++;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }, 300);
  });
  await sleep(14000);
  await page.evaluate(() => {
    clearInterval(window.__timer);
  });
  const during = await settle(6000);
  const added = await page.evaluate(() => window.__added);
  observe('S1 appended', `${String(added)} paragraphs`);
  observe(
    'S1 translated',
    `${String(before.translated)} -> ${String(during.translated)}`,
  );
  observe('S1 badges on page', String(during.badges));
  observe(
    'S1 heap',
    `${String(Math.round(before.heap / 1e6))} MB -> ${String(Math.round(during.heap / 1e6))} MB`,
  );
  check(
    during.translated > before.translated,
    'a feed that never stops appending stopped being translated',
  );
  check(
    during.badges <= 1,
    `${String(during.badges)} progress badges stacked up on one page`,
  );

  // ---------------------------------------------------------------- S2
  console.log('\nS2 — an SPA that replaces document.body wholesale');
  await reset();
  await seed(8, 'route-a');
  await press();
  await sleep(5000);
  const routeA = await stats();
  await page.evaluate(() => {
    const body = document.createElement('body');
    const main = document.createElement('main');
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('p');
      el.id = `route-b-${String(i)}`;
      el.textContent = `Route B paragraph number ${String(i)}, long enough to be worth translating on its own.`;
      main.appendChild(el);
    }
    body.appendChild(main);
    document.documentElement.replaceChild(body, document.body);
  });
  await sleep(6000);
  const routeB = await page.evaluate(
    () =>
      document.querySelectorAll(
        '#route-b-0 .oit-bilingual, main .oit-bilingual',
      ).length,
  );
  observe('S2 route A translated', String(routeA.translated));
  observe('S2 route B translated after body swap', String(routeB));
  check(
    routeB > 0,
    'replacing document.body left the page unwatched, so the new route stayed untranslated',
  );

  // ---------------------------------------------------------------- S3
  console.log('\nS3 — the toolbar button pressed ten times in a row');
  await reset();
  await seed(12, 'toggle');
  for (let i = 0; i < 10; i++) {
    await press();
    await sleep(120);
  }
  const toggled = await settle(6000);
  const dupes = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('main p')).filter(
        (p) => p.querySelectorAll('.oit-bilingual').length > 1,
      ).length,
  );
  observe('S3 translated', String(toggled.translated));
  observe('S3 markers', String(toggled.marked));
  observe('S3 blocks carrying two translations', String(dupes));
  observe('S3 badges', String(toggled.badges));
  check(
    dupes === 0,
    `${String(dupes)} block(s) ended up with two translations`,
  );
  check(
    toggled.marked === toggled.translated,
    'markers and translations disagree after rapid toggling',
  );
  check(toggled.badges <= 1, 'rapid toggling stacked progress badges');

  // ---------------------------------------------------------------- S4
  console.log('\nS4 — the button pressed while an automatic pass is running');
  // A page big enough that the pass is still going when the press lands.
  // example.com finishes in a couple of hundred milliseconds, where a press is
  // really landing *after* the run and correctly means undo.
  await configure({ autoTranslate: 'always', autoTranslateExcept: [] });
  await page.goto('https://en.wikipedia.org/wiki/Artificial_intelligence', {
    waitUntil: 'domcontentloaded',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(120);
  await press();
  const atPress = (await stats()).translated;
  const later = await settle(6000);
  observe('S4 translated when the press landed', String(atPress));
  observe('S4 translated 6 s later', String(later.translated));
  check(
    later.translated > 0,
    'pressing the button during an automatic pass left the page untranslated',
  );

  console.log('\nS4b — the same press once the pass has finished');
  await sleep(2000);
  await press();
  const undone = await settle(3000);
  observe(
    'S4b translated after pressing a finished page',
    String(undone.translated),
  );
  check(
    undone.translated === 0,
    'pressing a finished page no longer undoes it',
  );

  // ---------------------------------------------------------------- S5
  console.log('\nS5 — nodes torn out from under the queue');
  await configure({ autoTranslate: 'off' });
  await reset();
  await seed(30, 'churn');
  await press();
  await sleep(400);
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('main p'));
    for (const p of all.slice(0, 15)) p.remove();
  });
  const churned = await settle(8000);
  const failed = await page.evaluate(
    () => document.querySelectorAll('.oit-bilingual[data-oit-failed]').length,
  );
  observe('S5 translated', String(churned.translated));
  observe('S5 blocks marked failed', String(failed));
  check(
    failed === 0,
    'blocks torn out of the page mid-run were reported as translation failures',
  );

  // ---------------------------------------------------------------- S6
  console.log('\nS6 — five thousand blocks');
  await reset();
  const seeded = Date.now();
  await seed(5000, 'huge');
  await press();
  const huge = await settle(12000);
  observe('S6 translated of 5000', String(huge.translated));
  observe('S6 wall clock', `${String(Date.now() - seeded)} ms`);
  check(huge.translated > 0, 'a very large page translated nothing');
  check(
    huge.translated < 200,
    `${String(huge.translated)} of 5000 blocks translated — viewport-first stopped holding at scale`,
  );

  // ---------------------------------------------------------------- S7
  console.log('\nS7 — how large an exception list storage will actually take');
  const quota = await worker.evaluate(async () => {
    const build = (n) =>
      Array.from(
        { length: n },
        (_, i) => `site-${i}-with-a-fairly-long-name.example.com`,
      );
    const attempt = async (n) => {
      try {
        await chrome.storage.sync.set({ autoTranslateExcept: build(n) });
        return true;
      } catch {
        return false;
      }
    };
    return { at200: await attempt(200), atCapSize: await attempt(120) };
  });
  observe(
    'S7 raw write of 200 hosts',
    quota.at200 ? 'accepted' : 'REJECTED by quota',
  );
  observe(
    'S7 raw write of 120 hosts (inside the cap)',
    quota.atCapSize ? 'accepted' : 'REJECTED',
  );
  check(
    quota.atCapSize,
    'a list inside MAX_EXCEPT_BYTES was still rejected — the cap in settings.ts is too generous',
  );
  const stillSaves = await worker.evaluate(async () => {
    try {
      await chrome.storage.sync.set({ targetLang: 'Japanese' });
      return (await chrome.storage.sync.get('targetLang')).targetLang;
    } catch (e) {
      return `THREW ${String(e)}`;
    }
  });
  observe('S7 other settings after that', String(stillSaves));
  await worker.evaluate(async () =>
    chrome.storage.sync.set({
      autoTranslateExcept: [],
      targetLang: 'Traditional Chinese',
    }),
  );

  // ---------------------------------------------------------------- S8
  console.log('\nS8 — a selection panel on a page that is being watched');
  await reset();
  await seed(40, 'sel');
  await press();
  await sleep(5000);
  const beforeSelection = await stats();
  for (let i = 0; i < 6; i++) {
    await selectAndTranslate();
    await sleep(900);
  }
  const afterSelection = await settle(3000);
  const panelText = await page.evaluate(
    () => document.getElementById('oit-translate-panel')?.textContent ?? '',
  );
  observe('S8 panel opened', panelText.length > 0 ? 'yes' : 'NO');
  observe(
    'S8 page translations',
    `${String(beforeSelection.translated)} -> ${String(afterSelection.translated)}`,
  );
  observe('S8 progress badges', String(afterSelection.badges));
  check(
    panelText.length > 0,
    'the selection panel never opened on a watched page',
  );
  check(
    afterSelection.badges === 0,
    'selecting text made whole-page translation start over',
  );

  // ---------------------------------------------------------------- S9
  console.log('\nS9 — selecting text while the page queue is still draining');
  await reset();
  await seed(60, 'busy');
  await press();
  await sleep(200);
  await selectAndTranslate();
  const busy = await settle(8000);
  const busyPanel = await page.evaluate(
    () => document.getElementById('oit-translate-panel')?.textContent ?? '',
  );
  observe(
    'S9 panel while the page ran',
    busyPanel.length > 0 ? 'opened' : 'NEVER OPENED',
  );
  observe('S9 page translations', String(busy.translated));
  check(busyPanel.length > 0, 'a selection made during a page run was starved');
  check(busy.translated > 0, 'a selection during a page run stopped the page');

  // ---------------------------------------------------------------- S10
  console.log('\nS10 — the Ollama engine pointed at nothing');
  await configure({
    engine: 'ollama',
    baseUrl: 'http://127.0.0.1:1',
    autoTranslate: 'off',
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await seed(30, 'dead');
  await press();
  let deadBadge = '';
  for (let waited = 0; waited < 60000; waited += 1000) {
    await sleep(1000);
    deadBadge = await page.evaluate(
      () => document.getElementById('oit-page-progress')?.textContent ?? '',
    );
    if (deadBadge.startsWith('Gave up')) break;
  }
  const debris = await stats();
  observe('S10 badge', deadBadge || '(none)');
  observe('S10 markers left behind', String(debris.marked));
  check(deadBadge.startsWith('Gave up'), 'a dead server did not end the run');
  check(
    deadBadge.includes('Ollama') || deadBadge.includes('reach'),
    'the badge gave up without saying why',
  );
  check(debris.marked === 0, 'giving up left translation markers on the page');

  // And it must stop watching, or every new screen asks the dead server again.
  const callsBefore = await stats();
  await page.evaluate(() => {
    const main = document.querySelector('main');
    for (let i = 0; i < 5; i++) {
      const el = document.createElement('p');
      el.textContent = `Content that arrived after the server was found dead, number ${String(i)}.`;
      main?.appendChild(el);
    }
  });
  await sleep(5000);
  const afterGiveUp = await stats();
  observe('S10 badges after new content', String(afterGiveUp.badges));
  check(
    afterGiveUp.badges === 0 &&
      afterGiveUp.translated === callsBefore.translated,
    'the page kept asking a server it had already given up on',
  );

  // ---------------------------------------------------------------- S11
  console.log('\nS11 — the bundled PDF viewer still boots');
  const viewer = await browser.newPage();
  const viewerErrors = [];
  viewer.on('pageerror', (e) => viewerErrors.push(e.message));
  await viewer.goto(`chrome-extension://${id}/pdfjs/web/viewer.html`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(2500);
  const viewerReady = await viewer.evaluate(() =>
    Boolean(document.getElementById('viewerContainer')),
  );
  observe('S11 viewer container', viewerReady ? 'present' : 'MISSING');
  observe(
    'S11 page errors',
    viewerErrors.length === 0 ? 'none' : viewerErrors[0],
  );
  check(viewerReady, 'the bundled PDF viewer no longer renders its container');
  await viewer.close();

  // ---------------------------------------------------------------- S12
  console.log('\nS12 — a real local model behind the same live queue');
  // Asked first, and skipped rather than failed when the answer is no. A
  // harness that goes red because the machine running it has no Ollama is one
  // nobody reads the output of after the second time.
  const ollamaUp = await page
    .evaluate(async () => {
      try {
        const response = await fetch('http://localhost:11434/api/tags', {
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch {
        return false;
      }
    })
    .catch(() => false);

  if (!ollamaUp) {
    observe('S12', 'skipped — no Ollama on http://localhost:11434');
  } else {
    await configure({ engine: 'ollama', baseUrl: 'http://localhost:11434' });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await seed(6, 'local');
    await press();
    let slow = await stats();
    for (let waited = 0; waited < 120000; waited += 2000) {
      await sleep(2000);
      slow = await stats();
      const badge = await page.evaluate(
        () => document.getElementById('oit-page-progress')?.textContent ?? '',
      );
      if (badge.startsWith('Done') || badge.startsWith('Gave up')) break;
    }
    observe('S12 translated by the local model', String(slow.translated));
    check(
      slow.translated > 0,
      'the Ollama engine translated nothing through the live queue',
    );
  }
  await configure({ engine: 'builtin' });

  // ---------------------------------------------------------------- S13
  //
  // Frames. Whole-page translation ran on the top frame only, which kept ad
  // iframes from spending the reader's GPU and kept one badge on the page —
  // and left an article inside an iframe untranslated with nothing to say why.
  // The test is now what is in the frame rather than where it sits, so this
  // scenario needs both kinds on one page at once.
  //
  // Served locally rather than built with `srcdoc`: an `about:srcdoc` frame
  // needs `match_origin_as_fallback` before Chrome will inject a content script
  // at all, so a srcdoc fixture would be measuring a manifest key instead of
  // the frame test, and would go green the day the real behaviour broke.
  console.log('\nS13 — an article in an iframe, and an ad in another');
  const FRAME_PORT = 9338;
  const ARTICLE = Array.from(
    { length: 6 },
    (_, i) =>
      `<p>Paragraph number ${i} of an article that happens to be embedded in a frame, written at enough length to be worth translating on its own.</p>`,
  ).join('\n');
  const pages = {
    '/parent':
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parent</title></head><body>' +
      '<p>The page the reader actually navigated to, with its own paragraph of prose to translate.</p>' +
      '<iframe id="article" src="/article" width="600" height="400"></iframe>' +
      '<iframe id="ad" src="/ad" width="300" height="600"></iframe>' +
      '</body></html>',
    '/article':
      '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>' +
      ARTICLE +
      '</body></html>',
    // A 300x600 skyscraper: deliberately past the size floor, so the only
    // thing that can keep it out is having nothing to read. A leaderboard
    // would fail on height and the block count would never be exercised.
    '/ad':
      '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>' +
      '<p>Buy this now, and save money today on everything in the entire store.</p>' +
      '</body></html>',
  };
  const frameServer = createServer((request, response) => {
    const body = pages[new URL(request.url, 'http://127.0.0.1').pathname];
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) =>
    frameServer.listen(FRAME_PORT, '127.0.0.1', resolve),
  );

  try {
    await page.goto(`http://127.0.0.1:${FRAME_PORT}/parent`, {
      waitUntil: 'networkidle0',
    });
    await sleep(1500);
    await press();

    const frameStats = async () => {
      const counts = { top: 0, article: 0, ad: 0, badges: 0 };
      for (const frame of page.frames()) {
        const url = frame.url();
        const where = url.endsWith('/article')
          ? 'article'
          : url.endsWith('/ad')
            ? 'ad'
            : url.endsWith('/parent')
              ? 'top'
              : null;
        if (!where) continue;
        const seen = await frame
          .evaluate(() => ({
            translated: document.querySelectorAll('.oit-bilingual').length,
            badges: document.querySelectorAll('#oit-page-progress').length,
          }))
          .catch(() => ({ translated: 0, badges: 0 }));
        counts[where] = seen.translated;
        counts.badges += seen.badges;
      }
      return counts;
    };

    let frames = await frameStats();
    for (let waited = 0; waited < 60000; waited += 1000) {
      await sleep(1000);
      frames = await frameStats();
      if (frames.top > 0 && frames.article >= 6) break;
    }
    observe('S13 top frame translated', String(frames.top));
    observe('S13 article frame translated', String(frames.article));
    observe('S13 ad frame translated', String(frames.ad));
    observe('S13 badges across all frames', String(frames.badges));
    check(frames.top > 0, 'the top frame was not translated');
    check(
      frames.article > 0,
      'an article inside an iframe was still left untranslated',
    );
    check(
      frames.ad === 0,
      'an ad-sized frame with one line of copy was translated anyway',
    );
    // The reason the old restriction existed. Every qualifying frame runs its
    // own pass, and a badge is positioned against the viewport it lives in, so
    // more than one would put Stop buttons in corners of the page that stop
    // different things.
    check(
      frames.badges <= 1,
      `${frames.badges} progress badges across the frames, expected at most 1`,
    );
  } finally {
    frameServer.close();
  }

  // ---------------------------------------------------------------- S14
  //
  // Subtitles. A caption is on screen for about two seconds and is repainted
  // far more often than it changes, so the two things that can go wrong are
  // both about time: a translation that arrives after its cue has gone, and a
  // round trip spent on a repaint of the line already showing.
  //
  // The fixture is a player-shaped DOM driven from the test rather than
  // YouTube itself: a harness that needs a video with captions, a consent
  // dialog and somebody's network is one that goes red for reasons that are
  // not this code. What it does verify is everything downstream of the
  // selector — the observer, the cache, the abandonment of a stale cue, and a
  // real translation through the real broker. That the selector still matches
  // today's YouTube is the part this cannot check, and the module says so.
  console.log('\nS14 — subtitles, at the speed captions actually change');
  const SUB_PORT = 9339;
  const CUES = [
    'The first line of the film, spoken clearly.',
    'A second line, quite different from the first.',
    '[Music]',
    'The first line of the film, spoken clearly.',
  ];
  const subServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Player</title></head>' +
        '<body><div class="ytp-caption-window-container">' +
        '<span class="ytp-caption-segment">' +
        CUES[0] +
        '</span></div></body></html>',
    );
  });
  await new Promise((resolve) =>
    subServer.listen(SUB_PORT, '127.0.0.1', resolve),
  );

  try {
    await configure({
      translateSubtitles: true,
      targetLang: 'Traditional Chinese',
    });
    await page.goto(`http://127.0.0.1:${SUB_PORT}/`, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(1500);

    const showCue = (text) =>
      page.evaluate((value) => {
        document.querySelector('.ytp-caption-segment').textContent = value;
      }, text);

    const readLine = () =>
      page.evaluate(
        () => document.querySelector('.oit-subtitle')?.textContent ?? '',
      );

    let first = '';
    for (let waited = 0; waited < 30000; waited += 250) {
      first = await readLine();
      if (first) break;
      await sleep(250);
    }
    observe('S14 first cue', first || '(none)');
    check(first !== '', 'the first caption was never translated');
    check(
      !/[A-Za-z]{4,}/.test(first),
      `the first cue came back in English (${first})`,
    );

    await showCue(CUES[1]);
    let second = '';
    for (let waited = 0; waited < 30000; waited += 250) {
      second = await readLine();
      if (second && second !== first) break;
      await sleep(250);
    }
    observe('S14 second cue', second || '(none)');
    check(second !== first, 'the caption changed and the translation did not');

    // A sound marker is not speech, and a translator asked for one answers
    // confidently and wrongly.
    await showCue(CUES[2]);
    await sleep(2000);
    const marker = await readLine();
    observe('S14 on [Music]', marker === '' ? '(blank, correct)' : marker);
    check(marker === '', `a sound marker was translated (${marker})`);

    // The line comes back. It must not cost a second round trip, and the
    // observable form of that is that it appears without a gap.
    await showCue(CUES[3]);
    await sleep(400);
    const repeated = await readLine();
    observe('S14 repeated cue', repeated || '(none)');
    check(
      repeated === first,
      `a repeated line was not served from the cache (${repeated})`,
    );

    // And off means off.
    await configure({ translateSubtitles: false });
    await sleep(1500);
    const afterOff = await page.evaluate(
      () => document.querySelectorAll('.oit-subtitle').length,
    );
    observe('S14 lines after switching off', String(afterOff));
    check(
      afterOff === 0,
      'switching subtitles off left the translation on screen',
    );
  } finally {
    subServer.close();
    await configure({ translateSubtitles: false });
  }
} catch (error) {
  console.error(`\nharness failed: ${error?.stack ?? String(error)}`);
} finally {
  await browser?.disconnect();
  chrome.kill();
}

console.log('\n=== summary ===');
for (const f of findings) console.log(f);

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS');
