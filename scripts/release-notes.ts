/**
 * Extract one version's section out of CHANGELOG.md so a GitHub release can be
 * published with the notes that were already written by hand.
 *
 * The alternative — `gh release create --generate-notes` — lists commit
 * subjects. This project's changelog explains *why* each release happened, and
 * the release page is the first thing a stranger reads. Reusing it costs one
 * pure function; regenerating a worse version of it costs nothing but is worse.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strip an optional leading `v` so `v2.2.15` and `2.2.15` both resolve. */
export function normaliseVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Return the body of the `## [<version>] - <date>` section, without its own
 * heading, or `null` when the changelog has no entry for that version.
 *
 * A section runs until the next `## ` heading at the start of a line, or the
 * end of the file for the newest entry.
 */
export function extractReleaseNotes(
  changelog: string,
  tag: string,
): string | null {
  const version = normaliseVersion(tag);
  const lines = changelog.split(/\r?\n/);

  // Match the version inside brackets exactly, so 2.2.1 never matches the
  // heading for 2.2.15.
  const heading = lines.findIndex(
    (line) =>
      line.startsWith('## ') &&
      new RegExp(`^## \\[${escapeRegExp(version)}\\](\\s|$)`).test(line),
  );
  if (heading === -1) return null;

  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith('## ')) {
      end = i;
      break;
    }
  }

  return lines
    .slice(heading + 1, end)
    .join('\n')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CLI: `tsx scripts/release-notes.ts v2.2.15` prints the section to stdout. */
async function main(): Promise<void> {
  const tag = process.argv[2];
  if (!tag) {
    process.stderr.write('usage: release-notes.ts <tag>\n');
    process.exit(1);
  }

  const changelog = await readFile(
    new URL('../CHANGELOG.md', import.meta.url),
    'utf8',
  );
  const notes = extractReleaseNotes(changelog, tag);

  // Publishing a release whose notes silently fell back to something generic is
  // the failure mode worth being loud about — the tag is already pushed by the
  // time this runs, so a wrong-but-successful release is hard to walk back.
  if (notes === null) {
    process.stderr.write(
      `CHANGELOG.md has no section for ${tag}. Add one before tagging.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${notes}\n`);
}

// Only run the CLI when invoked directly, so a test can import the pure part
// without the module exiting the process out from under it.
const invokedAs = process.argv[1];
if (invokedAs && resolve(invokedAs) === fileURLToPath(import.meta.url)) {
  void main();
}
