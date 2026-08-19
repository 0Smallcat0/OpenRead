/**
 * Select some text, click the 文 icon, read what comes back.
 *
 * The one route through this product that no other harness touched. `e2e:page`
 * drives whole-page translation, the hover panel and the input box; the
 * selection controller they all share — `ui/selection.ts`, which is also what
 * the PDF viewer runs — had unit tests for its geometry and nothing that had
 * ever selected a word in a browser.
 *
 * A real drag, not `window.getSelection()` surgery: the controller listens for
 * `mouseup` on the document in the capture phase, and a selection built by
 * script produces no such event. Wiring that a synthetic selection cannot
 * reach is exactly the wiring worth a browser.
 *
 *   pnpm build && pnpm e2e:selection
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_BUILD, OPENREAD_PROFILE,
 * OPENREAD_URL. The default profile is a throwaway, which means the language
 * pack is paid for on every run; `OPENREAD_PROFILE` is what makes it bearable
 * to run twice.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET =
  process.env.OPENREAD_URL ?? 'https://en.wikipedia.org/wiki/Ollama';
const PORT = 9341;
const EXTENSION = resolve(process.env.OPENREAD_BUILD ?? '.output/chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ?? mkdtempSync(join(tmpdir(), 'openread-sel-'));

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

let browser;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });

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

  line(
    'extension',
    `${id} ${await worker.evaluate(() => chrome.runtime.getManifest().version)}`,
  );
  const availability = await worker.evaluate(() =>
    Translator.availability({
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hant',
    }),
  );
  line('en -> zh-Hant', availability);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // A paragraph with enough prose in it to be worth translating, and its
  // geometry, so the drag is over real text rather than over a coordinate.
  // Chosen by length rather than by a site's own class names: the harness
  // should keep working when the page it points at is redesigned.
  const box = await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(
      (el) => (el.innerText ?? '').trim().length > 160,
    );
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      text: p.innerText.slice(0, 60),
    };
  });
  check(box !== null, 'no paragraph long enough to select');
  if (!box) throw new Error('nothing to select');
  line('paragraph', `${box.text}…`);

  await sleep(400);
  // A real drag: mousedown at the start of the first line, move across it,
  // mouseup. The controller listens on document mouseup in the capture phase.
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 8, box.y + 8, { steps: 12 });
  await page.mouse.move(box.x + box.w - 8, box.y + 30, { steps: 6 });
  await page.mouse.up();
  await sleep(900);

  const selected = await page.evaluate(() =>
    (window.getSelection()?.toString() ?? '').trim(),
  );
  line('selected', `${selected.length} chars`);
  check(selected.length > 20, `selection was only ${selected.length} chars`);

  const icon = await page.evaluate(() => {
    const el = document.getElementById('oit-translate-icon');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent?.trim(),
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    };
  });
  check(icon !== null, 'the 文 icon never appeared after a selection');
  line(
    'icon',
    icon
      ? `${icon.text} at ${Math.round(icon.x)},${Math.round(icon.y)}`
      : 'ABSENT',
  );
  if (!icon) throw new Error('no icon to click');

  await page.mouse.click(icon.x, icon.y);
  await sleep(600);

  const panelThere = await page.evaluate(
    () => document.getElementById('oit-translate-panel') !== null,
  );
  check(panelThere, 'clicking the icon opened no panel');
  line('panel', panelThere ? 'open' : 'ABSENT');

  let last = '';
  let settled = 0;
  const started = Date.now();
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const text = await page.evaluate(() => {
      const panel = document.getElementById('oit-translate-panel');
      if (!panel) return '(no panel)';
      const body = panel.querySelector('.content-div');
      return (body?.innerText ?? panel.innerText ?? '').trim();
    });
    if (text !== last) {
      last = text;
      settled = 0;
      line(
        `t+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`,
        `${text.length} chars · ${text.replace(/\n/g, ' ').slice(0, 60)}`,
      );
    } else if (
      ++settled >= 4 &&
      text.length > 0 &&
      !/Translating/i.test(text)
    ) {
      break;
    }
  }

  console.log('\n--- outcome ---');
  line('translation', last.replace(/\n/g, ' ').slice(0, 120));
  const han = (last.match(/[\u4e00-\u9fff]/g) ?? []).length;
  line('han characters', han);
  check(han > 15, `only ${han} Han characters came back`);
  check(!/Translating/i.test(last), 'the panel is still saying "Translating"');
  check(
    !/⚠|failed|error/i.test(last),
    `the panel reported a failure: ${last.slice(0, 80)}`,
  );
} catch (error) {
  failures.push(`harness error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  chrome.kill();
}

if (failures.length > 0) {
  console.log('\nFAIL');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS');
