/**
 * Does installing the extension start the language-pack download on its own?
 *
 * Nothing is pressed here: no page, no popup, no translate, no settings write.
 * The only thing that happens is the install, which is the whole claim — and
 * the one `e2e:first-run` measures the cost of not making: six minutes after a
 * first press on a cold profile, that harness found nothing on the page and
 * Chrome's pack at 43%.
 *
 * Measured on disk rather than through `Translator.availability()`, which
 * reports `downloadable` for the whole duration of a download it is itself
 * performing — measured at 145,687 ms of `create()` with availability never
 * once saying `downloading`. Bytes arriving in the profile cannot lie the same
 * way.
 *
 *   pnpm build && pnpm e2e:prefetch
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_BUILD, OPENREAD_PROFILE.
 * A profile that already holds the pack passes instantly and proves nothing;
 * the default is a fresh one for that reason.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const EXTENSION = resolve(process.env.OPENREAD_BUILD ?? '.output/chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ??
  mkdtempSync(join(tmpdir(), 'openread-prefetch-'));
/** Comfortably more than the few hundred KB idle Chrome writes on its own. */
const GREW_ENOUGH = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
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
let logged = [];
try {
  await sleep(4000);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
    protocolTimeout: 0,
  });
  const cdp = await browser.target().createCDPSession();

  const baseline = dirSize(PROFILE);
  line('profile', PROFILE);
  line('build', EXTENSION);
  line('profile before install', mb(baseline));

  const t0 = Date.now();
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
  // Anything the worker complained about on its way, which is where a
  // prefetch that refused would say so.
  worker.on('console', (m) =>
    logged.push(`${m.type()}: ${m.text().slice(0, 160)}`),
  );

  for (let i = 0; i < 24; i++) {
    await sleep(15_000);
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

if (logged.length > 0) {
  console.log('\n--- what the worker said ---');
  for (const item of logged.slice(0, 10)) console.log(`  ${item}`);
}
const pass = grew > GREW_ENOUGH;
console.log(
  pass
    ? `\nPASS — ${mb(grew)} arrived with nothing pressed`
    : `\nFAIL — only ${mb(grew)} arrived; the install started no download`,
);
process.exit(pass ? 0 : 1);
