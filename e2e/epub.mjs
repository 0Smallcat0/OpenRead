/**
 * The EPUB reader, verified in a real browser against the real engine.
 *
 * Everything under `src/ui/epub*.ts` is unit-tested in jsdom, and jsdom cannot
 * answer the questions that matter here. It has no `DecompressionStream`
 * behind a real zip, no `URL.createObjectURL`, no layout for an image to have
 * a size in, no network stack to prove nothing was fetched over, and no
 * Chrome to run the translator. A reader that opens a book in jsdom and shows
 * a blank page in Chrome would pass every test in the suite.
 *
 * The archive is built here with Node's own `zlib`, not with the reader's
 * writer, so this is a genuine second implementation on the producing side:
 * a bug shared between a hand-rolled reader and a hand-rolled writer cancels
 * out and stays invisible, and that is exactly what a zip format test is for.
 *
 * What it asserts, end to end:
 *   1. the reader page loads and a real `.epub` opens in it
 *   2. the chapters, the metadata and a nested table of contents are read
 *   3. an image inside the archive is rendered from the archive
 *   4. a link the book drew moves the reader instead of navigating the page
 *   5. Next and the contents both move, and the position is remembered
 *   6. a chapter is translated by the real engine, bilingually
 *   7. the translation follows the reader into the next chapter unasked
 *   8. reading a whole book makes no network request of any kind
 *
 * Requires a Chrome on disk. Not in CI, for the same reason as the other
 * harnesses: the engine is the thing under test and a stubbed one measures the
 * stub.
 *
 *   pnpm build
 *   pnpm e2e:epub
 *
 * Environment overrides: OPENREAD_CHROME, OPENREAD_ENGINE, OPENREAD_MODEL,
 * OPENREAD_PROFILE.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODEL = process.env.OPENREAD_MODEL ?? 'qwen3:latest';
const ENGINE = process.env.OPENREAD_ENGINE ?? 'builtin';
const PORT = 9335;

const EXTENSION = fileURLToPath(
  new URL('../.output/chrome-mv3', import.meta.url),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}

// ---------------------------------------------------------------- the book

/** A zip, written by Node rather than by anything this repository ships. */
function zip(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, store = false } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const payload = store ? data : deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    parts.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

const utf8 = (text) => Buffer.from(text, 'utf8');

/** One transparent pixel, so the picture is real without being large. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const CHAPTERS = [
  {
    file: 'text/ch1.xhtml',
    label: 'The Whale',
    body: `<h1>The Whale</h1>
      <p>Call me Ishmael. Some years ago, never mind how long precisely, having
      little or no money in my purse, I thought I would sail about a little and
      see the watery part of the world.</p>
      <p><img src="../images/plate.png" alt="A plate"/></p>
      <p><a href="ch3.xhtml">Skip ahead to the third chapter of this book.</a></p>`,
  },
  {
    file: 'text/ch2.xhtml',
    label: 'The Carpet-Bag',
    body: `<h1>The Carpet-Bag</h1>
      <p>I stuffed a shirt or two into my old carpet-bag, tucked it under my
      arm, and started for Cape Horn and the Pacific.</p>`,
  },
  {
    file: 'text/ch3.xhtml',
    label: 'The Spouter-Inn',
    body: `<h1>The Spouter-Inn</h1>
      <p>Entering that gable-ended Spouter-Inn, you found yourself in a wide,
      low, straggling entry with old-fashioned wainscots.</p>`,
  },
];

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Moby-Dick</dc:title>
    <dc:creator>Herman Melville</dc:creator>
    <dc:identifier id="id">urn:uuid:openread-e2e-book</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="plate" href="images/plate.png" media-type="image/png"/>
${CHAPTERS.map(
  (chapter, i) =>
    `    <item id="c${i}" href="${chapter.file}" media-type="application/xhtml+xml"/>`,
).join('\n')}
  </manifest>
  <spine>
${CHAPTERS.map((_, i) => `    <itemref idref="c${i}"/>`).join('\n')}
  </spine>
</package>`;

/** Nested on purpose: a flat contents would never exercise the depths. */
const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">The Whale</a>
      <ol><li><a href="text/ch2.xhtml">The Carpet-Bag</a></li></ol>
    </li>
    <li><a href="text/ch3.xhtml">The Spouter-Inn</a></li>
  </ol></nav></body>
</html>`;

const chapterDoc = (body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title><link rel="stylesheet" href="../style.css"/></head>
  <body>${body}</body>
</html>`;

const book = zip([
  { name: 'mimetype', data: utf8('application/epub+zip'), store: true },
  {
    name: 'META-INF/container.xml',
    data: utf8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  },
  { name: 'OEBPS/content.opf', data: utf8(opf) },
  { name: 'OEBPS/nav.xhtml', data: utf8(nav) },
  { name: 'OEBPS/style.css', data: utf8('body { display: none }') },
  { name: 'OEBPS/images/plate.png', data: PIXEL },
  ...CHAPTERS.map((chapter) => ({
    name: `OEBPS/${chapter.file}`,
    data: utf8(chapterDoc(chapter.body)),
  })),
]);

const workspace = mkdtempSync(join(tmpdir(), 'openread-epub-'));
const bookPath = join(workspace, 'moby-dick.epub');
writeFileSync(bookPath, book);
console.log(`book: ${bookPath} (${book.length} bytes)`);

// ------------------------------------------------------------------ chrome

const profile =
  process.env.OPENREAD_PROFILE ?? mkdtempSync(join(tmpdir(), 'openread-e2e-'));
mkdirSync(profile, { recursive: true });
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
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

  // Register the language pack before anything is timed against it; on a fresh
  // profile the first request is a download of a minute or more.
  if (ENGINE === 'builtin') {
    const warmed = await worker.evaluate(async () => {
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
    console.log(`pack: ${warmed}`);
  }

  /**
   * Forget where this book was last left.
   *
   * Reading position is keyed on the publisher's identifier, so a rerun over a
   * reused profile opens the fixture at whatever chapter the previous run
   * finished on — which is the feature working, and a harness that then
   * asserts "chapter one is on screen" failing for it. Found exactly that way:
   * two runs in a row opened at 3 / 3.
   */
  await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) =>
      key.startsWith('epub-position:'),
    );
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  });

  const page = await browser.newPage();

  /**
   * Every request the reader page makes, so the privacy claim is a measurement
   * rather than a sentence in a README. Extension resources and the object
   * URLs built from the archive are the only two things that may appear.
   */
  const offMachine = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      url.startsWith('chrome-extension://') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      url === 'about:blank'
    ) {
      return;
    }
    offMachine.push(url);
  });

  await page.goto(`chrome-extension://${id}/epub-reader.html`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(500);

  // 1. Open the book through the control a reader would use.
  const input = await page.$('#oit-epub-file');
  check(input !== null, 'the reader page has no file input');
  await input.uploadFile(bookPath);
  // Waited on the chapter counter rather than on the welcome pane: the pane is
  // hidden the moment the package file parses, which is several awaits before
  // the first chapter is on screen. Waiting on the wrong one read an empty
  // page and reported six failures for a reader that worked.
  await page.waitForFunction(
    () =>
      (document.getElementById('oit-epub-where')?.textContent ?? '') !== '' ||
      document.getElementById('oit-epub-error')?.hidden === false,
    { timeout: 15000 },
  );

  const opened = await page.evaluate(() => ({
    title: document.getElementById('oit-epub-title')?.textContent,
    where: document.getElementById('oit-epub-where')?.textContent,
    text: document.getElementById('oit-epub-content')?.innerText,
    contents: [
      ...document.querySelectorAll('#oit-epub-toc button, #oit-epub-toc span'),
    ].map((node) => node.textContent),
    depths: [...document.querySelectorAll('#oit-epub-toc li')].map(
      (node) => node.dataset.depth,
    ),
    image: (() => {
      const img = document.querySelector('#oit-epub-content img');
      return img
        ? { src: img.getAttribute('src'), width: img.naturalWidth }
        : null;
    })(),
    docTitle: document.title,
    error: document.getElementById('oit-epub-error')?.textContent,
  }));

  console.log(`opened: ${opened.title} — ${opened.where}`);
  if (opened.error) console.log(`reader error: ${opened.error}`);
  check(opened.title === 'Moby-Dick', `title read as ${opened.title}`);
  check(
    opened.text.includes('Call me Ishmael'),
    'the first chapter is not on the page',
  );
  check(
    opened.where.includes('1 / 3'),
    `chapter counter reads ${opened.where}`,
  );
  check(
    opened.contents.join('|') === 'The Whale|The Carpet-Bag|The Spouter-Inn',
    `contents read as ${opened.contents.join('|')}`,
  );
  check(
    opened.depths.join(',') === '0,1,0',
    `nesting read as ${opened.depths.join(',')}`,
  );
  check(opened.docTitle.startsWith('Moby-Dick'), 'the tab is not named');

  // 2. A picture that lives inside the archive.
  check(
    opened.image?.src?.startsWith('blob:'),
    `image src is ${opened.image?.src}`,
  );
  check(
    opened.image?.width === 1,
    `the image did not decode (naturalWidth ${opened.image?.width})`,
  );

  // 3. The book's own stylesheet is not applied. It says `display: none`, so
  //    if it ever were, the chapter would be invisible and every assertion
  //    above would still pass.
  const visible = await page.evaluate(() => {
    const first = document.querySelector('#oit-epub-content p');
    return first ? first.getBoundingClientRect().height > 0 : false;
  });
  check(visible, "the book's stylesheet reached the page");

  // 4. A link the book drew.
  await page.click('#oit-epub-content a[data-oit-epub-href]');
  await page.waitForFunction(
    () =>
      document
        .getElementById('oit-epub-content')
        ?.innerText.includes('Spouter-Inn'),
    { timeout: 5000 },
  );
  console.log('link: followed into chapter three');

  // 5. Contents and Next.
  await page.click('#oit-epub-toc-toggle');
  await page.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll('#oit-epub-toc button[data-spine-index]'),
    ];
    buttons[0]?.click();
  });
  await page.waitForFunction(
    () =>
      document
        .getElementById('oit-epub-content')
        ?.innerText.includes('Call me Ishmael'),
    { timeout: 5000 },
  );
  await page.click('#oit-epub-next');
  await page.waitForFunction(
    () =>
      document
        .getElementById('oit-epub-content')
        ?.innerText.includes('carpet-bag'),
    { timeout: 5000 },
  );
  console.log('contents and Next: both move the reader');

  // 6. The position is written down.
  const saved = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([key]) =>
      key.startsWith('epub-position:'),
    );
  });
  check(
    saved.length === 1 && saved[0][1].spineIndex === 1,
    `reading position stored as ${JSON.stringify(saved)}`,
  );

  // 7. Translate the chapter, with the real engine.
  const before = await page.evaluate(
    () => document.getElementById('oit-epub-content').innerText,
  );
  await page.click('#oit-epub-translate');
  await page.waitForFunction(
    () => document.querySelectorAll('.oit-bilingual').length > 0,
    { timeout: 180000 },
  );
  await sleep(2500);

  const translated = await page.evaluate(() => {
    const inserted = [...document.querySelectorAll('.oit-bilingual')];
    return {
      count: inserted.length,
      text: inserted.map((node) => node.innerText).join(' '),
      original: document.getElementById('oit-epub-content').innerText,
      button: document.getElementById('oit-epub-translate').textContent.trim(),
    };
  });
  console.log(
    `translated: ${translated.count} block(s) — ${translated.text.slice(0, 60)}`,
  );
  check(translated.count >= 2, `only ${translated.count} block(s) translated`);
  check(
    /[\u4e00-\u9fff]/.test(translated.text),
    'nothing that came back looks like Chinese',
  );
  check(
    translated.original.includes('carpet-bag'),
    'the original text did not survive the translation',
  );
  check(
    translated.button === 'Original',
    `the button still reads ${translated.button}`,
  );
  check(
    before.length < translated.original.length,
    'the chapter did not grow, so nothing was inserted into it',
  );

  // 8. And it follows the reader into the next chapter without being asked.
  await page.click('#oit-epub-next');
  await page.waitForFunction(
    () =>
      document
        .getElementById('oit-epub-content')
        ?.innerText.includes('Spouter-Inn'),
    { timeout: 5000 },
  );
  const followed = await page
    .waitForFunction(
      () => document.querySelectorAll('.oit-bilingual').length > 0,
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false);
  check(followed, 'the translation did not follow into the next chapter');
  console.log(`followed into the next chapter: ${followed}`);

  // 9. Nothing left the machine.
  check(
    offMachine.length === 0,
    `the reader made ${offMachine.length} request(s) off the machine: ${offMachine
      .slice(0, 5)
      .join(', ')}`,
  );
  console.log(`off-machine requests: ${offMachine.length}`);
} catch (error) {
  failures.push(`harness error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  chrome.kill();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nepub: all checks passed');
