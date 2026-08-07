/**
 * Subtitle translation on real YouTube.
 *
 * The seam no other harness reaches. `e2e:stress` S14 drives a player-shaped
 * fixture, which proves everything downstream of the selector; a probe
 * confirmed the selector matches today's YouTube. Nothing checked the two
 * together — and the first time anything did, it failed.
 *
 * What it found: YouTube declares the *interface* language, so on a machine
 * set to Taiwan `<html lang="zh-Hant-TW">` sits over English captions. The
 * subtitle path took that as the source language, the engine was asked to
 * translate zh-Hant into zh-Hant, it returned the caption unchanged, and the
 * line stayed blank. Every unit test passed. The fixture said `lang="en"`,
 * which is the one value that hides it. It says `zh-Hant-TW` now.
 *
 * Kept because the two selectors this feature hangs on are facts with an
 * expiry date. A class rename ships the feature doing nothing, silently, and
 * this is the only thing that would say so.
 *
 * Needs the network and a video whose captions still exist, so it is opt-in
 * rather than part of `pnpm e2e:stress` — the same bargain `pnpm bench` makes
 * with Ollama. A harness that goes red because a video was taken down is one
 * nobody reads twice.
 *
 *   pnpm build && pnpm e2e:youtube
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_PROFILE, OPENREAD_YT.
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
const PORT = 9356;
const VIDEO =
  process.env.OPENREAD_YT ?? 'https://www.youtube.com/watch?v=aircAruvnKk';
const EXTENSION = fileURLToPath(
  new URL('../.output/chrome-mv3', import.meta.url),
);

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const profile =
  process.env.OPENREAD_PROFILE ?? mkdtempSync(join(tmpdir(), 'openread-yt-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
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

  let workerTarget;
  for (let i = 0; i < 20 && !workerTarget; i++) {
    workerTarget = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!workerTarget) await sleep(500);
  }
  const worker = await workerTarget.worker();

  await worker.evaluate(async () =>
    chrome.storage.sync.set({
      engine: 'builtin',
      targetLang: 'Traditional Chinese',
      translateSubtitles: true,
      autoTranslate: 'off',
    }),
  );

  // The pack, before anything is timed or asserted.
  const packed = await worker.evaluate(async () => {
    try {
      const t = await Translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hant',
      });
      return await t.translate('Warming the language pack.');
    } catch (error) {
      return `FAILED: ${error.message}`;
    }
  });
  console.log(`pack: ${packed}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${VIDEO}&cc_load_policy=1&cc_lang_pref=en`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(6000);

  const consent = await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      const label = (button.textContent ?? '').toLowerCase();
      if (label.includes('reject') || label.includes('accept')) {
        button.click();
        return label.trim().slice(0, 40);
      }
    }
    return null;
  });
  if (consent) console.log(`consent: ${consent}`);
  await sleep(4000);

  await page
    .evaluate(() => document.querySelector('video')?.play())
    .catch(() => undefined);
  await sleep(2000);

  const pressed = () =>
    page.evaluate(
      () =>
        document
          .querySelector('.ytp-subtitles-button')
          ?.getAttribute('aria-pressed') ?? 'missing',
    );
  if ((await pressed()) !== 'true') {
    await page.evaluate(() => document.querySelector('video')?.focus());
    await page.keyboard.press('KeyC');
    await sleep(1500);
  }
  console.log(`captions on: ${await pressed()}`);

  const diag = await page.evaluate(() => ({
    htmlLang: document.documentElement.lang,
    styleTag: Boolean(document.getElementById('oit-subtitle-style')),
    subtitleLines: document.querySelectorAll('.oit-subtitle').length,
    containers: document.querySelectorAll('.ytp-caption-window-container')
      .length,
    segments: document.querySelectorAll('.ytp-caption-segment').length,
    segmentText: Array.from(document.querySelectorAll('.ytp-caption-segment'))
      .map((s) => s.textContent)
      .join(' '),
    anyOit: Array.from(
      document.querySelectorAll('[class*="oit-"], [id*="oit-"]'),
    )
      .map((e) => e.className || e.id)
      .slice(0, 5),
    iframes: document.querySelectorAll('iframe').length,
  }));
  console.log(`diag: ${JSON.stringify(diag)}`);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`),
  );

  const seen = [];
  let translated = 0;
  for (let waited = 0; waited < 60000; waited += 1500) {
    await sleep(1500);
    const state = await page.evaluate(() => {
      const line = document.querySelector('.oit-subtitle');
      const segment = document.querySelector('.ytp-caption-segment');
      const video = document.querySelector('video');
      const lineBox = line?.getBoundingClientRect();
      const capBox = segment?.getBoundingClientRect();
      const videoBox = video?.getBoundingClientRect();
      return {
        original: Array.from(document.querySelectorAll('.ytp-caption-segment'))
          .map((s) => s.textContent)
          .join(' ')
          .trim(),
        translation: line?.textContent?.trim() ?? '',
        time: Math.round(video?.currentTime ?? 0),
        // Geometry, because text alone said this was working for four rounds
        // while the line was painting at the top of the frame at 10px in the
        // caption colour, over the picture. Everything read `textContent` and
        // nothing read a bounding box.
        below: Boolean(lineBox && capBox && lineBox.top > capBox.top),
        inside: Boolean(
          lineBox && videoBox && lineBox.bottom <= videoBox.bottom + 4,
        ),
        size: line
          ? Math.round(parseFloat(getComputedStyle(line).fontSize))
          : 0,
        capSize: segment
          ? Math.round(parseFloat(getComputedStyle(segment).fontSize))
          : 0,
      };
    });
    if (
      state.translation &&
      !seen.some((s) => s.translation === state.translation)
    ) {
      seen.push(state);
      translated++;
      console.log(`  ${state.time}s  ${state.original}`);
      console.log(`        -> ${state.translation}`);
    }
    if (translated >= 4) break;
  }

  const after = await page.evaluate(() => ({
    styleTag: Boolean(document.getElementById('oit-subtitle-style')),
    subtitleLines: document.querySelectorAll('.oit-subtitle').length,
    containers: document.querySelectorAll('.ytp-caption-window-container')
      .length,
    segments: document.querySelectorAll('.ytp-caption-segment').length,
  }));
  console.log(`after: ${JSON.stringify(after)}`);
  if (consoleErrors.length)
    console.log(`errors: ${consoleErrors.slice(0, 5).join(' | ')}`);

  check(translated > 0, 'no YouTube caption was ever translated');
  check(
    translated >= 2,
    `only ${translated} distinct caption(s) translated in 60 s of playback`,
  );
  for (const state of seen) {
    check(
      state.translation !== state.original,
      `a caption came back unchanged (${state.original})`,
    );
    check(
      state.below,
      `the translation was not under the caption (line ${String(state.size)}px)`,
    );
    check(state.inside, 'the translation was painted outside the video');
    check(
      state.capSize > 0 && state.size >= state.capSize * 0.7,
      `the translation is ${String(state.size)}px against a ${String(state.capSize)}px caption`,
    );
  }
} catch (error) {
  console.error(`\nharness failed: ${error?.stack ?? String(error)}`);
  failures.push('the harness threw');
} finally {
  await browser?.disconnect();
  chrome.kill();
}

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS');
