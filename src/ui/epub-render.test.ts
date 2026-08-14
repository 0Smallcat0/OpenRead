// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  renderChapter,
  parseChapter,
  mediaTypeFor,
  CHAPTER_LINK_ATTR,
  CHAPTER_FRAGMENT_ATTR,
  type ChapterAssets,
} from './epub-render';

function assetsHolding(files: Record<string, string>): ChapterAssets & {
  created: string[];
} {
  const created: string[] = [];
  return {
    created,
    has: (path) => path in files,
    read: (path) =>
      Promise.resolve(new TextEncoder().encode(files[path] ?? '')),
    createUrl: (_bytes, mediaType) => {
      const url = `blob:${mediaType}/${String(created.length)}`;
      created.push(url);
      return url;
    },
  };
}

const xhtml = (body: string): string =>
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;

async function render(
  body: string,
  files: Record<string, string> = {},
  path = 'OEBPS/text/ch1.xhtml',
): Promise<{ html: string; urls: string[]; root: HTMLElement }> {
  const { fragment, urls } = await renderChapter(
    xhtml(body),
    path,
    assetsHolding(files),
  );
  const root = document.createElement('div');
  root.appendChild(fragment);
  return { html: root.innerHTML, urls, root };
}

describe('renderChapter: what it refuses to carry across', () => {
  it('drops script elements', async () => {
    const { html } = await render(
      '<p>Chapter one.</p><script>fetch("https://example.com")</script>',
    );
    expect(html).toContain('Chapter one.');
    expect(html).not.toContain('script');
  });

  it('drops every on… handler', async () => {
    // The page's CSP would refuse to run these anyway. Removing them as well
    // is the difference between one control and two.
    const { root } = await render(
      '<p onclick="steal()" onmouseover="steal()">Chapter one.</p>',
    );
    const paragraph = root.querySelector('p');
    expect(paragraph?.getAttribute('onclick')).toBeNull();
    expect(paragraph?.getAttribute('onmouseover')).toBeNull();
  });

  it("drops the book's own stylesheets", async () => {
    // Publisher CSS assumes a paginated viewport it controls, and would be
    // styling the translated lines this extension inserts as well.
    const { html } = await render(
      '<link rel="stylesheet" href="style.css"/><style>p{display:none}</style><p>Chapter one.</p>',
    );
    expect(html).not.toContain('stylesheet');
    expect(html).not.toContain('display:none');
    expect(html).toContain('Chapter one.');
  });

  it('drops a base element, which would repoint every relative URL', async () => {
    const { html } = await render(
      '<base href="https://example.com/"/><p>x</p>',
    );
    expect(html).not.toContain('example.com');
  });

  it('takes url() out of an inline style and keeps the rest', async () => {
    const { root } = await render(
      '<p style="text-align:center;background-image:url(https://example.com/x.png)">Verse.</p>',
    );
    const style = root.querySelector('p')?.getAttribute('style');
    expect(style).toContain('text-align:center');
    expect(style).not.toContain('url(');
  });

  it('removes an inline style that was only a remote reference', async () => {
    const { root } = await render(
      '<p style="background:url(https://example.com/x.png)">Verse.</p>',
    );
    expect(root.querySelector('p')?.hasAttribute('style')).toBe(false);
  });

  it('removes an image that points off the machine rather than fetching it', async () => {
    // A remote image is a request the reader did not make and a note to the
    // publisher about which page they are on.
    const { html, urls } = await render(
      '<p>Chapter one.</p><img src="https://example.com/tracker.png" alt="x"/>',
    );
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('<img');
    expect(urls).toEqual([]);
  });

  it('drops srcset and poster, which name more URLs than src does', async () => {
    const { html } = await render(
      '<img src="../img/fig.png" srcset="https://example.com/2x.png 2x"/>',
      { 'OEBPS/img/fig.png': 'PNG' },
    );
    expect(html).not.toContain('srcset');
  });
});

describe('renderChapter: images from inside the book', () => {
  it('resolves an image against the chapter and hands back an object URL', async () => {
    const { root, urls } = await render(
      '<img src="../img/fig1.png" alt="A figure"/>',
      {
        'OEBPS/img/fig1.png': 'PNG',
      },
    );
    expect(root.querySelector('img')?.getAttribute('src')).toBe(urls[0]);
    expect(urls[0]).toContain('image/png');
  });

  it('reports every URL it created, so the caller can release them', async () => {
    // A book read front to back would otherwise hold every illustration it
    // has ever shown until the tab closed.
    const { urls } = await render('<img src="a.png"/><img src="b.jpg"/>', {
      'OEBPS/text/a.png': 'A',
      'OEBPS/text/b.jpg': 'B',
    });
    expect(urls).toHaveLength(2);
  });

  it('resolves an SVG image through xlink, which is how covers are written', async () => {
    const { root, urls } = await render(
      '<svg viewBox="0 0 10 10"><image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="../img/cover.jpg" width="10" height="10"/></svg>',
      { 'OEBPS/img/cover.jpg': 'JPEG' },
    );
    const image = root.querySelector('image');
    expect(image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(
      urls[0],
    );
  });

  it('removes an image the archive does not actually contain', async () => {
    const { html } = await render('<p>Text.</p><img src="missing.png"/>');
    expect(html).not.toContain('<img');
    expect(html).toContain('Text.');
  });
});

describe('renderChapter: links', () => {
  it('leaves a jump inside this chapter alone', async () => {
    const { root } = await render('<a href="#note-3">3</a>');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('#note-3');
  });

  it('turns a jump into another chapter into something the reader handles', async () => {
    // Left as an href it would navigate the extension page, taking the open
    // book with it.
    const { root } = await render(
      '<a href="../text/ch2.xhtml#part-two">Next</a>',
    );
    const anchor = root.querySelector('a');
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.getAttribute(CHAPTER_LINK_ATTR)).toBe(
      'OEBPS/text/ch2.xhtml',
    );
    expect(anchor?.getAttribute(CHAPTER_FRAGMENT_ATTR)).toBe('part-two');
  });

  it('opens an ordinary web link in a new tab', async () => {
    const { root } = await render('<a href="https://example.com/">Source</a>');
    const anchor = root.querySelector('a');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps the text of a javascript: link and takes the link away', async () => {
    const { root, html } = await render(
      '<a href="javascript:steal()">Read more</a>',
    );
    expect(html).toContain('Read more');
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('takes the link away from a data: URL too', async () => {
    const { root } = await render(
      '<a href="data:text/html,<script>steal()</script>">x</a>',
    );
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
  });
});

describe('parseChapter', () => {
  it('parses well-formed XHTML strictly, keeping namespaces', () => {
    const doc = parseChapter(xhtml('<p>Fine.</p>'));
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('falls back to the HTML parser for a book that is not well-formed', async () => {
    // A bare ampersand is not valid XML and is extremely common in real
    // books. Parsed strictly it yields a <parsererror> and a blank chapter.
    const { html } = await render('<p>Tom & Jerry</p><br>');
    expect(html).toContain('Tom &amp; Jerry');
  });
});

describe('mediaTypeFor', () => {
  it('names the common picture formats and gives up honestly on the rest', () => {
    expect(mediaTypeFor('a/b/fig.JPG')).toBe('image/jpeg');
    expect(mediaTypeFor('cover.svg')).toBe('image/svg+xml');
    expect(mediaTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});
