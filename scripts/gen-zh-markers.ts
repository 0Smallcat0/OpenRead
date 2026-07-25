/**
 * Derives the Simplified-only / Traditional-only character sets that
 * `src/core/language.ts` uses for script detection, straight from the OpenCC
 * dictionaries, and writes `src/core/zh-markers.generated.ts`.
 *
 * The lists were hand-written before, which went wrong in both directions:
 * characters Simplified merged into one shared form (系 for 系/係/繫, 游 for
 * 游/遊) were listed as Simplified-only even though they are ordinary
 * Traditional characters, while common Simplified characters (发, 时, 们, 开,
 * 软, 机) were simply missing. Both failure modes disappear when the sets come
 * from the same dictionaries the converter itself uses.
 *
 * Run with `pnpm gen:markers`. `language.test.ts` re-derives the sets and fails
 * if the committed file has drifted, so a dependency bump cannot silently
 * change script detection.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DICT = join(ROOT, 'node_modules/opencc-js/dist/esm-lib/dict');

/** Parse one dictionary into `[key, values]` pairs. */
export function loadDict(name: string): [string, string[]][] {
  const src = readFileSync(join(DICT, `${name}.js`), 'utf8');
  const table = /export default "([\s\S]*)"/.exec(src)?.[1] ?? '';
  return table
    .split('|')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const i = entry.indexOf(' ');
      return i < 0
        ? ([entry, []] as [string, string[]])
        : ([entry.slice(0, i), entry.slice(i + 1).split(' ')] as [
            string,
            string[],
          ]);
    });
}

/** Single-character keys of a dictionary. */
function singleCharKeys(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    for (const [key] of loadDict(name)) {
      if ([...key].length === 1) out.add(key);
    }
  }
  return out;
}

/** Every character these dictionaries can produce on their output side. */
function outputCharacters(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    for (const [, values] of loadDict(name)) {
      for (const value of values) for (const c of value) out.add(c);
    }
  }
  return out;
}

/**
 * Characters that occur in one script and never in the other.
 *
 * A character is Simplified-only when the converter maps it away *and* neither
 * conversion direction can ever emit it as Traditional. The mirror rule gives
 * the Traditional-only set. Characters shared by both scripts — every merged
 * form, plus script-neutral characters like 肉 and 嘴 — fall out of both sets,
 * which is the whole point.
 */
export function deriveMarkers(): { sc: string[]; tc: string[] } {
  const simplifiedSide = singleCharKeys(['STCharacters']);
  const traditionalSide = singleCharKeys(['TSCharacters']);
  const traditionalOutput = outputCharacters([
    'STCharacters',
    'STPhrases',
    'TWVariants',
    'TWVariantsPhrases',
    'TWPhrases',
  ]);
  const simplifiedOutput = outputCharacters(['TSCharacters', 'TSPhrases']);

  const sc = [...simplifiedSide].filter(
    (c) => !traditionalOutput.has(c) && !traditionalSide.has(c),
  );
  const tc = [...traditionalSide].filter(
    (c) => !simplifiedOutput.has(c) && !simplifiedSide.has(c),
  );
  const byCodePoint = (a: string, b: string) =>
    (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0);
  return { sc: sc.sort(byCodePoint), tc: tc.sort(byCodePoint) };
}

/** Escape a character for use inside a regular-expression character class. */
function escapeForClass(c: string): string {
  return /[\\\]^-]/.test(c) ? `\\${c}` : c;
}

/**
 * Collapse a sorted character list into a character-class body, folding runs of
 * consecutive code points into ranges. Thousands of characters compress to a
 * few hundred, and the engine matches ranges rather than a long alternation.
 */
export function toCharClass(chars: string[]): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const start = i;
    while (
      i + 1 < chars.length &&
      (chars[i + 1]?.codePointAt(0) ?? 0) ===
        (chars[i]?.codePointAt(0) ?? 0) + 1
    ) {
      i++;
    }
    const first = escapeForClass(chars[start] ?? '');
    const last = escapeForClass(chars[i] ?? '');
    if (i - start >= 2) out += `${first}-${last}`;
    else for (let j = start; j <= i; j++) out += escapeForClass(chars[j] ?? '');
  }
  return out;
}

function generate(): string {
  const { sc, tc } = deriveMarkers();
  const version = (
    JSON.parse(
      readFileSync(join(ROOT, 'node_modules/opencc-js/package.json'), 'utf8'),
    ) as { version: string }
  ).version;

  return `/**
 * GENERATED FILE — do not edit by hand.
 * Run \`pnpm gen:markers\` to regenerate; \`language.test.ts\` guards it.
 *
 * Characters that occur in exactly one Chinese script, derived from the
 * opencc-js ${version} dictionaries by \`scripts/gen-zh-markers.ts\`.
 * Characters shared by both scripts are in neither set.
 */

/** ${sc.length} characters that appear in Simplified Chinese only. */
export const SC_ONLY_CLASS =
  '${toCharClass(sc)}';

/** ${tc.length} characters that appear in Traditional Chinese only. */
export const TC_ONLY_CLASS =
  '${toCharClass(tc)}';
`;
}

// Only write when run as a script; `language.test.ts` imports the derivation
// to check the committed file for drift and must not touch the filesystem.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(ROOT, 'src/core/zh-markers.generated.ts');
  writeFileSync(target, generate(), 'utf8');
  const { sc, tc } = deriveMarkers();
  console.log(
    `wrote src/core/zh-markers.generated.ts — ${sc.length} SC-only, ${tc.length} TC-only characters`,
  );
}
