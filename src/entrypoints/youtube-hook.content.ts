import { installTimedTextHook } from '../ui/timedtext-hook';

/**
 * The page-world half of video captions: it copies the player's caption
 * responses out to `youtube.content.ts`. See `ui/timedtext-hook.ts`.
 *
 * At `document_start`, because the player can ask for a track before the page
 * has finished loading — whenever the reader has captions on by default — and
 * a request made before the hook is installed is never seen.
 */
export default defineContentScript({
  matches: ['*://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  // Embedded players are frames on youtube.com inside someone else's page.
  allFrames: true,
  main() {
    installTimedTextHook(window);
  },
});
