/**
 * The EPUB reader page: Chrome's half of `ui/epub-reader.ts`.
 *
 * Everything here is the part that cannot be tested under jsdom — object URLs,
 * `chrome.storage`, the file picker, the message from the toolbar and the
 * context menu. The reading itself is in `ui/epub-reader.ts`.
 *
 * The translator is mounted exactly as the PDF viewer mounts it, and for the
 * same reason: a chapter is ordinary DOM in an ordinary `<main>`, so the
 * selection panel, the hover key and whole-page translation all work here
 * without a line of their own.
 */
import {
  mountReader,
  READER_IDS,
  type ReadingPosition,
} from '../../ui/epub-reader';
import { mountSelectionTranslator } from '../../ui/selection';
import { mountHoverTranslate } from '../../ui/hover';
import {
  togglePageTranslation,
  translatePage,
  translateBlock,
  applyAppearance,
  reflowTranslations,
  isPageTranslated,
} from '../../ui/fullpage';
import { translateViaPort } from '../../ui/port-translate';
import { shouldBypassAI } from '../../core/language';
import { loadSettings, type Settings } from '../../settings';

/** Where a book's reading position is filed. */
const POSITION_PREFIX = 'epub-position:';

const element = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const fileInput = element<HTMLInputElement>(READER_IDS.file);
const chooseButton = element<HTMLButtonElement>(READER_IDS.choose);
const translateButton = element<HTMLButtonElement>(READER_IDS.translate);
const errorLine = element(READER_IDS.error);

function fail(message: string): void {
  errorLine.textContent = message;
  errorLine.hidden = false;
}

/**
 * Whether the reader has asked for this book to be translated.
 *
 * A chapter break is not a decision. Asking for a translation and then being
 * handed the next chapter in the original language — every chapter, for the
 * length of a book — is the difference between a feature and a chore, so the
 * request is remembered and re-run as the reader moves. Turning the
 * translation off turns this off with it.
 */
let translateEveryChapter = false;

const pageDeps = (settings: Settings) => ({
  targetLang: settings.targetLang,
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
      // This page is the extension's own document and declares itself English;
      // the book inside it is in whatever language its author wrote.
      fromPageLanguage: false,
    }),
  shouldSkipText: (text: string) => shouldBypassAI(text, settings.targetLang),
  appearance: {
    displayMode: settings.displayMode,
    translationStyle: settings.translationStyle,
    translationScale: settings.translationScale,
  },
});

const reader = mountReader(document, {
  createUrl: (bytes, mediaType) =>
    URL.createObjectURL(
      new Blob([bytes.slice() as BlobPart], { type: mediaType }),
    ),
  revokeUrl: (url) => {
    URL.revokeObjectURL(url);
  },
  loadPosition: async (bookId) => {
    const key = POSITION_PREFIX + bookId;
    const stored = (await chrome.storage.local.get(key)) as Record<
      string,
      ReadingPosition | undefined
    >;
    return stored[key] ?? null;
  },
  savePosition: async (bookId, position) => {
    await chrome.storage.local.set({ [POSITION_PREFIX + bookId]: position });
  },
  onChapter: () => {
    if (!translateEveryChapter) return;
    void (async () => {
      const settings = await loadSettings();
      // `translatePage`, not the toggle: the new chapter carries no
      // translation, and asking the toggle would be asking it to decide
      // something it cannot see yet.
      await translatePage(document, pageDeps(settings));
    })();
  },
});

async function openBytes(bytes: Uint8Array): Promise<void> {
  translateEveryChapter = false;
  await reader.open(bytes);
}

chooseButton.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  void (async () => {
    await openBytes(new Uint8Array(await file.arrayBuffer()));
  })();
});

/**
 * Dropping a book onto the window.
 *
 * The route most readers reach for first, and the only one that needs no
 * permission at all: the bytes arrive with the drop, so nothing is fetched and
 * "Allow access to file URLs" never comes into it.
 */
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('oit-epub-dropping');
});
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) {
    document.body.classList.remove('oit-epub-dropping');
  }
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('oit-epub-dropping');
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  void (async () => {
    await openBytes(new Uint8Array(await file.arrayBuffer()));
  })();
});

/**
 * A book named in the address, which is how the background sends one here.
 *
 * A `file://` URL only works once the user has turned on "Allow access to file
 * URLs" for this extension — Chrome withholds the scheme from every extension
 * until they do — so the failure says that rather than reporting a network
 * error the reader can do nothing with.
 */
async function openFromAddress(): Promise<void> {
  const source = new URL(location.href).searchParams.get('file');
  if (!source) return;
  try {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`The server answered ${String(response.status)}.`);
    await openBytes(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    fail(
      source.startsWith('file://')
        ? 'Chrome will not let an extension read a local file until you turn on "Allow access to file URLs" in chrome://extensions → OpenRead → Details. You can also just drop the book onto this page.'
        : `That book could not be downloaded. ${(error as Error).message}`,
    );
  }
}
void openFromAddress();

/** Translate the chapter on screen, or take the translation off it. */
async function toggleTranslation(): Promise<void> {
  const settings = await loadSettings();
  await togglePageTranslation(document, pageDeps(settings));
  translateEveryChapter = isPageTranslated(document);
  translateButton.textContent = translateEveryChapter
    ? 'Original'
    : 'Translate';
}

translateButton.addEventListener('click', () => void toggleTranslation());

// The toolbar button, the context menu and Ctrl+Shift+U all arrive as this.
chrome.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { type?: string } | null)?.type !== 'TRANSLATE_PAGE') return;
  void toggleTranslation();
});

mountSelectionTranslator({
  getSettings: async () => {
    const settings = await loadSettings();
    return {
      engine: settings.engine,
      modelId: settings.modelId,
      targetLang: settings.targetLang,
      obsidianVault: settings.obsidianVault,
      obsidianFolder: settings.obsidianFolder,
      enrichOnCapture: settings.enrichOnCapture,
    };
  },
});

// One paragraph of a book is as worth pointing at as one paragraph of a page.
mountHoverTranslate(document, {
  getKey: async () => (await loadSettings()).hoverTranslate,
  translateBlock: async (block) => {
    const settings = await loadSettings();
    return translateBlock(block, pageDeps(settings));
  },
});

// Appearance follows the popup without a reload, as it does on a web page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
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
