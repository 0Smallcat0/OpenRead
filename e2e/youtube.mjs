/**
 * Bilingual YouTube captions, end to end, on a real video.
 *
 * The unit tests drive the overlay against a fake player and the hook against
 * a fake XHR, which says nothing about the parts only YouTube has: whether the
 * player still fetches its track the way `ui/timedtext-hook.ts` expects,
 * whether the CC button and the caption window still have the names this
 * reads, whether the overlay lands inside the player and above the video.
 * This opens a real watch page in a fresh profile, presses CC the way a
 * reader would, and waits for a translated line.
 *
 * The translations come from a stand-in OpenAI-compatible API on 127.0.0.1,
 * as in `e2e:byok` — so no language pack has to download and every line that
 * reached the engine can be counted.
 *
 *   pnpm build && pnpm e2e:youtube
 *
 * Needs the network, for YouTube. Environment overrides: OPENREAD_CHROME,
 * OPENREAD_BUILD, OPENREAD_PROFILE, OPENREAD_VIDEO (a video id with captions
 * in a language other than Traditional Chinese).
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9344;
const EXTENSION = resolve(process.env.OPENREAD_BUILD ?? '.output/chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-youtube-'));
// A two-hour lecture with English speech-recognition captions: the case that
// needs sentences rebuilt, and long enough that translating all of it up
// front would show in the request count.
const VIDEO = process.env.OPENREAD_VIDEO ?? 'kCc8FmEb1nY';
const KEY = 'sk-e2e-not-a-real-key';
const MODEL = 'stand-in-model';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}.`);
  process.exit(1);
}

/** Every line the stand-in was asked to translate. */
const asked = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      asked.push(body.messages.at(-1)?.content ?? '');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const content = `譯文第${String(asked.length)}句`;
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const API = `http://127.0.0.1:${String(server.address().port)}`;
line('stand-in API', `${API}/v1`);

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
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
  line(
    'extension',
    `${id} ${await worker.evaluate(() => chrome.runtime.getManifest().version)}`,
  );
  await worker.evaluate(
    async (api, key, model) => {
      await chrome.storage.sync.set({
        engine: 'openai',
        apiBaseUrl: `${api}/v1`,
        apiModel: model,
        targetLang: 'Traditional Chinese',
        displayMode: 'bilingual',
      });
      await chrome.storage.local.set({ apiKey: key });
    },
    API,
    KEY,
    MODEL,
  );

  const page = await browser.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, {
    waitUntil: 'domcontentloaded',
  });
  line('video', VIDEO);

  // Press CC once the video itself is playing — not during an advert, whose
  // captions are its own — and wait for a translated line.
  let pressedAt = 0;
  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    state = await page.evaluate(() => {
      const player = document.querySelector('.html5-video-player');
      const video = document.querySelector('video.html5-main-video');
      const advert = player?.classList.contains('ad-showing') ?? false;
      document
        .querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button')
        ?.click();
      if (video && video.paused) {
        video.muted = true;
        void video.play().catch(() => undefined);
      }
      const button = document.querySelector('.ytp-subtitles-button');
      const pressed = button?.getAttribute('aria-pressed') === 'true';
      let clicked = false;
      if (!advert && button && !pressed && video && !video.paused) {
        button.click();
        clicked = true;
      }
      const overlay = player?.querySelector('.oit-subs');
      const visible = (selector) => {
        const element = overlay?.querySelector(selector);
        return element && !element.hidden ? element.textContent : null;
      };
      const native = player?.querySelector('.ytp-caption-window-container');
      return {
        advert,
        clicked,
        pressed,
        time: video?.currentTime ?? 0,
        inPlayer: !!overlay,
        source: visible('.oit-subs-source'),
        target: visible('.oit-subs-target'),
        nativeHidden: native
          ? getComputedStyle(native).display === 'none'
          : null,
        fontSize: overlay ? getComputedStyle(overlay).fontSize : null,
      };
    });
    if (state.clicked) pressedAt = Date.now();
    if (state.target) break;
  }
  line(
    'captions on',
    pressedAt ? 'pressed by this run' : state?.pressed ? 'already on' : 'NO',
  );
  line('original line', state?.source ?? '(none)');
  line('translated line', state?.target ?? '(none)');
  line(
    'first line after CC',
    pressedAt
      ? `${String(Date.now() - pressedAt)} ms (polled each second)`
      : '-',
  );
  line('YouTube captions hidden', String(state?.nativeHidden));
  line('caption size', state?.fontSize ?? '-');
  line('lines translated so far', String(asked.length));

  check(state?.inPlayer, 'no overlay inside the player');
  check(!!state?.source, 'the overlay showed no original line');
  check(
    /譯文第\d+句/.test(state?.target ?? ''),
    'no translated line from the stand-in reached the screen',
  );
  check(state?.nativeHidden === true, "YouTube's own captions were not hidden");
  check(
    asked.length > 0 && asked.length < 200,
    `expected read-ahead, not the whole track: ${String(asked.length)} lines sent`,
  );
  check(
    asked.every((text) => !/<|>/.test(text)),
    'markup reached the engine instead of caption text',
  );

  await page.screenshot({ path: join(PROFILE, 'youtube-captions.png') });
  line('screenshot', join(PROFILE, 'youtube-captions.png'));

  // CC off is the reader asking for no captions at all, ours included.
  const after = await page.evaluate(async () => {
    document.querySelector('.ytp-subtitles-button')?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const player = document.querySelector('.html5-video-player');
    return {
      overlay: !!player?.querySelector('.oit-subs'),
      marked: player?.classList.contains('oit-subs-on') ?? false,
    };
  });
  line('after CC off', after.overlay ? 'overlay STILL UP' : 'overlay gone');
  check(!after.overlay && !after.marked, 'the overlay outlived CC off');

  // And pressing it again brings them back. A muted autoplay can arrive with
  // captions already on, so this is also the run's one guaranteed press.
  const pressed = Date.now();
  let again = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    again = await page.evaluate((first) => {
      const button = document.querySelector('.ytp-subtitles-button');
      if (first) button?.click();
      const target = document.querySelector('.oit-subs .oit-subs-target');
      return target && !target.hidden ? target.textContent : null;
    }, i === 0);
    if (again) break;
  }
  line(
    'after CC on again',
    again ? `${again} (${String(Date.now() - pressed)} ms)` : '(nothing)',
  );
  check(!!again, 'pressing CC again did not bring a translated line back');
} catch (error) {
  failures.push(`harness error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  chrome.kill();
  server.close();
}

if (failures.length > 0) {
  console.log('\nFAIL');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS');
