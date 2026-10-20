import { describe, it, expect, vi } from 'vitest';
import {
  installTimedTextHook,
  TIMEDTEXT_SOURCE,
  type HookWindow,
} from './timedtext-hook';

const ORIGIN = 'https://www.youtube.com';
const BODY =
  '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"Hello."}]}]}';

/** Enough of an XHR to be opened, sent and finished by hand. */
function fakeXhrClass() {
  return class FakeXhr {
    status = 0;
    responseType = '';
    responseText = '';
    response: unknown = null;
    responseURL = '';
    opened: unknown[] = [];
    sent = false;
    private loads: (() => void)[] = [];
    open(...args: unknown[]): void {
      this.opened = args;
    }
    send(): void {
      this.sent = true;
    }
    addEventListener(type: string, listener: () => void): void {
      if (type === 'load') this.loads.push(listener);
    }
    finish(status: number, body: string): void {
      this.status = status;
      this.responseText = body;
      for (const listener of this.loads) listener();
    }
  };
}

type FakeXhr = InstanceType<ReturnType<typeof fakeXhrClass>>;

function fakeWindow(fetchImpl: HookWindow['fetch'] = vi.fn()) {
  const win = {
    XMLHttpRequest: fakeXhrClass() as unknown as typeof XMLHttpRequest,
    fetch: fetchImpl,
    location: { href: `${ORIGIN}/watch?v=abc`, origin: ORIGIN },
    postMessage: vi.fn(),
  };
  installTimedTextHook(win);
  const request = (): FakeXhr => new win.XMLHttpRequest() as unknown as FakeXhr;
  return { win, request };
}

describe('installTimedTextHook', () => {
  it('copies a caption response out, and the player still gets its own', () => {
    const { win, request } = fakeWindow();
    const xhr = request();
    xhr.open('GET', '/api/timedtext?v=abc&lang=en&fmt=json3');
    xhr.send();
    expect(xhr.sent).toBe(true);
    expect(xhr.opened).toEqual([
      'GET',
      '/api/timedtext?v=abc&lang=en&fmt=json3',
    ]);

    xhr.finish(200, BODY);
    expect(win.postMessage).toHaveBeenCalledWith(
      {
        source: TIMEDTEXT_SOURCE,
        url: `${ORIGIN}/api/timedtext?v=abc&lang=en&fmt=json3`,
        body: BODY,
      },
      ORIGIN,
    );
  });

  it('ignores every other request and every failed one', () => {
    const { win, request } = fakeWindow();
    const other = request();
    other.open('POST', '/youtubei/v1/player');
    other.send();
    other.finish(200, '{}');
    const refused = request();
    refused.open('GET', '/api/timedtext?v=abc&lang=en');
    refused.send();
    refused.finish(429, '');
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it('reads a caption track fetched with fetch, leaving the body to the page', async () => {
    const { win } = fakeWindow(() => Promise.resolve(new Response(BODY)));
    const response = await win.fetch(`${ORIGIN}/api/timedtext?v=abc&lang=en`);
    expect(await response.text()).toBe(BODY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ source: TIMEDTEXT_SOURCE, body: BODY }),
      ORIGIN,
    );
  });

  it('passes a fetch it has no interest in straight through', async () => {
    const original = vi.fn(() => Promise.resolve(new Response('ok')));
    const { win } = fakeWindow(original);
    await win.fetch(`${ORIGIN}/youtubei/v1/next`, { method: 'POST' });
    expect(original).toHaveBeenCalledWith(`${ORIGIN}/youtubei/v1/next`, {
      method: 'POST',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.postMessage).not.toHaveBeenCalled();
  });
});
