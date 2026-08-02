import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  extractReleaseNotes,
  normaliseVersion,
} from '../scripts/release-notes';

const CHANGELOG = `# Changelog

Preamble prose that belongs to no release.

## [2.2.15] - 2026-07-31

### Added

- The newest thing.

## [2.2.1] - 2026-07-20

### Fixed

- An older thing.

## [2.2.0] - 2026-07-10
`;

describe('normaliseVersion', () => {
  it('strips a leading v so both tag styles resolve', () => {
    expect(normaliseVersion('v2.2.15')).toBe('2.2.15');
    expect(normaliseVersion('2.2.15')).toBe('2.2.15');
  });
});

describe('extractReleaseNotes', () => {
  it('returns the newest section, which runs to the end of the file', () => {
    // 2.2.0 is last in the file and has no body; the section boundary has to
    // come from end-of-file rather than from a following heading.
    expect(extractReleaseNotes(CHANGELOG, 'v2.2.0')).toBe('');
  });

  it('stops at the next release heading', () => {
    const notes = extractReleaseNotes(CHANGELOG, 'v2.2.15');
    expect(notes).toBe('### Added\n\n- The newest thing.');
    expect(notes).not.toContain('An older thing');
  });

  it('drops the version heading itself', () => {
    expect(extractReleaseNotes(CHANGELOG, 'v2.2.15')).not.toContain('[2.2.15]');
  });

  it('never lets a shorter version match a longer one', () => {
    // The bug this guards: a plain `includes('2.2.1')` scan finds the 2.2.15
    // heading first and ships the wrong release notes.
    expect(extractReleaseNotes(CHANGELOG, 'v2.2.1')).toBe(
      '### Fixed\n\n- An older thing.',
    );
  });

  it('returns null for a version the changelog does not document', () => {
    expect(extractReleaseNotes(CHANGELOG, 'v9.9.9')).toBeNull();
  });

  it('excludes the file preamble', () => {
    const notes = extractReleaseNotes(CHANGELOG, 'v2.2.15');
    expect(notes).not.toContain('belongs to no release');
  });

  it('finds a section for the version this repo currently ships', async () => {
    // Guards the real coupling: the release workflow refuses to publish when
    // CHANGELOG.md has no entry for the tag, so a version bump that forgets the
    // changelog should fail here rather than in CI after the tag is pushed.
    const [changelog, pkg] = await Promise.all([
      readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ]);
    const { version } = JSON.parse(pkg) as { version: string };

    const notes = extractReleaseNotes(changelog, version);
    expect(notes, `CHANGELOG.md has no section for ${version}`).not.toBeNull();
    expect(notes?.length).toBeGreaterThan(0);
  });
});
