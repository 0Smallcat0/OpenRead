import { describe, it, expect } from 'vitest';
import {
  shouldTranslateFrame,
  MIN_FRAME_BLOCKS,
  MIN_FRAME_WIDTH,
  MIN_FRAME_HEIGHT,
} from './frames';

const frame = (
  over: Partial<Parameters<typeof shouldTranslateFrame>[0]> = {},
) =>
  shouldTranslateFrame({
    isTop: false,
    width: 800,
    height: 600,
    blocks: 10,
    ...over,
  });

describe('shouldTranslateFrame', () => {
  it('always translates the top frame', () => {
    // Including a page with nothing on it yet: an app that renders after load
    // has no blocks at the moment the reader presses, and the observers are
    // what pick it up.
    expect(
      shouldTranslateFrame({ isTop: true, width: 0, height: 0, blocks: 0 }),
    ).toBe(true);
  });

  it('translates an article inside an iframe', () => {
    expect(frame()).toBe(true);
  });

  it('leaves a leaderboard ad alone', () => {
    // 728×90, the IAB unit, with the one line of copy an ad carries.
    expect(frame({ width: 728, height: 90, blocks: 1 })).toBe(false);
  });

  it('leaves a skyscraper ad alone even though it is tall enough', () => {
    // 300×600 clears the size floor, so the block count is what has to catch
    // it — which is the reason size is not the test.
    expect(frame({ width: 300, height: 600, blocks: 1 })).toBe(false);
  });

  it('leaves a tracking pixel alone', () => {
    expect(frame({ width: 1, height: 1, blocks: 0 })).toBe(false);
  });

  it('leaves a hidden frame alone', () => {
    expect(frame({ width: 0, height: 0, blocks: 20 })).toBe(false);
  });

  it('takes a frame exactly on both floors', () => {
    expect(
      frame({
        width: MIN_FRAME_WIDTH,
        height: MIN_FRAME_HEIGHT,
        blocks: MIN_FRAME_BLOCKS,
      }),
    ).toBe(true);
  });

  it('refuses one block short', () => {
    expect(frame({ blocks: MIN_FRAME_BLOCKS - 1 })).toBe(false);
  });

  it('refuses one pixel short on either axis', () => {
    expect(frame({ width: MIN_FRAME_WIDTH - 1 })).toBe(false);
    expect(frame({ height: MIN_FRAME_HEIGHT - 1 })).toBe(false);
  });
});
