/**
 * Manual harness for the selection UI — real browser, real layout engine, real
 * focus, real `prefers-color-scheme`. jsdom has none of those, so the unit
 * tests can prove the control flow and none of the things that only exist once
 * a rendering engine is involved: whether the dark palette actually applies,
 * whether the panel stays on screen near the right edge, whether Escape and
 * Enter behave when a live selection is present.
 *
 * NOT the extension. `chrome` is stubbed and translations are faked, so this
 * checks the UI module alone. Run with `pnpm harness`.
 */
import { mountSelectionTranslator } from '../src/ui/selection';

interface FakePort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (res: unknown) => void) => void };
}

// Enough of the extension surface for the module to run.
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
    connect: (): FakePort => {
      const listeners: ((res: unknown) => void)[] = [];
      return {
        onMessage: {
          addListener: (fn) => {
            listeners.push(fn);
          },
        },
        disconnect: () => undefined,
        postMessage: () => {
          // Fake a stream so the panel fills the way it does in the product.
          const chunks = [
            'fetch() 方法啟動從網路取得資源的過程，',
            '回傳一個 promise，',
            '該 promise 在取得回應後會被履行。',
          ];
          let i = 0;
          const tick = (): void => {
            if (i < chunks.length) {
              for (const fn of listeners)
                fn({ status: 'streaming', chunk: chunks[i] });
              i++;
              window.setTimeout(tick, 180);
            } else {
              for (const fn of listeners) fn({ status: 'done' });
            }
          };
          window.setTimeout(tick, 150);
        },
      };
    },
  },
};

mountSelectionTranslator({
  getSettings: () =>
    Promise.resolve({
      modelId: 'qwen3:latest',
      targetLang: 'Traditional Chinese',
      obsidianVault: '',
      obsidianFolder: 'OpenRead',
      enrichOnCapture: false,
    }),
});
