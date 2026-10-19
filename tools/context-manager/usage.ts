/**
 * Pure formatting / math helpers for pi-context-manager.
 * Kept dependency-free so they are trivially unit-testable.
 */

/** Format a token count compactly using 1000-based K/M (matches pi's "1M" windows). */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  if (n < 0) return '0';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${trimFixed(v, v >= 10 ? 0 : 1)}M`;
  }
  // Round up to M just below the boundary: 999_999 / 1000 = 999.999 → "1000K"
  // would be wrong (and reads worse than "1M").
  if (n >= 999_500) return `${trimFixed(n / 1_000_000, 1)}M`;
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${trimFixed(v, v >= 10 ? 0 : 1)}K`;
  }
  return String(Math.round(n));
}

function trimFixed(v: number, digits: number): string {
  return digits === 0 ? String(Math.round(v)) : v.toFixed(digits).replace(/\.0$/, '');
}

/** Format a 0..1 fraction as a percentage string. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '?';
  const pct = fraction * 100;
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
}

/** Format an epoch-ms timestamp as local HH:MM. */
export function formatClock(ts: number | string | undefined): string {
  if (ts === undefined) return '?';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '?';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Soft-limit = the auto-compaction trigger threshold (contextWindow - reserveTokens). */
export function softLimit(contextWindow: number, reserveTokens: number): number {
  return Math.max(0, contextWindow - reserveTokens);
}

/** Remaining tokens before the soft-limit (negative when past it). */
export function remainingToSoftLimit(tokens: number, soft: number): number {
  return soft - tokens;
}

/** Estimate token count for a string using pi's conservative chars/4 heuristic. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}
