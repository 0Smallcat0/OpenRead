/**
 * Background service worker: the streaming translation broker and PDF router.
 *
 * - Streams: one long-lived `stream-translate` port per active translation.
 *   Each port owns a single AbortController; a new START_STREAM cancels the
 *   previous request, and a disconnect aborts in-flight work. The Ollama base
 *   URL is loaded from storage here; inference runs on the user's machine.
 * - PDF routing: `.pdf` navigations are redirected into the bundled viewer.
 * - EPUB routing: `.epub` navigations are redirected into the reader page.
 */
import { translateStream, enrichText } from '../api/ollama';
import { loadSettings } from '../settings';
import {
  translateBuiltin,
  BuiltinUnavailableError,
  packAvailability,
  downloadPack,
  PACK_STALL_MS,
} from '../api/builtin';
import { toBcp47 } from '../core/bcp47';
import { buildOriginStripRule, ORIGIN_STRIP_RULE_ID } from '../core/dnr-rule';
import { describeEngineFailure } from '../core/diagnostics';
import {
  parseGlossary,
  protectTerms,
  restoreTerms,
  type ProtectedText,
} from '../core/glossary';
import {
  STREAM_PORT_NAME,
  TRANSLATE_SELECTION_COMMAND,
  TRANSLATE_PAGE_COMMAND,
  TRANSLATE_INPUT_COMMAND,
  type PortRequest,
  type RuntimeRequest,
  type EnrichCaptureResponse,
  type PackProgressResponse,
  type StreamResponse,
} from '../messaging';

export default defineBackground(() => {
  const viewerUrl = chrome.runtime.getURL('pdfjs/web/viewer.html');

  function isPdfUrl(url: string): boolean {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.pdf');
    } catch {
      return false;
    }
  }

  /**
   * Send one tab into the bundled viewer.
   *
   * `known` skips the URL test for a caller that has already established this
   * is a PDF by better means than its address — see `OPEN_IN_VIEWER`. The
   * extension check is a guess and a poor one: arxiv.org serves papers from
   * `/pdf/1706.03762`, with no extension anywhere in it, so the guess left the
   * best-known source of papers on the internet in Chrome's own viewer, where
   * this extension can do nothing at all.
   */
  async function routeToViewer(
    tabId: number,
    url: string,
    known = false,
  ): Promise<void> {
    if ((!known && !isPdfUrl(url)) || url.startsWith(viewerUrl)) return;
    if (url.startsWith('file://')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!allowed) return;
    }
    await chrome.tabs.update(tabId, {
      url: `${viewerUrl}?file=${encodeURIComponent(url)}`,
    });
  }

  const readerUrl = chrome.runtime.getURL('epub-reader.html');

  function isEpubUrl(url: string): boolean {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.epub');
    } catch {
      return false;
    }
  }

  /**
   * Send one tab into the EPUB reader.
   *
   * Best-effort, and unlike the PDF route it is not the main way in. Chrome
   * has no EPUB viewer, so it answers most `.epub` links by downloading the
   * file rather than by navigating to it — and a download never becomes a tab
   * for this to catch. The routes that always work are the popup's button and
   * dropping the file onto the reader, which is also why the reader opens with
   * a page that says so.
   */
  async function routeToReader(tabId: number, url: string): Promise<void> {
    if (!isEpubUrl(url) || url.startsWith(readerUrl)) return;
    if (url.startsWith('file://')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!allowed) return;
    }
    await chrome.tabs.update(tabId, {
      url: `${readerUrl}?file=${encodeURIComponent(url)}`,
    });
  }

  // Auto-redirect PDF navigations into the vendored PDF.js viewer, and EPUB
  // navigations into the reader.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading' || !tab.url) return;
    void routeToViewer(tabId, tab.url);
    void routeToReader(tabId, tab.url).catch(() => undefined);
  });

  /**
   * The listener above only sees navigations that happen while this worker is
   * alive. Open the browser straight onto a PDF — a restored session, or a .pdf
   * link clicked from outside Chrome — and the navigation is already past
   * `loading` by the time MV3 gets around to starting the worker, so the tab
   * stays in Chrome's own viewer. Measured: launching with a PDF as the startup
   * page landed in the built-in viewer every time, while browsing first and then
   * opening the same PDF worked. Sweeping the open tabs on wake covers the gap.
   */
  function routeExistingPdfTabs(): void {
    void (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined || !tab.url) continue;
        await routeToViewer(tab.id, tab.url).catch(() => undefined);
      }
    })();
  }
  /**
   * Let this extension reach Ollama without the user configuring anything.
   *
   * Ollama 403s any request whose Origin it does not know, and an extension's
   * origin is never on its list, so every install used to begin with an
   * OLLAMA_ORIGINS environment variable and a server restart. The rule strips
   * the header from this extension's own requests to the configured server
   * only; see `core/dnr-rule.ts` for why that does not also hand every web
   * page an unauthenticated local model.
   *
   * Session-scoped rather than dynamic: it is cheap to rebuild, and a rule
   * that outlives the browser would keep pointing at a server the user may
   * have since changed.
   */
  async function applyOriginStripRule(): Promise<void> {
    // Guarded, and not for tidiness. This is the one call in the worker that
    // runs before anything else and whose failure is silent: it threw,
    // `originRuleReady` became a rejected promise, and every request begins by
    // awaiting it *outside* its try — so the rejection escaped the handler,
    // nothing was posted back to the port, and a translation ran forever with
    // no error to show. That is how the Firefox build managed to be incapable
    // of translating anything from 2.5.0 until 2.21.0 without one report:
    // Firefox's MV2 has no `declarativeNetRequest` at all. Firefox is no longer
    // a target, and the guard stays, because the shape of that failure does not
    // depend on which browser produced it — a quota error or a rejected rule on
    // Chrome would do the same.
    //
    // Failing to install the rule is survivable on its own terms: it removes
    // the OLLAMA_ORIGINS setup step, so without it a user is back to that step
    // rather than out of options. Worth a console warning and nothing more.
    const rules = chrome.declarativeNetRequest as
      typeof chrome.declarativeNetRequest | undefined;
    if (typeof rules?.updateSessionRules !== 'function') return;
    try {
      const { baseUrl } = await loadSettings();
      const rule = buildOriginStripRule(baseUrl);
      await rules.updateSessionRules({
        removeRuleIds: [ORIGIN_STRIP_RULE_ID],
        addRules: rule ? [rule] : [],
      });
    } catch (error) {
      console.warn(
        'OpenRead could not install the Origin-strip rule; Ollama may need OLLAMA_ORIGINS.',
        error,
      );
    }
  }

  /**
   * Resolves once the rule is in force. Every outbound request waits on it.
   *
   * Installing the rule is asynchronous, and an MV3 worker starts cold — it is
   * woken *by* the first request, so without this the request that woke it can
   * reach the network first and take a 403 the user did nothing to deserve.
   * Caught by the browser harness against a stock server: with two blocks in
   * flight, exactly the first one failed. Awaiting a settled promise costs
   * nothing on every request after the first.
   */
  let originRuleReady = applyOriginStripRule();

  chrome.runtime.onStartup.addListener(() => {
    originRuleReady = applyOriginStripRule();
  });
  chrome.runtime.onInstalled.addListener(() => {
    originRuleReady = applyOriginStripRule();
  });
  /**
   * The pair fetched ahead of time.
   *
   * A source language is not knowable before there is a page, and English is
   * what the great majority of what this extension gets pointed at is written
   * in. Guessing wrong costs a download the user did not need; not guessing at
   * all costs every user the wait below.
   */
  const PREFETCH_SOURCE = 'en';

  let packKeepAlive: ReturnType<typeof setInterval> | undefined;
  /** How many downloads are counting on the worker staying up. */
  let packHolds = 0;
  /** Set while the install-time fetch is running, for the popup to read. */
  let packPrefetching = false;

  /**
   * Hold the worker open until the pack has landed, and say when to let go.
   *
   * Interrupting one of these downloads is not free, and it is not merely a
   * lost minute. Measured: `en`→`ko` on a profile that had never asked came
   * down in 82 seconds — 352 MB at the connection's full 4 MB/s. The same
   * request, killed partway and made again, does not resume and does not
   * restart; it sits at zero bytes for as long as anyone is willing to watch.
   * A pair can be spoiled this way, and once it is, the wait stops being a
   * wait and becomes a permanent failure.
   *
   * MV3 recycles a worker after 30 s of idle, and a pending web-platform
   * promise is not activity — only a `chrome.*` call resets that clock. So
   * every path that can start a pack download has to keep the worker up until
   * it finishes: the install-time prefetch, which has no page at all, and a
   * translation, whose port dies with the tab the reader closes while waiting.
   *
   * Counted rather than a boolean: the prefetch and a translation can be
   * waiting on different pairs at once, and the first to finish must not drop
   * the other one's worker.
   */
  /**
   * How long the worker is kept up for a download whose reader has gone.
   *
   * Generous on purpose: the whole point is to outlast the download, and the
   * cost of being wrong in this direction is a `getPlatformInfo()` every 20 s
   * for a few minutes. Being wrong in the other direction costs the user the
   * entire pack and three minutes on top. Ten minutes covers 352 MB on any
   * connection this extension is usable on, and one Chrome stall-and-restart
   * cycle besides.
   */
  const PACK_GRACE_MS = 600_000;

  /** Let go of a hold after `ms`, rather than at the end of this turn. */
  function keepAliveFor(release: () => void, ms: number): void {
    setTimeout(release, ms);
  }

  function holdWorkerOpen(): () => void {
    packHolds += 1;
    packKeepAlive ??= setInterval(() => {
      void chrome.runtime.getPlatformInfo();
    }, 20_000);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      packHolds -= 1;
      if (packHolds <= 0 && packKeepAlive !== undefined) {
        clearInterval(packKeepAlive);
        packKeepAlive = undefined;
        packHolds = 0;
      }
    };
  }

  /**
   * How far the prefetch has got, for the popup to read.
   *
   * `Translator.availability()` cannot be asked this: it answers
   * `downloadable` throughout a download it is itself performing. Without a
   * number kept here, a popup opened two minutes after install reports that
   * nothing has been downloaded yet and offers a button to start what is
   * already running.
   */
  let packLoaded = 0;

  /** Why the last prefetch gave up, for the popup to pass on. */
  let packProblem: string | null = null;

  /**
   * The toolbar icon, while the pack is on its way.
   *
   * The one surface a user who has just installed something is already looking
   * at, and until now this extension never wrote to it. Everything else that
   * reports the download — the corner badge, the popup's banner — needs the
   * user to press something or open something first, which is the wrong order:
   * the thing they need to know is that pressing anything is pointless for the
   * next few minutes.
   *
   * Guarded because `chrome.action` is undefined in the jsdom stubs, and
   * because failing to draw a badge is not worth failing a download over.
   */
  function paintBadge(text: string, title: string): void {
    try {
      void chrome.action?.setBadgeText?.({ text });
      void chrome.action?.setTitle?.({ title });
    } catch {
      // A browser that disagrees about the action API. Nothing is lost.
    }
  }

  /**
   * Get this pair onto the disk, and see it through.
   *
   * The one place in the extension that starts a language-pack download, and
   * deliberately so. Left alone, the download is not the problem: `en`→`ko` on
   * a profile that had never asked came down in 82 seconds — 352 MB at the
   * connection's full 4 MB/s. Interrupting it is the problem. `en`→`fr` killed
   * at 85 MB and asked for again sat at nothing for three minutes, then Chrome
   * deleted the 85 MB and started over, finishing at 436 seconds. There is no
   * resume, and the penalty is paid again on every interruption — which is how
   * a minute and a half becomes an extension that never works for somebody who
   * pressed translate twice and closed the tab twice.
   *
   * So: started before anyone can be waiting on it, held by the worker rather
   * than by a page or a popup that can be closed, and kept off MV3's reaper
   * until it lands. `Translator.create()` needs a user gesture in a document
   * but not in a service worker (see `downloadPack`), which is what makes the
   * worker the right owner rather than merely a convenient one. The pack is
   * browser-wide, so paying for it here means every later context finds it.
   *
   * One at a time. Two downloads share one connection and finish later than
   * they would in sequence, and a second caller finding this busy is almost
   * always the same pair arriving from a different door.
   */
  async function ensurePack(source: string, target: string): Promise<void> {
    if (packPrefetching) return;
    const availability = await packAvailability(source, target);
    if (availability !== 'downloadable') return;

    /**
     * A translation started from a page holds a `stream-translate` port open,
     * and an open port is what keeps an MV3 worker from being recycled. A
     * download started at install has neither port nor page — only a pending
     * web-platform promise, which does not count against the idle timer. A
     * `chrome.*` call is what resets it, and the timer is 30 s.
     */
    packLoaded = 0;
    packProblem = null;
    const pair = `${source} → ${target}`;
    // No percentage to open with: Chrome's monitor fired 479 times for one
    // pair and exactly twice for another, so "0%" would sit there looking
    // stuck for the part of the download that most needs not to.
    paintBadge('↓', `OpenRead is downloading the ${pair} translation model.`);
    packPrefetching = true;
    const release = holdWorkerOpen();
    try {
      await downloadPack(
        source,
        target,
        (loaded) => {
          packLoaded = loaded;
          const percent = Math.round(loaded * 100);
          if (percent > 0) {
            paintBadge(
              `${String(percent)}%`,
              `OpenRead is downloading the ${pair} translation model — ` +
                `${String(percent)}% done. Translation works the moment it ` +
                `lands.`,
            );
          }
        },
        // The long fuse: nothing is waiting on this one, and Chrome's own
        // recovery from a stall takes about three minutes of total silence.
        PACK_STALL_MS,
      );
      paintBadge('', `OpenRead — ready to translate ${pair}.`);
    } catch (error) {
      // Kept rather than only logged. `BuiltinUnavailableError` from here is
      // the stall message, which names the three things worth checking; a
      // warning in a console the user will never open is not a report.
      packProblem = error instanceof Error ? error.message : String(error);
      // The badge stays, deliberately. A download that gave up is the state
      // most worth noticing, and clearing the icon would hide it behind a
      // popup the user has no reason to open.
      paintBadge('!', `OpenRead: ${packProblem}`);
      console.warn(
        'OpenRead could not fetch the language pack ahead of time.',
        error,
      );
    } finally {
      packPrefetching = false;
      release();
    }
  }

  /** The pair the settings imply, for the install-time fetch. */
  async function prefetchPack(): Promise<void> {
    const { engine, targetLang } = await loadSettings();
    if (engine !== 'builtin') return;
    const target = toBcp47(targetLang);
    // A language only Ollama serves. Nothing to fetch.
    if (!target) return;
    await ensurePack(PREFETCH_SOURCE, target);
  }

  chrome.runtime.onInstalled.addListener(() => void prefetchPack());
  // Also the resume path: an interrupted download is not resumed. Chrome sits
  // on it for about three minutes, deletes what it had and starts over —
  // measured at 85 MB thrown away — so the next start has to ask again.
  chrome.runtime.onStartup.addListener(() => void prefetchPack());

  // Pointing the extension at a different server has to move the rule with it,
  // or the new server answers 403 and the old one stays reachable.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('baseUrl' in changes) {
      originRuleReady = applyOriginStripRule();
    }
    // Changing the target language, or switching back to the built-in engine,
    // names a pack that is not on disk yet — the same wait as a fresh install,
    // and the same answer.
    if ('targetLang' in changes || 'engine' in changes) {
      void prefetchPack();
    }
  });

  chrome.runtime.onStartup.addListener(routeExistingPdfTabs);
  chrome.runtime.onInstalled.addListener(routeExistingPdfTabs);

  // Keyboard shortcut: a selection made with the keyboard produces no mouseup,
  // so the floating 文 icon is not a route a keyboard user can take. Broadcast
  // to every frame in the active tab; only the one holding a selection acts.
  chrome.commands?.onCommand.addListener((command) => {
    const message: RuntimeRequest | null =
      command === TRANSLATE_SELECTION_COMMAND
        ? { type: 'TRANSLATE_SELECTION' }
        : command === TRANSLATE_PAGE_COMMAND
          ? { type: 'TRANSLATE_PAGE' }
          : command === TRANSLATE_INPUT_COMMAND
            ? { type: 'TRANSLATE_INPUT' }
            : null;
    if (!message) return;
    void (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return;
      // No receiver in a frame without our content script; that is expected.
      await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    })();
  });

  /**
   * Right-click entry points.
   *
   * The whole-page feature shipped reachable only from the toolbar popup and
   * a keyboard shortcut — which, it turned out, Chrome had never assigned.
   * Neither is where anyone looks in any case. A user with the
   * extension installed opened the context menu, found Chrome's own translate
   * item and not this one, and asked where the feature had gone — which is the
   * answer to whether a popup button counts as discoverable.
   *
   * Two items, so the menu offers whichever one matches what is under the
   * cursor: a selection, or the page.
   */
  const MENU_PAGE = 'openread-translate-page';
  const MENU_INPUT = 'openread-translate-input';
  const MENU_SELECTION = 'openread-translate-selection';

  function createMenus(): void {
    // Rebuild rather than add: the worker can restart at any time, and
    // `create` on an id that already exists is an error.
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_SELECTION,
        title: 'Translate selection with OpenRead',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: 'Translate this page with OpenRead',
        contexts: ['page'],
      });
      // Right-click, not only Ctrl+Shift+K. A command is reachable exactly as
      // far as Chrome's willingness to bind its key, and that willingness is
      // neither documented nor stable — `translate-page` shipped with an
      // unbound shortcut for several releases without anything saying so. A
      // feature with one route in has none the day that route fails.
      chrome.contextMenus.create({
        id: MENU_INPUT,
        title: 'Translate what you typed with OpenRead',
        contexts: ['editable'],
      });
      // `create` reports failures here rather than throwing.
      void chrome.runtime.lastError;
    });
  }

  createMenus();
  chrome.runtime.onInstalled.addListener(createMenus);

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    const message: RuntimeRequest | null =
      info.menuItemId === MENU_SELECTION
        ? { type: 'TRANSLATE_SELECTION' }
        : info.menuItemId === MENU_PAGE
          ? { type: 'TRANSLATE_PAGE' }
          : info.menuItemId === MENU_INPUT
            ? { type: 'TRANSLATE_INPUT' }
            : null;
    if (!message || tab?.id === undefined) return;
    // No receiver on a page without our content script; that is expected.
    void chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
  });

  // Streaming translation broker.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== STREAM_PORT_NAME) return;
    let controller: AbortController | null = null;

    const post = (message: StreamResponse): void => {
      try {
        port.postMessage(message);
      } catch {
        // Port already closed by the other side — nothing to do.
      }
    };

    port.onMessage.addListener((message: PortRequest) => {
      if (message.type !== 'START_STREAM') return;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      void (async () => {
        const { engine, baseUrl, glossary } = await loadSettings();

        // The glossary, applied here rather than in either engine, because it
        // is a property of what the user wants translated and not of what
        // translates it. Both paths below run through `withGlossary`.
        const entries = parseGlossary(glossary);
        const hidden =
          entries.length > 0 ? protectTerms(message.text, entries) : null;
        // A block that is *only* a protected term leaves nothing behind to
        // translate, and language detection on `[[0]]` fails outright — which
        // would surface as "Could not tell what language this is written in"
        // on a line that needed no translating in the first place.
        const remaining = hidden?.text.replace(/\[\[\s*\d+\s*\]\]/g, ' ') ?? '';
        const guarded: ProtectedText | null =
          hidden && hidden.values.length > 0 && /\p{L}/u.test(remaining)
            ? hidden
            : null;

        /**
         * Run one engine, with the glossary's terms hidden while it works.
         *
         * Streaming is given up for exactly the blocks a glossary touches: the
         * placeholder that comes back has to be swapped for the term before the
         * text is shown, and a chunk boundary can land in the middle of one.
         * Blocks with no glossary term in them stream as before, so the cost is
         * paid only where the feature is used.
         */
        const withGlossary = async (
          run: (
            text: string,
            onChunk: (chunk: string) => void,
          ) => Promise<void>,
        ): Promise<void> => {
          if (!guarded) {
            await run(message.text, (chunk) =>
              post({ status: 'streaming', chunk }),
            );
            return;
          }
          let buffered = '';
          await run(guarded.text, (chunk) => (buffered += chunk));
          if (signal.aborted) return;
          const restored = restoreTerms(buffered, guarded);
          if (restored.complete) {
            post({ status: 'streaming', chunk: restored.text });
            return;
          }
          // A placeholder did not survive, so the term is missing from the
          // sentence rather than merely translated. Translating again without
          // protection costs a second call and gives the reader a translated
          // term, which is the lesser of the two losses.
          let plain = '';
          await run(message.text, (chunk) => (plain += chunk));
          if (signal.aborted) return;
          post({ status: 'streaming', chunk: plain });
        };

        // Why the built-in engine bowed out, kept for the message below. Null
        // whenever it never ran or never failed.
        let builtinReason: string | null = null;

        // Chrome's own translator first, when it is the chosen engine. It
        // needs no server, so it is tried before the rule that exists to let
        // one be reached.
        if (engine === 'builtin') {
          /**
           * Taken the first time Chrome says a pack is on its way, and not
           * given back when the reader walks away.
           *
           * The install-time fetch covers `en` → whatever the settings say; a
           * page in some other language is a pair nobody has asked for yet, so
           * the download starts here instead, in the middle of a translation
           * somebody is watching. The only thing keeping the worker alive for
           * it is this port, and the port dies with the tab — so a reader who
           * gets bored and closes it takes the download with them. That is not
           * a lost minute: Chrome does not resume, it waits about three
           * minutes and then deletes what it had. Measured at 85 MB thrown
           * away, and 436 s against 82 s for the same pair left alone.
           */
          let packHold: (() => void) | undefined;
          try {
            await withGlossary((text, onChunk) =>
              translateBuiltin({
                text,
                targetLang: message.targetLang,
                sourceLang: message.sourceLang,
                signal,
                onChunk,
                // Without this the first use of a language pair is a silent
                // wait of a minute or more, which reads as a broken extension.
                onDownloadProgress: (loaded) => {
                  packHold ??= holdWorkerOpen();
                  post({ status: 'downloading', loaded });
                },
              }),
            );
            // It landed: the translation could not have finished otherwise.
            packHold?.();
            post({ status: 'done' });
            return;
          } catch (error) {
            // Every other exit gives the download the worker for a while
            // longer, whatever became of the translation. An abort here is
            // usually the tab closing, which is exactly the case worth
            // surviving; the timer is what stops a dead one holding the worker
            // for good.
            if (packHold) keepAliveFor(packHold, PACK_GRACE_MS);
            if (signal.aborted || (error as Error).name === 'AbortError') {
              return;
            }
            // Anything the built-in engine simply cannot do — a language it
            // has no pack for, an undetectable source, an older browser —
            // falls through to Ollama rather than surfacing as a failure. A
            // real error from it does not: that would hide a bug behind a
            // second engine.
            if (!(error instanceof BuiltinUnavailableError)) {
              post({ status: 'error', message: (error as Error).message });
              return;
            }
            builtinReason = error.message;
          }
        }

        await originRuleReady;
        try {
          await withGlossary((text, onChunk) =>
            translateStream({
              text,
              baseUrl,
              model: message.model,
              targetLang: message.targetLang,
              context: message.context,
              retryCount: message.retryCount ?? 0,
              signal,
              onChunk,
            }),
          );
          post({ status: 'done' });
        } catch (error) {
          if (signal.aborted || (error as Error).name === 'AbortError') return;
          // A network TypeError almost always means the local Ollama server
          // isn't running or hasn't allowed this extension's origin.
          const message_ =
            error instanceof TypeError
              ? `Can't reach Ollama at ${baseUrl}. Is the server running?`
              : (error as Error).message;
          // Ollama's message alone is the wrong answer for a user who never
          // chose Ollama and only landed here because the built-in engine
          // could not serve them.
          post({
            status: 'error',
            message: describeEngineFailure(builtinReason, message_),
          });
        }
      })();
    });

    port.onDisconnect.addListener(() => controller?.abort());
  });

  // One-shot handlers: open a local PDF in the viewer, or run a best-effort
  // enrichment pass for a capture. Both keep the channel open for an async
  // response (`return true`).
  chrome.runtime.onMessage.addListener(
    (request: RuntimeRequest, sender, sendResponse) => {
      // The tab said it is rendering a PDF. Only the tab it came from is
      // touched, and the URL comes from the sender rather than the message:
      // a page that could name both would be able to navigate another tab.
      if (request.type === 'OPEN_IN_VIEWER') {
        const tabId = sender.tab?.id;
        const url = sender.tab?.url ?? sender.url;
        if (tabId !== undefined && url) {
          void routeToViewer(tabId, url, true).catch(() => undefined);
        }
        return;
      }

      // Answered synchronously: the popup asks on every render of the pack
      // banner, and a promise here would make it flicker.
      if (request.type === 'PACK_PROGRESS') {
        const response: PackProgressResponse = {
          downloading: packPrefetching,
          loaded: packLoaded,
          problem: packProblem,
        };
        sendResponse(response);
        return undefined;
      }

      // The popup asking the worker to own a download it must not run itself:
      // closing the popup would kill it, and an interrupted pack costs the
      // whole partial download plus the three minutes Chrome waits before
      // starting over.
      if (request.type === 'PACK_FETCH') {
        void ensurePack(request.source, request.target);
        // Answered, and not for politeness: `chrome.runtime.sendMessage`
        // rejects with "Could not establish connection. Receiving end does not
        // exist." when a listener returns without replying, and the popup
        // showed that to the user as the reason its download would not start.
        // Caught by `e2e:page`, which presses the button for real.
        sendResponse({ ok: true });
        return undefined;
      }

      if (request.type === 'ENRICH_CAPTURE') {
        void (async () => {
          await originRuleReady;
          const { baseUrl } = await loadSettings();
          let result = null;
          try {
            result = await enrichText({
              text: request.text,
              baseUrl,
              model: request.model,
              targetLang: request.targetLang,
            });
          } catch {
            // Best-effort: any failure falls back to a raw capture.
            result = null;
          }
          const response: EnrichCaptureResponse = { result };
          sendResponse(response);
        })();
        return true;
      }

      return undefined;
    },
  );
});
