/**
 * A single `/api/tags` request, kept in its own module on purpose.
 *
 * The popup is the only caller, and the popup must stay small — it is opened
 * and dismissed constantly. Putting this next to the chat client in
 * `ollama.ts` would drag that file's import graph along with it, and that
 * graph reaches `zh-convert` and therefore the bundled OpenCC dictionaries:
 * roughly a megabyte of phrase tables, loaded so a settings panel can ask a
 * server for a list of names. This file imports one type and nothing else.
 */
import type { ConnectionProbe } from '../core/diagnostics';

/**
 * Ask the server what models it has.
 *
 * Returns a discriminated probe instead of throwing. "Not running" and
 * "refuses this extension's origin" are not exceptional on a first-run
 * install — they are the two states nearly every new user passes through — so
 * the caller's job is to explain them, not to catch them.
 *
 * Called straight from the popup rather than brokered through the background
 * worker, unlike translate and enrich. Those are brokered because they
 * originate in a content script, which runs in the page's origin and cannot
 * reach localhost. The popup is an extension page with the same origin the
 * worker has, so it reaches Ollama on exactly the terms a translation will —
 * which is the entire point of a check — and the URL being tested never has to
 * ride the message bus.
 */
export async function probeOllama(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ConnectionProbe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal,
    });
  } catch {
    return { kind: 'unreachable' };
  }

  if (response.status === 403) return { kind: 'forbidden' };
  if (!response.ok) return { kind: 'http', status: response.status };

  const data: unknown = await response.json().catch(() => null);
  const listed = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(listed)) return { kind: 'ok', models: [] };

  const models = listed
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '');

  return { kind: 'ok', models };
}
