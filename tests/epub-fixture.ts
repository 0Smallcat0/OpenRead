/**
 * Zip and EPUB archives, built in memory, for the tests that read them.
 *
 * A committed `.epub` fixture proves the reader can open one book that one
 * tool once produced. Building the bytes here means a test can state the
 * property it is about — a data descriptor, an EPUB 2 navigation file, a
 * package file in the archive root — and a reader that only copes with
 * well-behaved archives fails visibly rather than passing on the one file it
 * was written against.
 *
 * Not under `src/`, and not named `*.test.ts`, so it is neither collected as a
 * suite nor counted as shipped code.
 */

export interface FileSpec {
  name: string;
  body: string;
  /** Store instead of deflate, as `mimetype` is required to be. */
  stored?: boolean;
  /**
   * Write zeroes into the local header's size fields, the way a producer that
   * streams its output does, leaving the truth to the central directory.
   */
  dataDescriptor?: boolean;
  /** Override the compression method recorded for this entry. */
  method?: number;
}

/** The mirror of `core/zip.ts`'s inflate, avoiding Blob for the same reason. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
  const stream = source.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildZip(
  files: FileSpec[],
  comment = '',
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const plain = encoder.encode(file.body);
    const stored = file.stored ?? false;
    const payload = stored ? plain : await deflateRaw(plain);
    const method = file.method ?? (stored ? 0 : 8);

    const local = new Uint8Array(30 + name.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, file.dataDescriptor ? 0x08 : 0, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, file.dataDescriptor ? 0 : payload.length, true);
    localView.setUint32(22, file.dataDescriptor ? 0 : plain.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(payload, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, plain.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directory = centrals.reduce((total, part) => total + part.length, 0);
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.length);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directory, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, commentBytes.length, true);
  end.set(commentBytes, 22);

  const out = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface ChapterSpec {
  /** File name relative to the package directory. */
  name: string;
  /** What goes inside `<body>`. */
  body: string;
  label?: string;
}

export interface EpubSpec {
  title?: string;
  author?: string;
  identifier?: string;
  language?: string;
  chapters?: ChapterSpec[];
  /** Which flavour of table of contents to ship, if any. */
  nav?: 'epub3' | 'ncx' | 'both' | 'none';
  /** Where the package file lives. '' puts it in the archive root. */
  packageDir?: string;
  /** Anything else to drop into the archive. */
  extra?: FileSpec[];
}

const DEFAULT_CHAPTERS: ChapterSpec[] = [
  {
    name: 'ch1.xhtml',
    body: '<p>The first chapter of the book.</p>',
    label: 'One',
  },
  {
    name: 'ch2.xhtml',
    body: '<p>The second chapter of the book.</p>',
    label: 'Two',
  },
];

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;
}

export async function buildEpub(spec: EpubSpec = {}): Promise<Uint8Array> {
  const {
    title = 'A Book',
    author = 'An Author',
    identifier = 'urn:uuid:0000',
    language = 'en',
    chapters = DEFAULT_CHAPTERS,
    nav = 'epub3',
    packageDir = 'OEBPS',
    extra = [],
  } = spec;

  const dir = packageDir ? `${packageDir}/` : '';
  const hasNav = nav === 'epub3' || nav === 'both';
  const hasNcx = nav === 'ncx' || nav === 'both';

  const manifest = [
    ...chapters.map(
      (chapter, i) =>
        `<item id="c${String(i)}" href="${chapter.name}" media-type="application/xhtml+xml"/>`,
    ),
    hasNav
      ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
      : '',
    hasNcx
      ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
      : '',
  ].join('');

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:identifier id="id">${identifier}</dc:identifier>
    <dc:language>${language}</dc:language>
  </metadata>
  <manifest>${manifest}</manifest>
  <spine${hasNcx ? ' toc="ncx"' : ''}>${chapters
    .map((_, i) => `<itemref idref="c${String(i)}"/>`)
    .join('')}</spine>
</package>`;

  const navDoc = xhtml(
    `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>${chapters
      .map(
        (chapter, i) =>
          `<li><a href="${chapter.name}">${chapter.label ?? `Chapter ${String(i + 1)}`}</a></li>`,
      )
      .join('')}</ol></nav>`,
  );

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>${chapters
    .map(
      (chapter, i) =>
        `<navPoint id="n${String(i)}" playOrder="${String(i + 1)}"><navLabel><text>${
          chapter.label ?? `Chapter ${String(i + 1)}`
        }</text></navLabel><content src="${chapter.name}"/></navPoint>`,
    )
    .join('')}</navMap>
</ncx>`;

  const files: FileSpec[] = [
    { name: 'mimetype', body: 'application/epub+zip', stored: true },
    {
      name: 'META-INF/container.xml',
      body: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${dir}content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: `${dir}content.opf`, body: opf },
    ...chapters.map((chapter) => ({
      name: `${dir}${chapter.name}`,
      body: xhtml(chapter.body),
    })),
    ...(hasNav ? [{ name: `${dir}nav.xhtml`, body: navDoc }] : []),
    ...(hasNcx ? [{ name: `${dir}toc.ncx`, body: ncx }] : []),
    ...extra,
  ];

  return buildZip(files);
}
