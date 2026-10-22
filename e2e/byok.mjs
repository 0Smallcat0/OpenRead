/**
 * The "your own API key" engine, end to end, against a stand-in provider.
 *
 * The unit tests drive `api/openai.ts` with a stubbed `fetch`, which says
 * nothing about the parts only a browser has: the worker reading the key out
 * of `chrome.storage.local`, the request leaving an extension origin, the page
 * receiving what streamed back, the popup checking a key against a real
 * socket. This serves an OpenAI-compatible API on 127.0.0.1 — no account, no
 * bill — and a page to translate, and asserts on both sides of the wire.
 *
 * The stand-in answers the first translation with a 429 and `Retry-After: 1`,
 * because a free-tier key meets that within one page, and the request has to
 * be made again rather than the block failing.
 *
 *   pnpm build && pnpm e2e:byok
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_BUILD, OPENREAD_PROFILE.
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
const PORT = 9343;
const EXTENSION = resolve(process.env.OPENREAD_BUILD ?? '.output/chrome-mv3');
const PROFILE =
  process.env.OPENREAD_PROFILE ?? mkdtempSync(join(tmpdir(), 'openread-byok-'));
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

const PARAGRAPHS = [
  'The committee met on Tuesday to review the budget for the coming year.',
  'Most of the discussion concerned the cost of maintaining the old bridge.',
  'A final decision is expected after the public consultation closes in May.',
];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BYOK</title></head>
<body>${PARAGRAPHS.map((p, i) => `<p id="p${String(i)}">${p}</p>`).join('\n')}</body></html>`;

/** What the stand-in saw, for the assertions on the far side of the wire. */
const seen = { chats: [], models: [], rateLimited: 0 };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  const authorized = req.headers.authorization === `Bearer ${KEY}`;
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    seen.models.push({ authorized });
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [{ id: MODEL }, { id: 'another-model' }],
      }),
    );
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key' } }));
        return;
      }
      if (seen.rateLimited === 0) {
        seen.rateLimited += 1;
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '1',
        });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
        return;
      }
      const body = JSON.parse(raw);
      seen.chats.push(body);
      const n = seen.chats.length;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const parts = ['這是', '模擬', `翻譯第${String(n)}段。`];
      const send = (content) =>
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        );
      res.write(': keep-alive\n\n');
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      );
      for (const part of parts) send(part);
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

  // A pasted full endpoint, on purpose: it is what providers' docs show, and
  // the client has to cut it back to the base.
  await worker.evaluate(
    async (api, key, model) => {
      await chrome.storage.sync.set({
        engine: 'openai',
        apiBaseUrl: `${api}/v1/chat/completions`,
        apiModel: model,
        targetLang: 'Traditional Chinese',
      });
      await chrome.storage.local.set({ apiKey: key });
    },
    API,
    KEY,
    MODEL,
  );
  const synced = await worker.evaluate(async () =>
    Object.keys(await chrome.storage.sync.get(null)),
  );
  check(!synced.includes('apiKey'), 'the API key is in synced storage');

  // --- the popup checks the key ---------------------------------------------
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  let connection = '';
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    connection = await popup.evaluate(
      () => document.getElementById('apiConnection')?.textContent ?? '',
    );
    if (connection && connection !== 'Checking…') break;
  }
  const offered = await popup.evaluate(() =>
    Array.from(document.querySelectorAll('#apiModelOptions option')).map(
      (o) => o.value,
    ),
  );
  const visible = await popup.evaluate(
    () => !document.getElementById('apiOnly')?.hasAttribute('hidden'),
  );
  line('popup', `${visible ? 'API fields shown' : 'API fields HIDDEN'}`);
  line('popup says', connection);
  line('models offered', offered.join(', '));
  check(visible, 'the popup hid the API fields for the API engine');
  check(
    connection.startsWith('Connected'),
    `the popup did not connect: ${connection}`,
  );
  check(offered.includes(MODEL), 'the popup did not offer the listed models');
  check(
    seen.models.length > 0 && seen.models.every((m) => m.authorized),
    'the model list was asked for without the key',
  );
  await popup.close();

  // --- a whole page translates through it -----------------------------------
  const page = await browser.newPage();
  await page.goto(`${API}/page`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const sent = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined) return 'no active tab';
    await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
    return 'sent';
  });
  line('translate page', sent);

  let state = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    state = await page.evaluate(() => ({
      badge: document.getElementById('oit-page-progress')?.textContent ?? '',
      nodes: Array.from(document.querySelectorAll('.oit-bilingual')).map(
        (n) => n.textContent ?? '',
      ),
      failed: document.querySelectorAll('.oit-bilingual[data-oit-failed]')
        .length,
    }));
    if (state.badge.startsWith('Done')) break;
  }
  line('badge', state?.badge ?? '(none)');
  for (const text of state?.nodes ?? []) line('  inserted', text);

  check(
    (state?.nodes.length ?? 0) === PARAGRAPHS.length,
    `expected ${String(PARAGRAPHS.length)} translations, got ${String(state?.nodes.length ?? 0)}`,
  );
  check(
    (state?.nodes ?? []).every((t) => /這是模擬翻譯第\d段/.test(t)),
    'a translation did not come from the stand-in',
  );
  check((state?.failed ?? 1) === 0, `${String(state?.failed)} block(s) failed`);
  check(seen.rateLimited === 1, 'the stand-in never rate-limited a request');

  // --- what the provider received -------------------------------------------
  const first = seen.chats[0];
  line('requests received', `${String(seen.chats.length)} (+1 rate-limited)`);
  check(
    first?.model === MODEL,
    `the request named model ${String(first?.model)}`,
  );
  check(first?.stream === true, 'the request did not ask for a stream');
  check(
    first?.messages?.[0]?.role === 'system',
    'the request carried no system prompt',
  );
  const asked = seen.chats.map((c) => c.messages.at(-1)?.content ?? '');
  check(
    PARAGRAPHS.every((p) => asked.some((a) => a.includes(p))),
    'a paragraph was never sent for translation',
  );
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
