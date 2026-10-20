import { describe, it, expect } from 'vitest';
import {
  cueAt,
  isUnspaced,
  lastStarted,
  parseTrack,
  replacesCaptions,
  toCues,
  videoIdOf,
  type Cue,
} from './captions';

/*
 * The fixtures copy the *shape* of the two kinds of track measured on
 * 2026-10-21 — which fields appear, where `\n` sits, what an `aAppend` event
 * carries, how word offsets are given — with text written for these tests.
 */

/** A human transcript: one event per line on screen, punctuated. */
const TRANSCRIPT = {
  events: [
    // The window definition every track opens with. No text.
    { tStartMs: 0, dDurationMs: 90_000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '(Applause)' }] },
    {
      tStartMs: 1200,
      dDurationMs: 2800,
      segs: [{ utf8: 'The river was low that summer,\nand the boats' }],
    },
    {
      tStartMs: 4000,
      dDurationMs: 2500,
      segs: [{ utf8: 'stayed in the harbour for weeks.' }],
    },
    { tStartMs: 6600, dDurationMs: 2000, segs: [{ utf8: 'Nobody minded.' }] },
  ],
};

/**
 * Speech recognition: a timestamp per word, no punctuation, and a line break
 * sent as an event of its own when the rolling line scrolls.
 */
const RECOGNISED = {
  events: [
    { tStartMs: 0, dDurationMs: 90_000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    {
      tStartMs: 200,
      dDurationMs: 3000,
      wWinId: 1,
      segs: [
        { utf8: 'good', acAsrConf: 0 },
        { utf8: ' morning', tOffsetMs: 240, acAsrConf: 0 },
      ],
    },
    {
      tStartMs: 1500,
      dDurationMs: 2000,
      wWinId: 1,
      aAppend: 1,
      segs: [{ utf8: '\n' }],
    },
    {
      tStartMs: 1510,
      dDurationMs: 4000,
      wWinId: 1,
      segs: [
        { utf8: 'today', acAsrConf: 0 },
        { utf8: ' we', tOffsetMs: 300, acAsrConf: 0 },
        { utf8: ' will', tOffsetMs: 520, acAsrConf: 0 },
        { utf8: ' plant', tOffsetMs: 800, acAsrConf: 0 },
        { utf8: ' some', tOffsetMs: 1100, acAsrConf: 0 },
        { utf8: ' trees', tOffsetMs: 1350, acAsrConf: 0 },
      ],
    },
    {
      tStartMs: 6000,
      dDurationMs: 1500,
      wWinId: 1,
      segs: [{ utf8: '[Music]' }],
    },
  ],
};

const texts = (cues: Cue[]): string[] => cues.map((cue) => cue.text);

describe('toCues on a transcript', () => {
  it('joins a sentence that runs across lines and cuts at its full stop', () => {
    const cues = toCues(TRANSCRIPT.events, 'en');
    expect(texts(cues)).toEqual([
      '(Applause)',
      'The river was low that summer, and the boats stayed in the harbour for weeks.',
      'Nobody minded.',
    ]);
    // On screen from the first line it was built from to the end of the last.
    expect(cues[1]).toMatchObject({ start: 1200, end: 6500 });
  });

  it('ends a long sentence at a comma rather than letting it grow', () => {
    const cues = toCues(
      [
        {
          tStartMs: 0,
          dDurationMs: 3000,
          segs: [
            {
              utf8: 'When the first settlers reached the valley, they found the soil thin and the winters long,',
            },
          ],
        },
        {
          tStartMs: 3000,
          dDurationMs: 2000,
          segs: [{ utf8: 'but they stayed anyway.' }],
        },
      ],
      'en',
    );
    expect(texts(cues)).toEqual([
      'When the first settlers reached the valley, they found the soil thin and the winters long,',
      'but they stayed anyway.',
    ]);
  });

  it('does not carry a sentence across a long silence', () => {
    const cues = toCues(
      [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'And then' }] },
        {
          tStartMs: 3000,
          dDurationMs: 1000,
          segs: [{ utf8: 'the lights went out.' }],
        },
        // Punctuated, so the track is read as a transcript at all.
        { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'Silence.' }] },
      ],
      'en',
    );
    expect(texts(cues)).toEqual([
      'And then',
      'the lights went out.',
      'Silence.',
    ]);
  });

  it('writes a language without spaces without inventing any', () => {
    const cues = toCues(
      [
        {
          tStartMs: 0,
          dDurationMs: 1500,
          segs: [{ utf8: '朝の駅は\n静かで、' }],
        },
        {
          tStartMs: 1500,
          dDurationMs: 1500,
          segs: [{ utf8: '鳥の声だけがした。' }],
        },
      ],
      'ja',
    );
    expect(texts(cues)).toEqual(['朝の駅は静かで、鳥の声だけがした。']);
  });
});

describe('toCues on speech recognition', () => {
  it('ends a sentence where the speaker paused', () => {
    const cues = toCues(RECOGNISED.events, 'en');
    expect(texts(cues)).toEqual([
      'good morning',
      'today we will plant some trees',
      '[Music]',
    ]);
    expect(cues[0]).toMatchObject({ start: 200 });
    expect(cues[1]).toMatchObject({ start: 1510, end: 5510 });
  });

  it('cuts a run with no pause at a length a reader can take in', () => {
    const segs = Array.from({ length: 60 }, (_, i) => ({
      utf8: i === 0 ? 'word' : ' word',
      tOffsetMs: i * 200,
    }));
    const cues = toCues([{ tStartMs: 0, dDurationMs: 12_000, segs }], 'en');
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(145);
    // Nothing lost in the cutting.
    expect(
      cues
        .map((cue) => cue.text)
        .join(' ')
        .split(' '),
    ).toHaveLength(60);
  });

  it('closes up a full stop sent as a word of its own', () => {
    const cues = toCues(
      [
        {
          tStartMs: 0,
          dDurationMs: 2000,
          segs: [
            { utf8: 'Guten' },
            { utf8: ' Morgen', tOffsetMs: 300 },
            { utf8: ' .', tOffsetMs: 600 },
            { utf8: ' Wir', tOffsetMs: 800 },
            { utf8: ' fangen', tOffsetMs: 1000 },
            { utf8: ' an', tOffsetMs: 1200 },
            { utf8: ' .', tOffsetMs: 1400 },
          ],
        },
      ],
      'de-DE',
    );
    expect(texts(cues)).toEqual(['Guten Morgen.', 'Wir fangen an.']);
  });
});

describe('isUnspaced', () => {
  it('knows which scripts go without spaces', () => {
    expect(isUnspaced('ja')).toBe(true);
    expect(isUnspaced('zh-Hant')).toBe(true);
    expect(isUnspaced('th')).toBe(true);
    expect(isUnspaced('en')).toBe(false);
    expect(isUnspaced('de-DE')).toBe(false);
    // A prefix is not a language.
    expect(isUnspaced('jam')).toBe(false);
  });
});

describe('parseTrack', () => {
  const URL_ASR =
    'https://www.youtube.com/api/timedtext?v=abc123XYZ_0&caps=asr&lang=en&kind=asr&fmt=json3&pot=token';

  it('reads the video, the language and the kind off the request', () => {
    const track = parseTrack(URL_ASR, JSON.stringify(RECOGNISED));
    expect(track).not.toBeNull();
    expect(track).toMatchObject({
      videoId: 'abc123XYZ_0',
      lang: 'en',
      generated: true,
    });
    expect(track?.cues).toHaveLength(3);
  });

  it('takes the language YouTube translated into over the one it started from', () => {
    const track = parseTrack(
      'https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=ja&fmt=json3',
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'おはよう。' }] },
        ],
      }),
    );
    expect(track).toMatchObject({ lang: 'ja', generated: false });
  });

  it('declines anything it does not recognise instead of throwing', () => {
    const body = JSON.stringify(TRANSCRIPT);
    expect(parseTrack('not a url', body)).toBeNull();
    expect(
      parseTrack(
        'https://www.youtube.com/api/stats/watchtime?v=abc&lang=en',
        body,
      ),
    ).toBeNull();
    expect(
      parseTrack('https://www.youtube.com/api/timedtext?lang=en', body),
    ).toBeNull();
    expect(
      parseTrack('https://www.youtube.com/api/timedtext?v=abc', body),
    ).toBeNull();
    const url = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3';
    expect(parseTrack(url, '<transcript/>')).toBeNull();
    expect(parseTrack(url, '{}')).toBeNull();
    expect(parseTrack(url, '{"events": "no"}')).toBeNull();
    // A track with nothing to say on it is not a track to replace.
    expect(
      parseTrack(url, JSON.stringify({ events: [TRANSCRIPT.events[0]] })),
    ).toBeNull();
  });

  it('survives events that are missing the fields it reads', () => {
    const track = parseTrack(
      'https://www.youtube.com/api/timedtext?v=abc&lang=en',
      JSON.stringify({
        events: [
          null,
          { segs: 'nope' },
          { tStartMs: 'soon', segs: [{ utf8: 42 }, { utf8: 'Still here.' }] },
        ],
      }),
    );
    expect(texts(track?.cues ?? [])).toEqual(['Still here.']);
  });
});

describe('cueAt', () => {
  const cues: Cue[] = [
    { start: 0, end: 1000, text: 'a' },
    { start: 1500, end: 3000, text: 'b' },
    // Recognised lines overlap: this one starts before the last has gone.
    { start: 2000, end: 4000, text: 'c' },
  ];

  it('finds the cue on screen, the newest when two overlap', () => {
    expect(cueAt(cues, 0)).toBe(0);
    expect(cueAt(cues, 999)).toBe(0);
    expect(cueAt(cues, 1700)).toBe(1);
    expect(cueAt(cues, 2500)).toBe(2);
  });

  it('answers -1 between cues, before the first and after the last', () => {
    expect(cueAt(cues, 1200)).toBe(-1);
    expect(cueAt(cues, -5)).toBe(-1);
    expect(cueAt(cues, 4000)).toBe(-1);
    expect(cueAt([], 10)).toBe(-1);
  });

  it('still knows where it is between cues, for whoever reads ahead', () => {
    expect(lastStarted(cues, 1200)).toBe(0);
    expect(lastStarted(cues, 9000)).toBe(2);
    expect(lastStarted(cues, -5)).toBe(-1);
  });
});

describe('videoIdOf', () => {
  it('reads every address a YouTube video is played at', () => {
    expect(videoIdOf('https://www.youtube.com/watch?v=abc123XYZ_0&t=42s')).toBe(
      'abc123XYZ_0',
    );
    expect(videoIdOf('https://www.youtube.com/embed/abc-123?autoplay=1')).toBe(
      'abc-123',
    );
    expect(videoIdOf('https://www.youtube.com/shorts/xyz789')).toBe('xyz789');
    expect(videoIdOf('https://www.youtube.com/live/live01')).toBe('live01');
  });

  it('answers null where no one video is playing', () => {
    expect(videoIdOf('https://www.youtube.com/')).toBeNull();
    expect(
      videoIdOf('https://www.youtube.com/results?search_query=x'),
    ).toBeNull();
    expect(videoIdOf('https://www.youtube.com/watch')).toBeNull();
    expect(videoIdOf('nonsense')).toBeNull();
  });
});

describe('replacesCaptions', () => {
  it('replaces captions in another language', () => {
    expect(replacesCaptions('en', 'zh-Hant')).toBe(true);
    expect(replacesCaptions('de-DE', 'en')).toBe(true);
  });

  it('leaves captions already in the reader’s language alone', () => {
    // YouTube's own translation into Chinese, for a Chinese reader.
    expect(replacesCaptions('zh-Hant', 'zh-Hant')).toBe(false);
    expect(replacesCaptions('zh-TW', 'zh-Hant')).toBe(false);
    expect(replacesCaptions('en-GB', 'en')).toBe(false);
  });

  it('translates when the target has no code to compare with', () => {
    expect(replacesCaptions('en', null)).toBe(true);
  });
});
