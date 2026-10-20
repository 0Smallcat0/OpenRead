import {
  parseTrack,
  replacesCaptions,
  videoIdOf,
  type CaptionTrack,
} from '../core/captions';
import { toBcp47 } from '../core/bcp47';
import { mountSubtitles, type SubtitleOverlay } from '../ui/subtitles';
import { TIMEDTEXT_SOURCE, type TimedTextMessage } from '../ui/timedtext-hook';
import { translateViaPort } from '../ui/port-translate';
import { showPageNotice } from '../ui/fullpage';
import { loadSettings, type Settings } from '../settings';

/** Settings that change what a caption translates into, or who translates it. */
const RESTART_ON: readonly (keyof Settings)[] = [
  'videoSubtitles',
  'targetLang',
  'engine',
  'baseUrl',
  'modelId',
  'apiBaseUrl',
  'apiModel',
  'glossary',
];

/**
 * Bilingual captions on YouTube.
 *
 * The track comes from `youtube-hook.content.ts`, which sees the player fetch
 * it. This decides whether to lay our captions over the player's, and does:
 * only while the reader has captions switched on, only for the video on
 * screen, and only when those captions are not already in the reader's
 * language — YouTube's own translation into it included. Everything else
 * leaves YouTube exactly as it was.
 */
export default defineContentScript({
  matches: ['*://www.youtube.com/*'],
  allFrames: true,
  // Listening before the player can ask for a track, as the hook is.
  runAt: 'document_start',
  main() {
    let settings: Settings | null = null;
    /** The last track the player fetched in this frame. */
    let track: CaptionTrack | null = null;
    let overlay: SubtitleOverlay | null = null;
    /** The track the overlay is showing. */
    let showing: CaptionTrack | null = null;
    /** A track whose translation failed; left to YouTube from then on. */
    let abandoned: CaptionTrack | null = null;

    const takeDown = (): void => {
      overlay?.stop();
      overlay = null;
      showing = null;
    };

    const refresh = (): void => {
      const video = document.querySelector<HTMLVideoElement>(
        'video.html5-main-video',
      );
      const player = video?.closest<HTMLElement>('.html5-video-player');
      const captionsOn =
        player
          ?.querySelector('.ytp-subtitles-button')
          ?.getAttribute('aria-pressed') === 'true';
      const current = settings;
      const wanted =
        current !== null &&
        current.videoSubtitles &&
        track !== null &&
        track !== abandoned &&
        captionsOn &&
        track.videoId === videoIdOf(location.href) &&
        replacesCaptions(track.lang, toBcp47(current.targetLang));
      if (!wanted || !video || !player || !current || !track) {
        takeDown();
        return;
      }
      if (overlay && showing === track) return;
      takeDown();
      const shown = track;
      showing = shown;
      overlay = mountSubtitles({
        player,
        video,
        track: shown,
        displayMode: current.displayMode,
        translate: (text, signal, onDownloadProgress) =>
          translateViaPort({
            text,
            targetLang: current.targetLang,
            model: current.modelId,
            signal,
            onDownloadProgress,
            sourceLang: shown.lang,
          }),
        onGiveUp: (reason) => {
          overlay = null;
          showing = null;
          abandoned = shown;
          showPageNotice(
            document,
            `OpenRead could not translate these captions, so YouTube's own ` +
              `are back. ${reason}`,
          );
        },
      });
    };

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as Partial<TimedTextMessage> | null;
      if (data?.source !== TIMEDTEXT_SOURCE) return;
      if (typeof data.url !== 'string' || typeof data.body !== 'string') return;
      const parsed = parseTrack(data.url, data.body);
      if (!parsed) return;
      track = parsed;
      refresh();
    });

    // The CC button: pressing it is the reader asking, and pressing it again
    // is the reader asking for no captions at all, ours included.
    new MutationObserver((mutations) => {
      if (
        mutations.some((mutation) =>
          (mutation.target as Element).classList.contains(
            'ytp-subtitles-button',
          ),
        )
      ) {
        refresh();
      }
    }).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });

    // YouTube moves between videos without loading a page.
    document.addEventListener('yt-navigate-finish', refresh);

    void loadSettings().then((loaded) => {
      settings = loaded;
      refresh();
    });

    // A new target or engine is a new translation from the start; a new
    // display mode is the same translation shown differently.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      void loadSettings().then((loaded) => {
        settings = loaded;
        if ('displayMode' in changes) {
          overlay?.setDisplayMode(loaded.displayMode);
        }
        if (!RESTART_ON.some((key) => key in changes)) return;
        abandoned = null;
        takeDown();
        refresh();
      });
    });
  },
});
