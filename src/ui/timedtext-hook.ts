/**
 * Pass the YouTube player's own caption responses to the extension.
 *
 * Installed in the page's JavaScript world, because that is the only place the
 * player's requests can be seen from: a content script's `XMLHttpRequest` is a
 * different object from the one the page calls. What it hands over is the
 * response the player already received, so nothing is requested twice and no
 * proof-of-origin token has to be reproduced — the reason a second request of
 * our own fails is the reason this exists.
 *
 * Read-only. The page gets exactly the response it asked for, at the same
 * moment; a copy of the text goes to `window.postMessage`, where the content
 * script beside it picks it up.
 */

export const TIMEDTEXT_SOURCE = 'openread-timedtext';

export interface TimedTextMessage {
  source: typeof TIMEDTEXT_SOURCE;
  url: string;
  body: string;
}

/** The parts of a window this touches, so a test can hand it a fake one. */
export interface HookWindow {
  XMLHttpRequest: typeof XMLHttpRequest;
  fetch: typeof fetch;
  location: { href: string; origin: string };
  postMessage: (message: unknown, targetOrigin: string) => void;
}

const isTimedText = (url: string): boolean => url.includes('/api/timedtext');

export function installTimedTextHook(win: HookWindow): void {
  const absolute = (url: unknown): string => {
    try {
      return new URL(String(url), win.location.href).href;
    } catch {
      return String(url);
    }
  };
  const post = (url: string, body: string): void => {
    const message: TimedTextMessage = { source: TIMEDTEXT_SOURCE, url, body };
    win.postMessage(message, win.location.origin);
  };

  // The request the player makes today, measured on 2026-10-21: an XHR with
  // `responseType` left as text.
  const proto = win.XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const urls = new WeakMap<XMLHttpRequest, string>();
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    urls.set(this, absolute(args[1]));
    Reflect.apply(open, this, args);
  };
  proto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const url = urls.get(this);
    if (url !== undefined && isTimedText(url)) {
      this.addEventListener('load', () => {
        if (this.status !== 200) return;
        const where = this.responseURL || url;
        if (this.responseType === '' || this.responseType === 'text') {
          post(where, this.responseText);
        } else if (this.responseType === 'json') {
          post(where, JSON.stringify(this.response));
        }
      });
    }
    Reflect.apply(send, this, args);
  };

  // And `fetch`, which is one rewrite of the player away. Without this the
  // feature would end silently on the day it changes, with nothing to say so.
  const originalFetch = win.fetch;
  win.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = originalFetch.call(win, input, init);
    const url = absolute(
      typeof input === 'object' && 'url' in input ? input.url : input,
    );
    if (isTimedText(url)) {
      void response
        .then(async (answer) => {
          if (!answer.ok) return;
          post(answer.url || url, await answer.clone().text());
        })
        .catch(() => undefined);
    }
    return response;
  };
}
