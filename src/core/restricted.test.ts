import { describe, it, expect } from 'vitest';
import { describeRestrictedPage } from './restricted';

describe('describeRestrictedPage', () => {
  it('names the extension store, which is where every user starts', () => {
    // The first page anyone sees with this extension installed is the listing
    // they installed it from, and it is one of the few Chrome forbids. Pressing
    // the button there did nothing at all and said nothing at all.
    expect(
      describeRestrictedPage(
        'https://chromewebstore.google.com/detail/mopclgoefogojkfmigfjpbmnnoiodnmb',
      ),
    ).toMatch(/extension store/);
    expect(
      describeRestrictedPage('https://chrome.google.com/webstore/detail/abc'),
    ).toMatch(/extension store/);
  });

  it("names the browser's own pages", () => {
    for (const url of [
      'chrome://extensions/',
      'chrome://newtab/',
      'devtools://devtools/bundled/inspector.html',
      'edge://settings',
      'about:blank',
    ]) {
      expect(describeRestrictedPage(url)).toMatch(/its own pages/);
    }
  });

  it('says nothing about an ordinary page', () => {
    expect(describeRestrictedPage('https://en.wikipedia.org/wiki/Ollama')).toBeNull();
    expect(describeRestrictedPage('http://localhost:8080/index.html')).toBeNull();
    // Our own reader and PDF viewer are extension pages, and translation works
    // on both — so the scheme must not be on the list.
    expect(
      describeRestrictedPage('chrome-extension://abc/epub-reader.html'),
    ).toBeNull();
  });

  it('treats not knowing as no reason at all', () => {
    // A false alarm here tells a reader their page is unusable while it sits
    // there perfectly translatable, which is worse than saying nothing.
    expect(describeRestrictedPage(null)).toBeNull();
    expect(describeRestrictedPage('')).toBeNull();
    expect(describeRestrictedPage('not a url')).toBeNull();
  });

  it('does not mistake a page that merely mentions the store', () => {
    expect(
      describeRestrictedPage('https://example.com/chromewebstore.google.com'),
    ).toBeNull();
    expect(
      describeRestrictedPage('https://chrome.google.com/blog/something'),
    ).toBeNull();
  });
});
