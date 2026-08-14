/**
 * Reading a zip archive, with nothing installed.
 *
 * An EPUB is a zip file, so opening one starts here. The obvious move is a zip
 * library, and the reason there is none is that the browser already ships the
 * hard half: `DecompressionStream('deflate-raw')` is the same inflate a zip
 * library bundles, exposed as a platform API. What a library would add on top
 * is the container format below — an end-of-central-directory record, a table
 * of file headers, and the arithmetic to find where each entry's bytes begin.
 * That is a few hundred lines, it is fully specified, and it can be unit
 * tested against archives built in the test, which is a better trade than
 * another dependency inside a Chrome Web Store package.
 *
 * Byte-level and framework-free: no DOM, no `chrome.*`, no network. The EPUB
 * structure that sits on top of these bytes needs `DOMParser` and therefore
 * lives in `ui/epub.ts` instead.
 *
 * Format reference: PKWARE APPNOTE.TXT, sections 4.3.6-4.3.16.
 */

/** Local file header, central directory header, end of central directory. */
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Fixed sizes of the three records, before their variable-length tails. */
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/**
 * A zip comment may be up to 65,535 bytes, and the end-of-central-directory
 * record sits immediately before it — so the record is somewhere in the last
 * 64 KB and its position is not otherwise knowable. Scanning backwards finds
 * it in a handful of bytes for the overwhelmingly common case of no comment
 * at all.
 */
const MAX_COMMENT = 0xffff;

/** The two compression methods a zip may use that this reader accepts. */
const STORED = 0;
const DEFLATED = 8;

/**
 * Whatever a 32-bit field holds when the real value did not fit in it. Zip64
 * moves the value into an extra field; see `readCentralDirectory`.
 */
const OVERFLOW_32 = 0xffffffff;
const OVERFLOW_16 = 0xffff;

export interface ZipEntry {
  /** The path inside the archive, `/`-separated, as stored. */
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where this entry's *local* header starts, from the top of the archive. */
  headerOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The offset of the end-of-central-directory record, or -1.
 *
 * Searched from the end, because that is where it is, and because a zip may
 * legitimately contain the same four bytes inside a compressed entry — a
 * forward scan would find one of those first and read a table out of file
 * data.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - EOCD_SIZE - MAX_COMMENT);
  for (let at = view.byteLength - EOCD_SIZE; at >= earliest; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    // The record claims how long its comment is, and the comment is the rest
    // of the file. Checking that lets a false positive inside entry data be
    // rejected rather than parsed.
    const commentLength = view.getUint16(at + 20, true);
    if (at + EOCD_SIZE + commentLength === view.byteLength) return at;
  }
  return -1;
}

/**
 * Every entry in the archive, in central-directory order.
 *
 * The central directory is read rather than the local headers, and the
 * difference matters: an archive written by a streaming producer sets the
 * local header's sizes to zero and puts the real ones in a data descriptor
 * *after* the compressed bytes, so a reader that trusts the local header sees
 * a zero-length file. The central directory always carries the true sizes.
 */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = viewOf(bytes);
  if (bytes.byteLength < EOCD_SIZE) {
    throw new ZipError('Not a zip file: too short to hold a directory.');
  }

  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) {
    throw new ZipError(
      'Not a zip file, or the archive is truncated: no end-of-central-directory record.',
    );
  }

  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  // Zip64 signals itself by saturating the 32-bit fields and moving the real
  // values into a separate record. Nothing this reader opens needs it — a
  // 4 GB EPUB is not a thing — and guessing is worse than saying so.
  if (count === OVERFLOW_16 || directoryOffset === OVERFLOW_32) {
    throw new ZipError('Zip64 archives are not supported.');
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_SIZE > bytes.byteLength) {
      throw new ZipError(
        'Truncated archive: the file table runs past the end.',
      );
    }
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError(
        `Corrupt archive: bad file header at byte ${String(at)}.`,
      );
    }

    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const headerOffset = view.getUint32(at + 42, true);

    if (
      compressedSize === OVERFLOW_32 ||
      uncompressedSize === OVERFLOW_32 ||
      headerOffset === OVERFLOW_32
    ) {
      throw new ZipError('Zip64 archives are not supported.');
    }

    const nameStart = at + CENTRAL_HEADER_SIZE;
    const name = decodeText(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      headerOffset,
    });

    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes, decompressed.
 *
 * The local header has to be read even though the central directory already
 * described the entry, because only the local header says how long its own
 * name and extra fields are — and the compressed bytes begin right after
 * them. The two headers disagree about extra-field length routinely; using
 * the central directory's would land in the middle of the data.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<Uint8Array> {
  const view = viewOf(bytes);
  const at = entry.headerOffset;
  if (
    at + LOCAL_HEADER_SIZE > bytes.byteLength ||
    view.getUint32(at, true) !== LOCAL_SIGNATURE
  ) {
    throw new ZipError(`Corrupt archive: no file header for "${entry.name}".`);
  }

  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) {
    throw new ZipError(`Truncated archive: "${entry.name}" runs past the end.`);
  }

  const raw = bytes.subarray(start, end);
  if (entry.method === STORED) return raw;
  if (entry.method !== DEFLATED) {
    throw new ZipError(
      `"${entry.name}" uses compression method ${String(entry.method)}, which this reader does not implement.`,
    );
  }
  // An empty deflate stream is two bytes of nothing; skipping it avoids
  // depending on how the platform's inflate answers a zero-length input.
  if (entry.uncompressedSize === 0) return new Uint8Array(0);
  return inflateRaw(raw);
}

/**
 * Inflate, by the browser's own implementation.
 *
 * `deflate-raw` rather than `deflate`: zip stores the compressed stream with
 * no zlib header around it, and the wrapped decoder rejects it outright.
 *
 * The source is a hand-built `ReadableStream` rather than `blob.stream()`,
 * which is the shorter spelling and unavailable in jsdom — so writing it that
 * way would put every test of this file in a real browser or nowhere.
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Typed as `BufferSource` rather than `Uint8Array`, because that is what
  // `DecompressionStream` accepts and the two do not unify the other way.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // Copied out of the archive: `data` is a view over the whole file, and
      // a stream handed the view keeps the entire buffer alive behind it.
      controller.enqueue(data.slice());
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * UTF-8 text from bytes, without a byte-order mark.
 *
 * A BOM is legal at the start of an XML document and is invisible to a human
 * reading the file — but it is a character, and `DOMParser` answers a document
 * that starts with one by producing a parse error rather than a document. So
 * the one place it can do damage is exactly the files an EPUB is made of.
 */
export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Entries by name, for the many lookups that follow.
 *
 * A leading `./` is stripped: it names the same file and appears in real
 * archives, but a `Map` keyed on the raw string would treat it as a different
 * one.
 */
export function entryMap(entries: ZipEntry[]): Map<string, ZipEntry> {
  const map = new Map<string, ZipEntry>();
  for (const entry of entries) {
    map.set(entry.name.replace(/^\.\//, ''), entry);
  }
  return map;
}
