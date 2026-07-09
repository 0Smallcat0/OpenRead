/**
 * Capture note builder — turns a `CaptureNote` into the Markdown document and
 * the `obsidian://new` URI used to drop it into a vault. Pure and
 * side-effect-free: the actual navigation / clipboard write lives in the UI
 * shell, so every byte of the emitted note and URL is unit-testable and
 * diffable.
 *
 * The YAML frontmatter is the handoff contract to a downstream "second brain":
 * a stable, machine-readable header (source, url, captured, from/to, status,
 * tags) that a stronger model can query and rewrite later. OpenRead only ever
 * writes `status: raw` — heavy synthesis is deliberately deferred.
 */
import type { CaptureNote, EnrichResult } from './types';

/** Characters illegal in a vault filename (Windows-safe) plus Obsidian-special. */
const ILLEGAL_FILENAME = /[\\/:*?"<>|#^[\]]/g;

/** Escape a string for a double-quoted YAML scalar (single line). */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return `"${escaped}"`;
}

/** Render a tag list as a YAML flow sequence: `[a, b, c]`. */
function yamlTags(tags: string[]): string {
  const safe = tags.map((t) => t.replace(/[[\],]/g, '').trim()).filter(Boolean);
  return `[${safe.join(', ')}]`;
}

/** Prefix every line of `text` with `> ` to form a Markdown blockquote. */
function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Compact a timestamp for a filename: an ISO string becomes `YYYYMMDD-HHMM`.
 * Non-ISO input is reduced to its alphanumeric characters as a fallback.
 */
function compactStamp(iso: string): string {
  if (iso.length < 16) return iso.replace(/[^0-9A-Za-z]/g, '');
  return (
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    '-' +
    iso.slice(11, 13) +
    iso.slice(14, 16)
  );
}

/** Build the full Markdown document (frontmatter + body) for a capture. */
export function buildMarkdown(note: CaptureNote): string {
  const front = [
    '---',
    `title: ${yamlQuote(note.title)}`,
    `source: ${yamlQuote(note.source)}`,
    `url: ${note.url}`,
    `captured: ${note.capturedAt}`,
    `from: ${note.from}`,
    `to: ${yamlQuote(note.to)}`,
    `status: ${note.status}`,
    `tags: ${yamlTags(note.tags)}`,
    '---',
  ].join('\n');

  const parts: string[] = [
    front,
    '',
    '## Original',
    '',
    blockquote(note.original.trim()),
    '',
    '## Translation',
    '',
    note.translation.trim(),
  ];
  if (note.summary && note.summary.trim()) {
    parts.push('', '## Summary', '', note.summary.trim());
  }
  return parts.join('\n') + '\n';
}

/** Vault filename (no extension): a sanitised title plus a compact timestamp. */
export function captureFilename(note: CaptureNote): string {
  const base =
    (note.title || note.source || 'capture')
      .replace(ILLEGAL_FILENAME, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'capture';
  return `${base} ${compactStamp(note.capturedAt)}`.trim();
}

export interface ObsidianUriOptions {
  /** Target vault; omit to let Obsidian use the current/last vault. */
  vault?: string;
  /** Vault-relative folder; omit to write at the vault root. */
  folder?: string;
  /** Filename without extension. */
  filename: string;
  /** Full Markdown body. */
  content: string;
}

/**
 * Build an `obsidian://new` URI. Every value is `encodeURIComponent`-escaped
 * (so spaces become `%20`, which Obsidian's `decodeURIComponent` restores — a
 * form-encoded `+` would not).
 */
export function buildObsidianUri(opts: ObsidianUriOptions): string {
  const path = opts.folder ? `${opts.folder}/${opts.filename}` : opts.filename;
  const params = [
    opts.vault ? `vault=${encodeURIComponent(opts.vault)}` : null,
    `file=${encodeURIComponent(path)}`,
    `content=${encodeURIComponent(opts.content)}`,
  ].filter((p): p is string => p !== null);
  return `obsidian://new?${params.join('&')}`;
}

/**
 * Unwrap the bundled PDF.js viewer URL back to the real document URL, so a
 * capture from a PDF records the paper's address, not the extension viewer's.
 */
export function resolveSourceUrl(href: string): string {
  const marker = '/pdfjs/web/viewer.html';
  const idx = href.indexOf(marker);
  if (idx < 0) return href;
  const q = href.indexOf('?', idx);
  if (q < 0) return href;
  try {
    const params = new URLSearchParams(href.slice(q + 1));
    const file = params.get('file');
    return file ? decodeURIComponent(file) : href;
  } catch {
    return href;
  }
}

/**
 * Merge best-effort enrichment into a capture: an enriched title/summary wins
 * when present, and new tags are appended without duplicating existing ones.
 * Pure — returns a new note, never mutates the input.
 */
export function applyEnrichment(
  note: CaptureNote,
  enrich: EnrichResult,
): CaptureNote {
  const tags = [...note.tags];
  for (const tag of enrich.tags ?? []) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  return {
    ...note,
    title: enrich.title?.trim() || note.title,
    summary: enrich.summary?.trim() || note.summary,
    tags,
  };
}
