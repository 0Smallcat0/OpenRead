import { mountSelectionTranslator } from '../ui/selection';
import { mountHoverTranslate } from '../ui/hover';
import { mountSubtitleTranslate } from '../ui/subtitles';
import { translateActiveInput } from '../ui/input-translate';
import {
  togglePageTranslation,
  translatePage,
  translateBlock,
  applyAppearance,
  reflowTranslations,
  showPageNotice,
} from '../ui/fullpage';
import { translateViaPort } from '../ui/port-translate';
import { shouldBypassAI } from '../core/language';
import { shouldAutoTranslate } from '../core/auto-translate';
import { shouldTranslateFrame } from '../core/frames';
import { collectBlocks } from '../ui/blocks';
import { loadSettings, type Settings } from '../settings';
import type { PageLanguageResponse } from '../messaging';

/**
 * Web-page content script: mounts the shared selection translator on every
 * frame, and runs whole-page translation on every frame that carries an
 * article rather than an advert — see `core/frames.ts`. Model + target
 * language are read from storage at translate time so changes in the popup
 * take effect without a reload. No secret is involved — inference is local;
 * the background broker holds the Ollama server URL.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_end',
  main() {
    mountSelectionTranslator({
      getSettings: async () => {
        const s = await loadSettings();
        return {
          engine: s.engine,
          modelId: s.modelId,
          targetLang: s.targetLang,
          obsidianVault: s.obsidianVault,
          obsidianFolder: s.obsidianFolder,
          enrichOnCapture: s.enrichOnCapture,
        };
      },
    });

    const isTop = window.top === window;

    const pageDeps = (settings: Settings, unprompted = false) => ({
      targetLang: settings.targetLang,
      unprompted,
      // One badge a page, in the frame the reader's viewport belongs to.
      silent: !isTop,
      translate: (
        text: string,
        signal: AbortSignal,
        attempt: number,
        onDownloadProgress?: (loaded: number) => void,
      ) =>
        translateViaPort({
          text,
          targetLang: settings.targetLang,
          model: settings.modelId,
          signal,
          retryCount: attempt,
          onDownloadProgress,
        }),
      // The same short-circuit selection uses: a block already in the
      // target language costs a full round trip to say nothing.
      shouldSkipText: (text: string) =>
        shouldBypassAI(text, settings.targetLang),
      appearance: {
        displayMode: settings.displayMode,
        translationStyle: settings.translationStyle,
        translationScale: settings.translationScale,
      },
    });

    // Subtitles, on every frame: an embedded player is an iframe, and the
    // caption is inside it. Re-mounted rather than reconfigured when the
    // setting changes, because the mount owns observers on containers that may
    // not exist yet — a video page builds its player after the navigation.
    let stopSubtitles: (() => void) | null = null;
    const remountSubtitles = (settings: Settings): void => {
      stopSubtitles?.();
      stopSubtitles = mountSubtitleTranslate(document, {
        enabled: settings.translateSubtitles,
        targetLang: settings.targetLang,
        translate: (text: string, signal: AbortSignal) =>
          translateViaPort({
            text,
            targetLang: settings.targetLang,
            model: settings.modelId,
            signal,
          }),
      });
    };
    void loadSettings().then(remountSubtitles);

    // Point at a paragraph with a key held and get that paragraph. Mounted on
    // every frame, like selection: the unit is one block, and a block inside an
    // iframe is as worth translating as one outside it.
    mountHoverTranslate(document, {
      getKey: async () => (await loadSettings()).hoverTranslate,
      translateBlock: async (block) => {
        const settings = await loadSettings();
        return translateBlock(block, pageDeps(settings));
      },
    });

    /**
     * The host in the address bar, from inside any frame.
     *
     * `ancestorOrigins` is ordered innermost first, so the last entry is the
     * top document's origin — readable cross-origin, which is what makes this
     * possible at all. Empty for a sandboxed frame, whose origin is opaque;
     * the caller treats that as "cannot tell" rather than guessing, because
     * the guess would be this frame's own host and a per-site exception that
     * silently applies to the wrong site is worse than one that does nothing.
     */
    const pageHost = (): string => {
      if (isTop) return location.hostname;
      const origins = location.ancestorOrigins;
      const outermost = origins?.[origins.length - 1];
      if (!outermost) return '';
      try {
        return new URL(outermost).hostname;
      } catch {
        return '';
      }
    };

    /**
     * Whether this frame joins a whole-page run.
     *
     * This used to be `window.top === window`, and the reason was sound: every
     * frame receives the broadcast, and an ad iframe running its own pass
     * would spend the reader's GPU on someone else's banner. The cost was that
     * an article inside an iframe — an embedded document viewer, a comment
     * system, a syndicated post — came back untranslated with nothing to say
     * why, because nothing about it looks embedded to a reader.
     *
     * `core/frames.ts` has the test and the sizes. It is asked here, at the
     * moment of the press, rather than once at mount: a frame that had two
     * paragraphs when the script loaded may have thirty by the time anyone
     * asks for a translation.
     */
    const framePasses = (settings: Settings): boolean =>
      shouldTranslateFrame({
        isTop,
        width: window.innerWidth,
        height: window.innerHeight,
        blocks: collectBlocks(document, {
          // Everything in the frame, not just what is in view: a frame scrolls
          // separately, and whether it holds an article is not a question
          // about where its scrollbar happens to be.
          isVisible: () => true,
          shouldSkipText: (text: string) =>
            shouldBypassAI(text, settings.targetLang),
        }).length,
      });

    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse) => {
        const type = (message as { type?: string } | null)?.type;

        // Answered synchronously, so no `return true` is needed and the popup
        // is never left waiting on a channel that closed.
        // Top frame only. `chrome.tabs.sendMessage` resolves on the first
        // responder, and an embedded frame answering `lang="en"` for a Chinese
        // page would decide auto-translation for the whole tab.
        if (type === 'PAGE_LANGUAGE' && isTop) {
          const response: PageLanguageResponse = {
            lang: document.documentElement.getAttribute('lang'),
          };
          sendResponse(response);
          return;
        }

        // Every frame gets this; only the one holding the focused field acts,
        // which `activeField` answers by returning null everywhere else.
        if (type === 'TRANSLATE_INPUT') {
          void (async () => {
            const settings = await loadSettings();
            await translateActiveInput(document, {
              translate: (text) =>
                translateViaPort({
                  text,
                  targetLang: settings.inputTargetLang,
                  model: settings.modelId,
                  signal: new AbortController().signal,
                  // The writer is typing in the language they think in, which
                  // is precisely not the one the page is written in.
                  fromPageLanguage: false,
                }),
              notify: (message) => {
                showPageNotice(document, message);
              },
            });
          })();
          return;
        }

        if (type !== 'TRANSLATE_PAGE') return;
        void (async () => {
          const settings = await loadSettings();
          if (!framePasses(settings)) return;
          await togglePageTranslation(document, pageDeps(settings));
        })();
      },
    );

    // Appearance follows the popup without a reload. Style and size are pure
    // CSS and change with the attribute alone; the display mode has to add or
    // remove the wrapper that hides the original, which is what `reflow` does.
    // A translated page the reader is looking at while they try the settings is
    // exactly when this matters.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if ('translateSubtitles' in changes || 'targetLang' in changes) {
        void loadSettings().then(remountSubtitles);
      }
      if (
        !('displayMode' in changes) &&
        !('translationStyle' in changes) &&
        !('translationScale' in changes)
      ) {
        return;
      }
      void loadSettings().then((settings) => {
        applyAppearance(document, {
          displayMode: settings.displayMode,
          translationStyle: settings.translationStyle,
          translationScale: settings.translationScale,
        });
        if ('displayMode' in changes) {
          reflowTranslations(document, settings.displayMode);
        }
      });
    });

    // Translate without being asked, when the user has asked for that in
    // general. `translatePage` rather than the toggle: a page that arrives
    // already carrying a translation — a back-navigation restoring the bfcache
    // — must not have it wiped by the automatic pass, which is what the toggle
    // would do.
    void (async () => {
      const settings = await loadSettings();
      if (settings.autoTranslate === 'off') return;
      // Read from the page rather than from `navigator.language`: what matters
      // is what this document says it is, not what the browser is set to.
      const sample = Array.from(document.querySelectorAll('p, h1, h2, h3, li'))
        .slice(0, 20)
        .map((element) => element.textContent ?? '')
        .join(' ')
        .slice(0, 1000);
      // The site the reader is on, which in a frame is not `location.hostname`.
      // A per-site exception is a statement about the address bar: excluding
      // news.example.com must also stop the article embedded inside it, and
      // must not be defeated by that article living on a CDN host nobody typed.
      const host = pageHost();
      if (!host) return;
      if (!framePasses(settings)) return;
      const decided = shouldAutoTranslate({
        mode: settings.autoTranslate,
        host,
        except: settings.autoTranslateExcept,
        pageLang: document.documentElement.getAttribute('lang'),
        sample,
        targetLang: settings.targetLang,
      });
      if (decided) await translatePage(document, pageDeps(settings, true));
    })();
  },
});
