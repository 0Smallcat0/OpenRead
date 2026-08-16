/**
 * Re-shoot every screenshot and the README clip, from the built extension.
 *
 * These assets used to be produced by scripts written in a scratch directory
 * and thrown away, which meant the only way to update a screenshot after a UI
 * change was to rediscover how to take it. Several of the discoveries were not
 * obvious and are recorded here as comments, because each one first arrived as
 * a plausible-looking picture of the wrong thing.
 *
 * Everything is captured on the default engine — Chrome's built-in translator,
 * nothing installed — because that is what a reader gets. Nothing is mocked:
 * the built extension is loaded into a real Chrome over CDP and driven with a
 * real mouse.
 *
 *   pnpm build
 *   pnpm shoot            # everything
 *   pnpm shoot gif        # just the README clip
 *   pnpm shoot readme     # the README stills
 *   pnpm shoot store      # the four Chrome Web Store screenshots
 *   pnpm shoot epubstore  # the fifth one: the EPUB reader, translated
 *
 * Environment override: OPENREAD_CHROME.
 *
 * Requires a network connection: the shots are of a live Wikipedia article
 * rather than a fixture, so what they show is a page the reader can go and
 * check.
 */
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME =
  process.env.OPENREAD_CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.OPENREAD_PORT ?? 9520);
const ARTICLE = 'https://en.wikipedia.org/wiki/Ollama';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = join(ROOT, '.output/chrome-mv3');
const SHOTS = join(ROOT, 'docs/screenshots');
const STORE_SHOTS = join(ROOT, 'docs/store/screenshots');


/**
 * A small public-domain EPUB, written here rather than downloaded.
 *
 * The other store shots use a real page on the real internet, deliberately —
 * what they show is somewhere the reader can go. A book cannot work that way:
 * the reader opens a file from the viewer's own disk, so there is no URL to
 * point at. Building one keeps the shot reproducible with no network, and the
 * text is Melville, so it is a book rather than lorem ipsum.
 */
function buildDemoEpub() {
  const utf8 = (text) => Buffer.from(text, 'utf8');
  const files = [];
  const add = (name, data, store = false) => files.push({ name, data, store });

  const chapters = [
    [
      'Loomings',
      '<p>Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation.</p><p>Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing before coffin warehouses, and bringing up the rear of every funeral I meet; then, I account it high time to get to sea as soon as I can.</p>',
    ],
    [
      'The Carpet-Bag',
      '<p>I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, and started for Cape Horn and the Pacific. Quitting the good city of old Manhatto, I duly arrived in New Bedford.</p>',
    ],
    [
      'The Spouter-Inn',
      '<p>Entering that gable-ended Spouter-Inn, you found yourself in a wide, low, straggling entry with old-fashioned wainscots, reminding one of the bulwarks of some condemned old craft.</p>',
    ],
  ];

  add('mimetype', utf8('application/epub+zip'), true);
  add(
    'META-INF/container.xml',
    utf8(
      '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>',
    ),
  );
  chapters.forEach(([title, body], i) =>
    add(
      'OEBPS/ch' + String(i) + '.xhtml',
      utf8(
        '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
          title +
          '</title></head><body><h1>' +
          title +
          '</h1>' +
          body +
          '</body></html>',
      ),
    ),
  );
  add(
    'OEBPS/nav.xhtml',
    utf8(
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>' +
        chapters
          .map(
            ([t], i) =>
              '<li><a href="ch' + String(i) + '.xhtml">' + t + '</a></li>',
          )
          .join('') +
        '</ol></nav></body></html>',
    ),
  );
  add(
    'OEBPS/content.opf',
    utf8(
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>Moby-Dick; or, The Whale</dc:title>\n    <dc:creator>Herman Melville</dc:creator>\n    <dc:identifier id="id">urn:uuid:openread-store-shot</dc:identifier>\n    <dc:language>en</dc:language>\n  </metadata>\n  <manifest>\n    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        chapters
          .map(
            (_, i) =>
              '\n    <item id="c' +
              String(i) +
              '" href="ch' +
              String(i) +
              '.xhtml" media-type="application/xhtml+xml"/>',
          )
          .join('') +
        '\n  </manifest>\n  <spine>' +
        chapters
          .map((_, i) => '\n    <itemref idref="c' + String(i) + '"/>')
          .join('') +
        '\n  </spine>\n</package>',
    ),
  );

  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, store } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const payload = store ? data : deflateRawSync(data);
    const sum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(sum, 16);
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

const wanted = new Set(process.argv.slice(2));
const doing = (name) => wanted.size === 0 || wanted.has(name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(EXTENSION)) {
  console.error(`No build at ${EXTENSION}. Run \`pnpm build\` first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });
mkdirSync(STORE_SHOTS, { recursive: true });

/**
 * A paper-shaped PDF, generated rather than checked in.
 *
 * The PDF shot has to be of the bundled viewer rendering something, and a real
 * paper cannot be committed to this repository. Eight lines of PDF operators
 * produce a page that looks like what someone would actually open.
 */
function paperPdf() {
  const lines = [
    'Bitcoin: A Peer-to-Peer Electronic Cash System',
    '',
    'Abstract. A purely peer-to-peer version of electronic cash would allow',
    'online payments to be sent directly from one party to another without',
    'going through a financial institution. Digital signatures provide part',
    'of the solution, but the main benefits are lost if a trusted third party',
    'is still required to prevent double-spending. We propose a solution to',
    'the double-spending problem using a peer-to-peer network.',
  ];
  const body = lines
    .map((line, i) =>
      line
        ? `BT /F1 ${i === 0 ? 15 : 11} Tf 72 ${String(700 - i * 26)} Td (${line}) Tj ET`
        : '',
    )
    .filter(Boolean)
    .join('\n');
  return `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${String(body.length)}>>stream
${body}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
}

/**
 * The lead paragraph's per-line rectangles, ending before the citations.
 *
 * Two things this avoids, both of which produced a convincing screenshot of
 * the wrong thing:
 *
 * A paragraph beside Wikipedia's floated infobox has a box wider than its
 * text — 723 px of box for 400 px of words, the rest sitting behind the float.
 * Dragging across a fraction of the *box* therefore ends inside the infobox
 * and selects that instead. Line rectangles from a Range are where the text
 * actually is.
 *
 * The line also runs past the last word into the `[1][2][3]` markers, and a
 * cursor resting on one opens Wikipedia's reference popup over our panel.
 * Ending the Range before the first superscript gives the one point that is
 * both past the last word and before the markers.
 */
const LINE_RECTS = () => {
  const p = document.querySelector('[data-shoot]');
  const range = document.createRange();
  range.selectNodeContents(p);
  const citation = p.querySelector('sup.reference, sup');
  if (citation) range.setEndBefore(citation);
  return [...range.getClientRects()]
    .filter((r) => r.width > 20 && r.height > 4)
    .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
};

/** Mark the lead paragraph and bring it into view. */
const MARK_PARAGRAPH = (nudge) => {
  const p = [...document.querySelectorAll('#mw-content-text p')].find(
    (x) =>
      !x.closest('table, .infobox, .navbox') &&
      (x.textContent ?? '').trim().length > 180,
  );
  p.setAttribute('data-shoot', '');
  // `auto`, not the skin's smooth default: a rectangle measured before a
  // smooth scroll settles is a rectangle the mouse never visits.
  p.scrollIntoView({ block: 'start', behavior: 'auto' });
  window.scrollBy(0, nudge);
};

const PANEL = () =>
  document.getElementById('oit-translate-panel')?.textContent ?? '';
const BADGE = () =>
  document.getElementById('oit-page-progress')?.textContent ?? '';

async function waitForPanel(page) {
  for (let i = 0; i < 40; i++) {
    const text = await page.evaluate(PANEL);
    if (text && !/Translating|Waiting|Downloading/i.test(text)) return;
    await sleep(400);
  }
}

async function waitForPage(page, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (/Done|Nothing|Gave up/.test(await page.evaluate(BADGE))) return;
    await sleep(1000);
  }
}

/** Select the marked paragraph with a real drag, then press the 文 icon. */
async function selectAndTranslate(page, { paced = false } = {}) {
  const lines = await page.evaluate(LINE_RECTS);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const endX = last.x + last.w - 1;
  const endY = last.y + last.h / 2;
  const startX = first.x + 3;
  const startY = first.y + first.h / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  if (paced) {
    // Hand-paced for the clip. Puppeteer's `steps` dispatches every move as
    // fast as the protocol allows, which at ten frames a second is a highlight
    // that appears in a single jump.
    const STEPS = 16;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      await page.mouse.move(
        startX + (endX - startX) * t,
        startY + (endY - startY) * t,
      );
      await sleep(70);
    }
  } else {
    await page.mouse.move(endX, endY, { steps: 24 });
  }
  await page.mouse.up();
  // Short: Wikipedia's reference popup has a hover delay, and this is the gap
  // in which it would fire.
  await sleep(260);

  const icon = await page.$('#oit-translate-icon');
  if (!icon) throw new Error('the 文 icon never appeared');
  const box = await icon.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  if (paced) await sleep(450);
  await page.mouse.down();
  await page.mouse.up();
  await waitForPanel(page);
}

/**
 * Encode JPEG frames into a GIF, inside the browser.
 *
 * The browser is used as the codec because it already has a JPEG decoder and a
 * canvas; gifenc is bundled to an IIFE and evaluated in a blank page.
 */
async function encodeGif(browser, gifenc, frames, size, delay) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.evaluate(gifenc);
  const result = await page.evaluate(
    async (jpegs, width, height, frameDelay) => {
      const { GIFEncoder, quantize, applyPalette } = globalThis.gifenc;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const decode = async (jpeg) => {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${jpeg}`;
        await img.decode();
        ctx.drawImage(img, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height).data;
      };

      // Collapse the still stretches.
      //
      // gifenc writes every frame in full, with no inter-frame differencing, so
      // a second of a motionless page costs exactly as much as a second of the
      // drag. Frames that barely differ from the last one written are dropped
      // and their time is added to it instead: 4.1 MB became 1.5 MB at the same
      // speed. The threshold is low on purpose and relative to frame area — one
      // more highlighted line changes a small fraction of the picture, and at a
      // coarser setting the drag survived as four jumps.
      const kept = [];
      let previous = null;
      for (const jpeg of jpegs) {
        const data = await decode(jpeg);
        let moved = true;
        if (previous) {
          let sum = 0;
          for (let i = 0; i < data.length; i += 16) {
            sum += Math.abs(data[i] - previous[i]);
          }
          moved = sum / (data.length / 16) > 0.045;
        }
        if (moved) {
          kept.push({ data, delay: frameDelay });
          previous = data;
        } else if (kept.length) {
          kept[kept.length - 1].delay += frameDelay;
        }
      }

      // One palette for the whole clip — a per-frame palette makes flat areas
      // shimmer — sampled from the start, the middle and the end together.
      // Quantizing the first frame alone leaves no colours for the highlight
      // and the panel, which arrive later.
      const samples = [0, Math.floor(kept.length / 2), kept.length - 1].map(
        (i) => kept[i].data,
      );
      const merged = new Uint8ClampedArray(
        samples.reduce((n, s) => n + s.length, 0),
      );
      let at = 0;
      for (const s of samples) {
        merged.set(s, at);
        at += s.length;
      }
      const palette = quantize(merged, 128);

      const gif = GIFEncoder();
      kept.forEach((frame, i) => {
        gif.writeFrame(applyPalette(frame.data, palette), width, height, {
          palette,
          // Hold the finished translation before the loop starts over.
          delay: i === kept.length - 1 ? 2200 : frame.delay,
        });
      });
      gif.finish();
      const bytes = gif.bytes();
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return { data: btoa(binary), frames: kept.length };
    },
    frames,
    size.width,
    size.height,
    delay,
  );
  await page.close();
  return result;
}

const written = [];
function record(path, bytes) {
  written.push(
    `${path.replace(ROOT, '').replace(/\\/g, '/')}${
      bytes ? ` (${String(Math.round(bytes / 1024))} KB)` : ''
    }`,
  );
  console.log(`  wrote ${path.replace(ROOT, '').replace(/\\/g, '/')}`);
}

const docs = mkdtempSync(join(tmpdir(), 'openread-shoot-'));
const pdfPath = join(docs, 'paper.pdf');
writeFileSync(pdfPath, paperPdf(), 'latin1');

const profile = mkdtempSync(join(tmpdir(), 'openread-shoot-profile-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${String(PORT)}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--window-size=1360,940',
    '--window-position=0,0',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browser;
let failed = false;
try {
  await sleep(3500);
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${String(PORT)}`,
    defaultViewport: null,
  });
  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
  await sleep(2000);

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    target = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().includes(id));
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('the extension service worker never appeared');
  const worker = await target.worker();
  console.log(
    `OpenRead ${await worker.evaluate(() => chrome.runtime.getManifest().version)}\n`,
  );
  await worker.evaluate(async () =>
    chrome.storage.sync.set({
      engine: 'builtin',
      targetLang: 'Traditional Chinese',
      obsidianVault: 'Reading',
      obsidianFolder: 'OpenRead',
    }),
  );
  const tabFor = async (match) =>
    worker.evaluate(async (m) => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => (t.url ?? '').includes(m)).pop()?.id ?? null;
    }, match);
  const translatePage = async (match) => {
    const tabId = await tabFor(match);
    if (tabId === null) throw new Error(`no tab matching ${match}`);
    await worker.evaluate(
      async (i) => chrome.tabs.sendMessage(i, { type: 'TRANSLATE_PAGE' }),
      tabId,
    );
  };

  // Warm the language pair first, so no shot is of a one-time download.
  const warm = await browser.newPage();
  await warm.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await warm.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await translatePage('/wiki/Ollama');
  await waitForPage(warm);
  console.log('  language pack warm\n');

  // ---- README stills -------------------------------------------------------
  if (doing('readme')) {
    // The warm run already translated this page; it is the whole-page still.
    await warm.evaluate(MARK_PARAGRAPH, -120);
    await sleep(1500);
    const fullpage = join(SHOTS, 'demo-fullpage.png');
    await warm.screenshot({ path: fullpage });
    record(fullpage);

    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(1200);
    const popupSize = await popup.evaluate(() => ({
      w: Math.ceil(document.body.getBoundingClientRect().width),
      h: Math.ceil(document.body.scrollHeight),
    }));
    await popup.setViewport({
      width: popupSize.w,
      height: popupSize.h,
      deviceScaleFactor: 2,
    });
    await sleep(400);
    const popupShot = join(SHOTS, 'popup.png');
    await popup.screenshot({ path: popupShot });
    record(popupShot);
    await popup.close();

    const pdf = await browser.newPage();
    await pdf.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await pdf.goto(pathToFileURL(pdfPath).href, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(5500);
    const line = await pdf.evaluate(() => {
      const span =
        [...document.querySelectorAll('.textLayer span')].find((s) =>
          /purely peer-to-peer/.test(s.textContent ?? ''),
        ) ?? document.querySelector('.textLayer span');
      const r = span.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await pdf.mouse.move(line.x + 2, line.y + line.h / 2);
    await pdf.mouse.down();
    await pdf.mouse.move(line.x + line.w - 4, line.y + line.h * 3.4, {
      steps: 20,
    });
    await pdf.mouse.up();
    await sleep(600);
    const pdfIcon = await pdf.$('#oit-translate-icon');
    if (pdfIcon) {
      const box = await pdfIcon.boundingBox();
      await pdf.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pdf.mouse.down();
      await pdf.mouse.up();
    }
    await waitForPanel(pdf);
    await pdf.mouse.move(1240, 760);
    await sleep(600);
    const pdfShot = join(SHOTS, 'demo-pdf.png');
    // Cropped: below the panel the page is empty, and empty page is not
    // information.
    await pdf.screenshot({
      path: pdfShot,
      clip: { x: 0, y: 0, width: 1280, height: 700 },
    });
    record(pdfShot);
    await pdf.close();
  }
  await warm.close();

  // ---- the README clip -----------------------------------------------------
  if (doing('gif')) {
    // A selection, not whole-page. Whole-page reflows the document on every
    // insertion — roughly ten times a second with two requests in flight — so
    // the entire viewport jumps in every frame, which reads as a convulsion
    // rather than a feature. A selection does not move the page at all: the
    // panel is an overlay.
    //
    // The window is sized to the shot rather than cropped afterwards. Cropping
    // a wider capture cut through the infobox and through the body text below
    // the panel, leaving orphan half-words down the right-hand edge.
    const size = { width: 880, height: 700 };
    const stage = await browser.newPage();
    await stage.setViewport({ ...size, deviceScaleFactor: 1 });
    await stage.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    // High in the frame: the panel opens below the selection, and a centred
    // paragraph put its buttons off the bottom edge.
    await stage.evaluate(MARK_PARAGRAPH, -135);
    await sleep(2500);

    // Timer-driven capture on its own CDP session, so a steady frame rate is
    // recorded while the page session is busy with the drag.
    // `Page.startScreencast` only fires on repaint, which gave three frames a
    // second and a clip that stuttered.
    const capture = await stage.createCDPSession();
    const frames = [];
    let recording = true;
    const recorder = (async () => {
      while (recording && frames.length < 90) {
        const started = Date.now();
        try {
          const { data } = await capture.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 84,
          });
          frames.push(data);
        } catch {
          break;
        }
        await sleep(Math.max(0, 90 - (Date.now() - started)));
      }
    })();

    const startedAt = Date.now();
    await sleep(600);
    await selectAndTranslate(stage, { paced: true });
    // Park the cursor away from the citation markers, then hold on the result.
    await stage.mouse.move(24, 600);
    await sleep(2000);
    recording = false;
    await recorder;

    // Screenshot capture is slower than the interval asked for, so the frame
    // delay is derived from how long the clip actually took.
    const perFrame = Math.round(
      (Date.now() - startedAt) / Math.max(1, frames.length),
    );
    const bundled = await build({
      entryPoints: [join(ROOT, 'node_modules/gifenc/dist/gifenc.esm.js')],
      bundle: true,
      format: 'iife',
      globalName: 'gifenc',
      write: false,
    });
    const gif = await encodeGif(
      browser,
      bundled.outputFiles[0].text,
      frames,
      { width: 760, height: 605 },
      perFrame,
    );
    const bytes = Buffer.from(gif.data, 'base64');
    const gifPath = join(SHOTS, 'demo.gif');
    writeFileSync(gifPath, bytes);
    console.log(
      `  ${String(frames.length)} frames at ${String(perFrame)} ms, ${String(gif.frames)} kept`,
    );
    record(gifPath, bytes.length);
    await stage.close();
  }

  // ---- Chrome Web Store screenshots ---------------------------------------
  if (doing('store')) {
    // Exactly 1280x800, which the store requires — emulated at that size
    // rather than cropped from whatever the window happened to be.
    const STORE = { width: 1280, height: 800, deviceScaleFactor: 1 };

    // The first screenshot is what a browser shows in search results, so it
    // leads with whole-page bilingual translation.
    const one = await browser.newPage();
    await one.setViewport(STORE);
    await one.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await translatePage('/wiki/Ollama');
    await waitForPage(one);
    await one.evaluate(MARK_PARAGRAPH, -120);
    await sleep(1500);
    const shot1 = join(STORE_SHOTS, 'screenshot-1-translate-web.png');
    await one.screenshot({ path: shot1 });
    record(shot1);
    await one.close();

    const two = await browser.newPage();
    await two.setViewport(STORE);
    await two.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    // Enough headroom for the article title: at a smaller nudge the frame
    // opens on a sliver of half-cut tab bar.
    await two.evaluate(MARK_PARAGRAPH, -150);
    await sleep(2500);
    await selectAndTranslate(two);
    await two.mouse.move(40, 780);
    await sleep(900);
    const shot2 = join(STORE_SHOTS, 'screenshot-2-select-icon.png');
    await two.screenshot({ path: shot2 });
    record(shot2);
    await two.close();

    const three = await browser.newPage();
    await three.setViewport(STORE);
    await three.goto(pathToFileURL(pdfPath).href, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(5500);

    // Whole-document translation, not a selection: selecting text is already
    // screenshot two, and a store listing that spends two of its four frames on
    // the same gesture is describing a smaller product than it has. Each page's
    // translation is placed under the page, so the shot has to show both — the
    // paper as the author set it, and that page in the reader's language.
    await three.bringToFront();
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id !== undefined)
        await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
    });
    for (let waited = 0; waited < 240000; waited += 2000) {
      await sleep(2000);
      const done = await three.evaluate(
        () =>
          document.querySelectorAll('.oit-pdf-translation').length > 0 &&
          !(
            document.getElementById('oit-page-progress')?.textContent ?? ''
          ).startsWith('Translating'),
      );
      if (done) break;
    }
    // Zoomed out first. The fixture page is a full sheet carrying eight lines
    // at the top, so at the viewer's default scale the seam between page and
    // translation sits below a hand's width of blank paper — the first attempt
    // at this shot was 80% empty white. Half scale puts the paper's own text
    // and its translation in one frame, which is the only arrangement that
    // shows where a translation goes.
    await three.evaluate(() => {
      const app = window.PDFViewerApplication;
      if (app?.pdfViewer) app.pdfViewer.currentScaleValue = '0.5';
    });
    await sleep(1500);
    await three.evaluate(() => {
      const container = document.getElementById('viewerContainer');
      if (container) container.scrollTop = 0;
    });
    await sleep(1200);
    await three.mouse.move(1240, 760);
    await sleep(600);
    const shot3 = join(STORE_SHOTS, 'screenshot-3-pdf.png');
    await three.screenshot({ path: shot3 });
    record(shot3);
    await three.close();

    const four = await browser.newPage();
    await four.setViewport(STORE);
    await four.goto(`chrome-extension://${id}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(1500);
    // The popup document is ~350 px wide, so it is centred in the required
    // frame rather than stranded in a corner. Placement only — the UI is the
    // real popup.
    await four.evaluate(() => {
      document.documentElement.style.cssText =
        'display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111827';
      document.body.style.cssText +=
        ';border-radius:12px;box-shadow:0 10px 40px rgb(0 0 0 / .5)';
    });
    await sleep(600);
    const shot4 = join(STORE_SHOTS, 'screenshot-4-popup.png');
    await four.screenshot({ path: shot4 });
    record(shot4);
    await four.close();
  }

  if (doing('epubstore')) {
    // The fifth store shot. The listing describes a book reader that none of
    // the other four show, and a listing describing more than its pictures do
    // is a listing asking to be disbelieved.
    const STORE5 = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const bookDir = mkdtempSync(join(tmpdir(), 'openread-shot-book-'));
    const bookPath = join(bookDir, 'moby-dick.epub');
    writeFileSync(bookPath, buildDemoEpub());

    const five = await browser.newPage();
    await five.setViewport(STORE5);
    await five.goto(`chrome-extension://${id}/epub-reader.html`, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(800);
    const picker = await five.$('#oit-epub-file');
    if (!picker) throw new Error('the reader page has no file input');
    await picker.uploadFile(bookPath);
    await five.waitForFunction(
      () =>
        (document.getElementById('oit-epub-where')?.textContent ?? '') !== '',
      { timeout: 20000 },
    );
    // Contents open, because the sidebar is half of what makes this a reader
    // rather than a page with a book pasted into it.
    await five.click('#oit-epub-toc-toggle');
    await sleep(400);
    await five.click('#oit-epub-translate');
    for (let waited = 0; waited < 240000; waited += 2000) {
      await sleep(2000);
      const done = await five.evaluate(
        () =>
          document.querySelectorAll('.oit-bilingual').length > 0 &&
          !(
            document.getElementById('oit-page-progress')?.textContent ?? ''
          ).startsWith('Translating'),
      );
      if (done) break;
    }
    // The badge says "Done — n translated" and then takes itself away; waiting
    // it out keeps a transient status bubble out of a permanent screenshot.
    await five
      .waitForFunction(
        () => document.getElementById('oit-page-progress') === null,
        { timeout: 12000 },
      )
      .catch(() => undefined);
    await five.mouse.move(1240, 760);
    await sleep(500);
    const shot5 = join(STORE_SHOTS, 'screenshot-5-epub.png');
    await five.screenshot({ path: shot5 });
    record(shot5);
    await five.close();
  }
} catch (error) {
  failed = true;
  console.error(error?.stack ?? String(error));
} finally {
  await browser?.disconnect();
  chrome.kill();
}

console.log(`\n${String(written.length)} assets:\n  ${written.join('\n  ')}`);
process.exit(failed ? 1 : 0);
