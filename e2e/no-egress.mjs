/**
 * The privacy claim, as a test somebody else can run.
 *
 * The README says the default engine makes no network request at all. Until
 * this file, the only way to check that was to read the source and believe the
 * reader — which is a different thing from "several people ran it and nothing
 * left". A stranger evaluating a tool whose entire pitch is that their
 * unpublished draft stays on their laptop cannot be asked to take the author's
 * word for it, and a repository with no stars is not going to lend them anyone
 * else's word either.
 *
 * So: one command, no account, no trust in me.
 *
 *   pnpm build
 *   pnpm e2e:egress
 *
 * What it does. The page under test is served from 127.0.0.1 by this script,
 * so the fixture itself has nothing external to fetch and every request seen
 * during the run belongs to the extension or to Chrome. A CDP Network listener
 * is attached to every target that will take one — the page, the service
 * worker, any extension page — before the extension is told to translate.
 * Then the whole page is translated on the built-in engine and every recorded
 * URL is checked.
 *
 * Three assertions, and the third is the one that makes the first two mean
 * something:
 *
 *   1. Not one request went anywhere but 127.0.0.1 — no host, no analytics, no
 *      "phone home on first run", nothing.
 *   2. Not one request went to Ollama either. A run where the built-in engine
 *      quietly bowed out and Ollama did the work would satisfy assertion 1 on
 *      a technicality — localhost is not egress — while proving nothing about
 *      the engine the claim is actually about.
 *   3. The translation happened. Blocks were inserted and the badge finished.
 *      A run that translated nothing trivially sends nothing, and would be the
 *      easiest possible way to make this file lie.
 *
 * What it does not claim. Chrome downloads its language pack the first time a
 * pair is used, and that download is Chrome's, made by the browser process,
 * not by this extension — it does not appear in these events and this test
 * does not pretend to cover it. The README says the same thing in the install
 * section. The claim under test is about the extension's own traffic.
 *
 * Not in CI, for the same reason `fullpage.mjs` is not: the first run of a
 * language pair needs Chrome to fetch a model, and a runner that has to
 * download one before it can measure anything is a runner that will flake. Run
 * it on a machine that has already translated once, or budget a couple of
 * minutes for the first pass. `OPENREAD_PROFILE` keeps a warm profile between
 * runs so only the first one pays.
 *
 * Requires Chrome 138 or newer — older versions have no built-in translator,
 * the request would fall through to Ollama, and assertion 2 would catch it.
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
const DEBUG_PORT = 9334;
const FIXTURE_PORT = 9335;
const FIXTURE_HOST = `127.0.0.1:${FIXTURE_PORT}`;

const EXTENSION = fileURLToPath(
  new URL('../.output/chrome-mv3', import.meta.url),
);

/**
 * Plain English prose, every paragraph comfortably over `MIN_BLOCK_CHARS` (12)
 * so none of them is skipped by the length floor, and no external resource of
 * any kind — no stylesheet, no font, no favicon link. A fixture that fetched
 * anything of its own would put a request in the log that this test would then
 * have to explain away, and an assertion with an exception carved into it is
 * an assertion a real leak can hide behind.
 */
const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Egress fixture</title></head>
<body>
<p>The quick brown fox jumps over the lazy dog while the sun sets slowly behind the distant hills.</p>
<p>A translation tool earns trust by what it does not do, and the only way to show that is to let someone watch.</p>
<p>Reading a contract, a medical letter, or an unpublished manuscript should not require handing it to a stranger.</p>
<p>Every request this page makes is one this test can see, which is the entire point of serving it locally.</p>
</body>
</html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/**
 * Schemes that never touch a network. `chrome-extension:` is the extension
 * reading its own bundled files; `data:`, `blob:` and `about:` are in-memory;
 * `chrome:` is the browser's own UI. Listing them explicitly rather than
 * filtering on "not http" keeps a `file://` read — which would be a finding —
 * from being waved through with them.
 */
const LOCAL_SCHEMES = [
  'chrome-extension:',
  'data:',
  'blob:',
  'about:',
  'chrome:',
];

const isLocalScheme = (url) =>
  LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme));

/** The fixture server, and only the fixture server. */
const isFixture = (url) => {
  try {
    return new URL(url).host === FIXTURE_HOST;
  } catch {
    return false;
  }
};

/**
 * A loopback address never reaches a network interface, so a request to one
 * has not left the machine whatever else is wrong with it.
 *
 * Worth the separate predicate: an earlier draft counted `localhost:11434` as
 * egress, which made the Ollama run fail with "4 request(s) left the machine"
 * — false, and false in the direction that matters, since overstating a leak
 * in a file whose job is to be believed costs exactly as much as missing one.
 * Reaching a local Ollama is a different finding, and the assertion below
 * reports it as one.
 */
const isLoopback = (url) => {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
};

/** Ollama's default, plus whatever host the settings would have reached for. */
const isOllama = (url) => {
  try {
    const { hostname, port } = new URL(url);
    return port === '11434' || (hostname === 'localhost' && port === '11434');
  } catch {
    return false;
  }
};

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(FIXTURE);
});
await new Promise((resolve) =>
  server.listen(FIXTURE_PORT, '127.0.0.1', resolve),
);

const profile =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-egress-'));
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

/** Every URL any target asked for, in the order it was asked for. */
const requests = [];
const watched = new WeakSet();

/**
 * Attach a Network listener to a target, if it will take one.
 *
 * Targets come and go — the service worker in particular starts, sleeps, and
 * restarts — so this runs on every target that exists now and on every one
 * that appears later. Targets that do not support the Network domain throw,
 * and that is not a failure of the test.
 */
const watch = async (target) => {
  if (watched.has(target)) return;
  watched.add(target);
  try {
    const session = await target.createCDPSession();
    await session.send('Network.enable');
    session.on('Network.requestWillBeSent', ({ request }) => {
      requests.push({ url: request.url, from: target.type() });
    });
  } catch {
    // Not every target speaks Network. Nothing to record here.
  }
};

let browser;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
    defaultViewport: null,
  });

  browser.on('targetcreated', (target) => void watch(target));
  await Promise.all(browser.targets().map(watch));

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

  // The language pack, before anything is being watched.
  //
  // Two reasons, and the order matters for both. A profile that has never
  // translated makes Chrome fetch the en -> zh-Hant model on the first
  // request, and a run that spends its budget waiting for that reports
  // "nothing was translated, so nothing was proven" — which is this file
  // saying red about the machine it is on, in the one harness whose whole job
  // is to be believed. And the fetch is the browser process's own, not this
  // extension's, so doing it before the Network listeners attach keeps the
  // recorded requests to exactly what the claim is about rather than adding
  // one that has to be explained away.
  //
  // In the worker on purpose: `Translator.create()` throws NotAllowedError
  // without a user gesture in a page while the pack is still `downloadable`.
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

  await watch(workerTarget);

  // The engine under test, set explicitly rather than relied on as the
  // default: a defaults change should not silently turn this into a test of
  // the Ollama path.
  await worker.evaluate(async () =>
    chrome.storage.sync.set({
      engine: 'builtin',
      targetLang: 'Traditional Chinese',
    }),
  );

  const page = await browser.newPage();
  await watch(page.target());
  await page.goto(`http://${FIXTURE_HOST}/`, {
    waitUntil: 'domcontentloaded',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  });

  // Generous, because a cold profile spends this time downloading a language
  // pack. A warm one finishes in seconds and breaks out early.
  let state = null;
  for (let i = 0; i < 150; i++) {
    state = await page.evaluate(() => ({
      badge: document.getElementById('oit-page-progress')?.textContent ?? null,
      inserted: document.querySelectorAll('.oit-bilingual').length,
      failed: document.querySelectorAll('.oit-bilingual[data-oit-failed]')
        .length,
    }));
    if (state.badge?.startsWith('Done') || state.badge?.startsWith('Nothing')) {
      break;
    }
    await sleep(2000);
  }

  console.log('\n--- translation ---');
  console.log(`badge:    ${state.badge}`);
  console.log(`inserted: ${state.inserted}   failed: ${state.failed}`);

  // Assertion 3 first, because assertions 1 and 2 are worthless without it.
  check(state.inserted > 0, 'nothing was translated, so nothing was proven');
  check(state.failed === 0, `${state.failed} block(s) reported a failure`);
  check(
    state.badge?.startsWith('Done'),
    `the run never finished (badge: ${state.badge})`,
  );

  const offMachine = requests.filter(
    ({ url }) => !isLocalScheme(url) && !isLoopback(url),
  );
  // Loopback, but not the page this test is serving. Nothing on the built-in
  // path has any reason to be here.
  const otherLocal = requests.filter(
    ({ url }) => isLoopback(url) && !isFixture(url),
  );
  const toOllama = requests.filter(({ url }) => isOllama(url));

  console.log('\n--- requests ---');
  console.log(`observed:    ${requests.length}`);
  console.log(`off-machine: ${offMachine.length}`);
  console.log(`other local: ${otherLocal.length}`);
  for (const { url, from } of [...offMachine, ...otherLocal]) {
    console.log(`  ! ${from}  ${url}`);
  }

  check(
    offMachine.length === 0,
    `${offMachine.length} request(s) left the machine: ` +
      offMachine.map(({ url }) => url).join(', '),
  );
  check(
    toOllama.length === 0,
    'the built-in engine did not serve this run — it fell through to Ollama, ' +
      'so nothing here says anything about the default engine',
  );
  check(
    otherLocal.length === 0,
    'something on the machine was contacted that is not the fixture: ' +
      otherLocal.map(({ url }) => url).join(', '),
  );
} catch (error) {
  failures.push(error?.message ?? String(error));
} finally {
  await browser?.disconnect();
  chrome.kill();
  server.close();
}

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS — nothing left the machine.');
