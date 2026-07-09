/**
 * Deterministic, network-free quality detectors used by the eval harness.
 * Each returns true when a specific defect is present in a translation, reusing
 * the exact same core predicates the production pipeline uses — so the eval
 * measures the shipped behaviour, not a re-implementation of it.
 */
import { isAIThinking } from '../src/core/sanitize';
import { hasSimplifiedChars } from '../src/core/language';

/** The output begins with model narration / preamble instead of a translation. */
export function hasPreamble(output: string): boolean {
  return isAIThinking(output);
}

/** The output contains Simplified-only characters (leakage for a TC target). */
export function hasSimplifiedLeak(output: string): boolean {
  return hasSimplifiedChars(output);
}

/** The output echoes the source verbatim as a leading prefix. */
export function hasEcho(source: string, output: string): boolean {
  const normalizedSource = source.trim().toLowerCase();
  if (!normalizedSource) return false;
  return output.trim().toLowerCase().startsWith(normalizedSource);
}
