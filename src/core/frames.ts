/**
 * Which frames of a page are worth translating.
 *
 * Whole-page translation ran on the top frame only, and the reason was sound:
 * every frame receives the broadcast, so an ad iframe would spend the reader's
 * GPU on someone else's banner and stack a second progress badge in the same
 * corner. The cost was that an article inside an iframe — an embedded document
 * viewer, a comment system, a syndicated post, a help-centre page in a shell —
 * came back untranslated with no explanation, because nothing about it looks
 * different to a reader.
 *
 * "Not the top frame" is the wrong test. What separates an embedded article
 * from an ad is not where it sits but what is in it: an ad slot is a picture
 * and a call to action, and has no prose. So the test is prose, plus a floor on
 * size to exclude the tracking pixels and the 1×1 frames that carry a sentence
 * of legal text.
 */

/**
 * How many translatable blocks make a frame worth reading.
 *
 * Three, and not one, because a single block is exactly what an ad's headline
 * or a cookie bar's sentence looks like. An article, a comment thread and a
 * documentation page all clear it immediately.
 */
export const MIN_FRAME_BLOCKS = 3;

/**
 * Smallest frame worth translating, in CSS pixels of its own viewport.
 *
 * Sized against the standard ad units rather than against a guess: the IAB
 * leaderboard is 728×90 and the large mobile banner 320×100, so a 200-pixel
 * height already excludes the shapes that carry no article. It is a floor for
 * the degenerate cases — the 0×0 tracking frame, the 1×1 pixel — and the block
 * count does the real work.
 */
export const MIN_FRAME_WIDTH = 200;
export const MIN_FRAME_HEIGHT = 200;

export interface FrameContext {
  /** The top frame always translates: it is the page the reader asked about. */
  isTop: boolean;
  /** The frame's own viewport, not the tab's. */
  width: number;
  height: number;
  /** Translatable blocks found in this frame's document. */
  blocks: number;
}

/** Whether this frame should join a whole-page run. */
export function shouldTranslateFrame(context: FrameContext): boolean {
  if (context.isTop) return true;
  if (context.blocks < MIN_FRAME_BLOCKS) return false;
  return context.width >= MIN_FRAME_WIDTH && context.height >= MIN_FRAME_HEIGHT;
}
