// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  openEpub,
  findPackagePath,
  parsePackage,
  parseNav,
  parseNcx,
  resolvePath,
  fragmentOf,
  isRemoteHref,
  EpubError,
} from './epub';
import { buildEpub, buildZip } from '../../tests/epub-fixture';

describe('resolvePath', () => {
  it('resolves an href against the file that wrote it', () => {
    expect(resolvePath('OEBPS/content.opf', 'text/ch1.xhtml')).toBe(
      'OEBPS/text/ch1.xhtml',
    );
  });

  it('climbs out of the package directory', () => {
    // The common layout: the package file in OEBPS/, images in a sibling.
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/fig1.png')).toBe(
      'OEBPS/images/fig1.png',
    );
  });

  it('decodes percent-escapes, because zip entry names are not escaped', () => {
    // A chapter called 第一章.xhtml is escaped in the package file and literal
    // in the archive. Looking it up undecoded finds nothing, and the book
    // opens with that chapter blank rather than with an error.
    expect(
      resolvePath('OEBPS/content.opf', '%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml'),
    ).toBe('OEBPS/第一章.xhtml');
  });

  it('survives a stray percent sign', () => {
    expect(resolvePath('OEBPS/content.opf', '100%.xhtml')).toBe(
      'OEBPS/100%.xhtml',
    );
  });

  it('drops the fragment', () => {
    expect(resolvePath('OEBPS/nav.xhtml', 'ch1.xhtml#part-two')).toBe(
      'OEBPS/ch1.xhtml',
    );
  });

  it('treats a leading slash as the archive root', () => {
    expect(resolvePath('OEBPS/content.opf', '/images/cover.png')).toBe(
      'images/cover.png',
    );
  });
});

describe('fragmentOf', () => {
  it('returns what follows the hash, and nothing when there is none', () => {
    expect(fragmentOf('ch1.xhtml#s2')).toBe('s2');
    expect(fragmentOf('ch1.xhtml')).toBe('');
  });
});

describe('isRemoteHref', () => {
  it('tells a file in the book from an address outside it', () => {
    expect(isRemoteHref('https://example.com/x.png')).toBe(true);
    expect(isRemoteHref('data:image/png;base64,AAAA')).toBe(true);
    expect(isRemoteHref('images/x.png')).toBe(false);
    expect(isRemoteHref('#footnote-3')).toBe(false);
  });
});

describe('findPackagePath', () => {
  it('reads the path out of container.xml', () => {
    expect(
      findPackagePath(
        `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
           <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
         </container>`,
      ),
    ).toBe('OEBPS/content.opf');
  });

  it('says so when the container names nothing', () => {
    expect(() => findPackagePath('<container/>')).toThrow(EpubError);
  });

  it('says so when the container is not XML at all', () => {
    // DOMParser does not throw on malformed XML — it returns a document whose
    // root is <parsererror>, which reads as an ordinary document to anything
    // that does not look for it.
    expect(() => findPackagePath('<container')).toThrow(/not valid XML/);
  });
});

describe('parsePackage', () => {
  const opf = (inner: string, attrs = ''): string =>
    `<package xmlns="http://www.idpf.org/2007/opf"${attrs}>${inner}</package>`;

  it('reads the metadata, the manifest and the reading order', () => {
    const parsed = parsePackage(
      opf(`<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
             <dc:title>Moby-Dick</dc:title>
             <dc:creator>Herman Melville</dc:creator>
             <dc:identifier>urn:isbn:1</dc:identifier>
             <dc:language>en</dc:language>
           </metadata>
           <manifest>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
             <item id="b" href="ch2.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine><itemref idref="a"/><itemref idref="b"/></spine>`),
      'OEBPS/content.opf',
    );
    expect(parsed.meta).toEqual({
      title: 'Moby-Dick',
      author: 'Herman Melville',
      identifier: 'urn:isbn:1',
      language: 'en',
    });
    expect(parsed.spine.map((item) => item.path)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
    ]);
  });

  it('finds elements written with a namespace prefix', () => {
    // Both spellings are valid and both are in the wild. Matching the
    // qualified name finds one of them, which is how a perfectly good book
    // ends up with an empty manifest.
    const parsed = parsePackage(
      `<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
         <opf:manifest>
           <opf:item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         </opf:manifest>
         <opf:spine><opf:itemref idref="a"/></opf:spine>
       </opf:package>`,
      'content.opf',
    );
    expect(parsed.spine).toHaveLength(1);
  });

  it('keeps the reading order the spine gives, not the manifest order', () => {
    // The manifest is a set of files; the spine is the book. A reader that
    // follows the manifest reads the chapters in whatever order the packaging
    // tool happened to list them.
    const parsed = parsePackage(
      opf(`<manifest>
             <item id="b" href="ch2.xhtml" media-type="application/xhtml+xml"/>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine><itemref idref="a"/><itemref idref="b"/></spine>`),
      'content.opf',
    );
    expect(parsed.spine.map((item) => item.path)).toEqual([
      'ch1.xhtml',
      'ch2.xhtml',
    ]);
  });

  it('skips a spine entry that names nothing, and reads the rest', () => {
    const parsed = parsePackage(
      opf(`<manifest>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine><itemref idref="missing"/><itemref idref="a"/></spine>`),
      'content.opf',
    );
    expect(parsed.spine.map((item) => item.path)).toEqual(['ch1.xhtml']);
  });

  it('refuses a package with nothing to read', () => {
    expect(() =>
      parsePackage(opf('<manifest/><spine/>'), 'content.opf'),
    ).toThrow(/no chapters/);
  });

  it('finds the EPUB 3 navigation document by its property', () => {
    const parsed = parsePackage(
      opf(`<manifest>
             <item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="scripted nav"/>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine><itemref idref="a"/></spine>`),
      'OEBPS/content.opf',
    );
    expect(parsed.navPath).toBe('OEBPS/nav.xhtml');
  });

  it('finds the EPUB 2 navigation document from the spine', () => {
    const parsed = parsePackage(
      opf(`<manifest>
             <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine toc="ncx"><itemref idref="a"/></spine>`),
      'OEBPS/content.opf',
    );
    expect(parsed.ncxPath).toBe('OEBPS/toc.ncx');
  });

  it('drops a manifest entry that points off the machine', () => {
    // A remote resource in the manifest is a network request the moment it is
    // rendered, and this extension makes none.
    const parsed = parsePackage(
      opf(`<manifest>
             <item id="r" href="https://example.com/ch0.xhtml" media-type="application/xhtml+xml"/>
             <item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/>
           </manifest>
           <spine><itemref idref="r"/><itemref idref="a"/></spine>`),
      'content.opf',
    );
    expect(parsed.spine.map((item) => item.path)).toEqual(['ch1.xhtml']);
  });
});

describe('parseNav', () => {
  const nav = (inner: string): string =>
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${inner}</body></html>`;

  it('reads a nested table of contents with its depths', () => {
    const toc = parseNav(
      nav(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>
             <li><a href="ch1.xhtml">One</a>
               <ol><li><a href="ch1.xhtml#s2">One, part two</a></li></ol>
             </li>
             <li><a href="ch2.xhtml">Two</a></li>
           </ol></nav>`),
      'OEBPS/nav.xhtml',
    );
    expect(toc).toEqual([
      { label: 'One', path: 'OEBPS/ch1.xhtml', fragment: '', depth: 0 },
      {
        label: 'One, part two',
        path: 'OEBPS/ch1.xhtml',
        fragment: 's2',
        depth: 1,
      },
      { label: 'Two', path: 'OEBPS/ch2.xhtml', fragment: '', depth: 0 },
    ]);
  });

  it('takes the contents, not the page list', () => {
    // A navigation document may hold several navs. Only one is the table of
    // contents, and taking the first would give the reader a list of page
    // numbers where the chapters should be.
    const toc = parseNav(
      nav(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="page-list"><ol>
             <li><a href="ch1.xhtml#p1">1</a></li>
           </ol></nav>
           <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>
             <li><a href="ch1.xhtml">One</a></li>
           </ol></nav>`),
      'nav.xhtml',
    );
    expect(toc.map((entry) => entry.label)).toEqual(['One']);
  });

  it('accepts the ARIA spelling as well as the epub one', () => {
    const toc = parseNav(
      nav(
        `<nav role="doc-toc"><ol><li><a href="ch1.xhtml">One</a></li></ol></nav>`,
      ),
      'nav.xhtml',
    );
    expect(toc.map((entry) => entry.label)).toEqual(['One']);
  });

  it('keeps a heading that links nowhere out of the list', () => {
    const toc = parseNav(
      nav(`<nav role="doc-toc"><ol>
             <li><span>Part One</span><ol><li><a href="ch1.xhtml">One</a></li></ol></li>
           </ol></nav>`),
      'nav.xhtml',
    );
    expect(toc.map((entry) => [entry.label, entry.path])).toEqual([
      ['Part One', ''],
      ['One', 'ch1.xhtml'],
    ]);
  });
});

describe('parseNcx', () => {
  it('reads a nested navMap with its depths', () => {
    const toc = parseNcx(
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
         <navPoint><navLabel><text>One</text></navLabel><content src="ch1.xhtml"/>
           <navPoint><navLabel><text>One, part two</text></navLabel><content src="ch1.xhtml#s2"/></navPoint>
         </navPoint>
         <navPoint><navLabel><text>Two</text></navLabel><content src="ch2.xhtml"/></navPoint>
       </navMap></ncx>`,
      'OEBPS/toc.ncx',
    );
    expect(toc).toEqual([
      { label: 'One', path: 'OEBPS/ch1.xhtml', fragment: '', depth: 0 },
      {
        label: 'One, part two',
        path: 'OEBPS/ch1.xhtml',
        fragment: 's2',
        depth: 1,
      },
      { label: 'Two', path: 'OEBPS/ch2.xhtml', fragment: '', depth: 0 },
    ]);
  });

  it('takes the label of the point, not of its children', () => {
    // <text> appears at every level, so a search that is not scoped to the
    // point's own navLabel returns the first descendant's label for everyone.
    const toc = parseNcx(
      `<ncx><navMap>
         <navPoint><navLabel><text>Parent</text></navLabel><content src="a.xhtml"/>
           <navPoint><navLabel><text>Child</text></navLabel><content src="b.xhtml"/></navPoint>
         </navPoint>
       </navMap></ncx>`,
      'toc.ncx',
    );
    expect(toc.map((entry) => entry.label)).toEqual(['Parent', 'Child']);
  });
});

describe('openEpub', () => {
  it('opens a book and reads its chapters in order', async () => {
    const book = await openEpub(
      await buildEpub({ title: 'A Book', author: 'An Author' }),
    );
    expect(book.title).toBe('A Book');
    expect(book.author).toBe('An Author');
    expect(book.spine.map((item) => item.path)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
    ]);
    expect(await book.readText('OEBPS/ch1.xhtml')).toContain('first chapter');
  });

  it('opens a book whose package file sits in the archive root', async () => {
    const book = await openEpub(await buildEpub({ packageDir: '' }));
    expect(book.spine.map((item) => item.path)).toEqual([
      'ch1.xhtml',
      'ch2.xhtml',
    ]);
  });

  it('reads an EPUB 2 table of contents', async () => {
    const book = await openEpub(await buildEpub({ nav: 'ncx' }));
    expect(book.toc.map((entry) => entry.label)).toEqual(['One', 'Two']);
  });

  it('prefers the EPUB 3 navigation document when a book ships both', async () => {
    // Books that declare EPUB 3 routinely carry an NCX as well, for readers
    // that predate the change. The newer one is the one the publisher
    // maintains.
    const book = await openEpub(await buildEpub({ nav: 'both' }));
    expect(book.toc).toHaveLength(2);
  });

  it('opens a book with no table of contents at all', async () => {
    const book = await openEpub(await buildEpub({ nav: 'none' }));
    expect(book.toc).toEqual([]);
    expect(book.spine).toHaveLength(2);
  });

  it('keeps reading when the table of contents is broken', async () => {
    // Contents are a convenience. A malformed navigation document must cost
    // the sidebar, not the book.
    const bytes = await buildEpub({
      nav: 'none',
      extra: [{ name: 'OEBPS/nav.xhtml', body: '<html' }],
    });
    const book = await openEpub(bytes);
    expect(book.spine).toHaveLength(2);
    expect(book.toc).toEqual([]);
  });

  it('names DRM rather than rendering ciphertext as a chapter', async () => {
    // A copy-protected book is a well-formed EPUB whose chapters are
    // encrypted, so every other check passes and the reader paints a page of
    // mojibake. Most books bought from a shop are like this, and the key is
    // not in the file — saying so is the whole of what can be done.
    const bytes = await buildEpub({
      extra: [
        {
          name: 'META-INF/encryption.xml',
          body: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
        },
      ],
    });
    await expect(openEpub(bytes)).rejects.toThrow(/copy-protected|DRM/);
  });

  it('tells a zip that is not an EPUB from a file that is not a zip', async () => {
    const notAnEpub = await buildZip([{ name: 'notes.txt', body: 'hello' }]);
    await expect(openEpub(notAnEpub)).rejects.toThrow(/not an EPUB/);
    await expect(
      openEpub(new TextEncoder().encode('this is not a zip')),
    ).rejects.toThrow(/could not be opened/);
  });
});
