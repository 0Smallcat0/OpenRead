import { describe, it, expect } from 'vitest';
import {
  readCentralDirectory,
  readZipEntry,
  decodeText,
  entryMap,
  ZipError,
} from './zip';
import { buildZip } from '../../tests/epub-fixture';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('readCentralDirectory', () => {
  it('lists every entry, in order', async () => {
    const zip = await buildZip([
      { name: 'mimetype', body: 'application/epub+zip', stored: true },
      { name: 'META-INF/container.xml', body: '<container/>' },
      { name: 'OEBPS/ch1.xhtml', body: '<p>one</p>' },
    ]);
    expect(readCentralDirectory(zip).map((entry) => entry.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/ch1.xhtml',
    ]);
  });

  it('finds the directory behind an archive comment', async () => {
    // The end-of-central-directory record is not at the end of the file when
    // a comment follows it, so its position has to be searched for.
    const zip = await buildZip(
      [{ name: 'a.txt', body: 'hello there, reader' }],
      'packed by something chatty',
    );
    expect(readCentralDirectory(zip)).toHaveLength(1);
  });

  it('rejects a file that is not a zip', () => {
    const notAZip = new TextEncoder().encode('this is a plain text file');
    expect(() => readCentralDirectory(notAZip)).toThrow(ZipError);
  });

  it('rejects an empty file rather than reading past it', () => {
    expect(() => readCentralDirectory(new Uint8Array(4))).toThrow(ZipError);
  });
});

describe('readZipEntry', () => {
  it('inflates a deflated entry', async () => {
    const body = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
    const zip = await buildZip([{ name: 'ch1.xhtml', body }]);
    const [entry] = readCentralDirectory(zip);
    expect(entry).toBeDefined();
    expect(entry?.method).toBe(8);
    expect(text(await readZipEntry(zip, entry!))).toBe(body);
  });

  it('passes a stored entry through', async () => {
    // `mimetype` is required to be stored and first, so this is not a corner.
    const zip = await buildZip([
      { name: 'mimetype', body: 'application/epub+zip', stored: true },
    ]);
    const [entry] = readCentralDirectory(zip);
    expect(text(await readZipEntry(zip, entry!))).toBe('application/epub+zip');
  });

  it('reads an entry whose local header claims a length of zero', async () => {
    // A streaming producer cannot know the compressed length until it has
    // finished writing, so it puts zeroes in the local header and the truth in
    // the central directory. A reader that trusts the local header hands back
    // an empty chapter, which looks like a book with blank pages rather than
    // like a bug.
    const zip = await buildZip([
      { name: 'ch1.xhtml', body: '<p>not empty</p>', dataDescriptor: true },
    ]);
    const [entry] = readCentralDirectory(zip);
    expect(entry?.uncompressedSize).toBe(16);
    expect(text(await readZipEntry(zip, entry!))).toBe('<p>not empty</p>');
  });

  it('handles an entry with no bytes in it', async () => {
    const zip = await buildZip([{ name: 'empty.txt', body: '' }]);
    const [entry] = readCentralDirectory(zip);
    expect(text(await readZipEntry(zip, entry!))).toBe('');
  });

  it('names the method it cannot do rather than returning nonsense', async () => {
    // Method 14 is LZMA. Real, legal in a zip, and not something the platform
    // inflates — so the honest answer is to say which entry and which method.
    const zip = await buildZip([
      { name: 'ch1.xhtml', body: 'text', stored: true, method: 14 },
    ]);
    const [entry] = readCentralDirectory(zip);
    await expect(readZipEntry(zip, entry!)).rejects.toThrow(/method 14/);
  });
});

describe('decodeText', () => {
  it('strips a byte-order mark', () => {
    // Legal at the start of an XML document, invisible to a human, and enough
    // to make DOMParser return a parse error instead of a document.
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]);
    expect(decodeText(withBom)).toBe('<a/>');
  });

  it('leaves ordinary text alone', () => {
    expect(decodeText(new TextEncoder().encode('書'))).toBe('書');
  });
});

describe('entryMap', () => {
  it('keys a leading ./ the same as the path it names', async () => {
    const zip = await buildZip([{ name: './OEBPS/ch1.xhtml', body: 'x' }]);
    expect(entryMap(readCentralDirectory(zip)).has('OEBPS/ch1.xhtml')).toBe(
      true,
    );
  });
});
