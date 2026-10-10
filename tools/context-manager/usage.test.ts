import { describe, expect, it } from 'vitest';
import {
  estimateTokensFromChars,
  formatClock,
  formatPercent,
  formatTokens,
  remainingToSoftLimit,
  softLimit,
} from './usage.js';

describe('formatTokens', () => {
  it('returns ? for missing or non-finite values', () => {
    expect(formatTokens(null)).toBe('?');
    expect(formatTokens(undefined)).toBe('?');
    expect(formatTokens(Number.NaN)).toBe('?');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('?');
  });

  it('clamps negatives to 0', () => {
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(-999_999)).toBe('0');
  });

  it('renders small counts as rounded integers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(999.6)).toBe('1000');
  });

  it('renders thousands with a K suffix', () => {
    expect(formatTokens(1_000)).toBe('1K');
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(9_999)).toBe('10K');
    expect(formatTokens(10_000)).toBe('10K');
    expect(formatTokens(983_616)).toBe('984K');
    expect(formatTokens(999_999)).toBe('1000K');
  });

  it('renders millions with an M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(15_000_000)).toBe('15M');
  });
});

describe('formatPercent', () => {
  it('returns ? for missing or non-finite fractions', () => {
    expect(formatPercent(null)).toBe('?');
    expect(formatPercent(undefined)).toBe('?');
    expect(formatPercent(Number.NaN)).toBe('?');
  });

  it('rounds percentages at or above 10%', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.999)).toBe('100%');
    expect(formatPercent(0.1)).toBe('10%');
  });

  it('keeps one decimal below 10%', () => {
    expect(formatPercent(0.055)).toBe('5.5%');
    expect(formatPercent(0.0105)).toBe('1.1%');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('formatClock', () => {
  it('formats an epoch timestamp as local HH:MM', () => {
    expect(formatClock(new Date(2026, 0, 2, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(new Date(2026, 0, 2, 16, 43).getTime())).toBe('16:43');
    expect(formatClock(new Date(2026, 0, 2, 0, 0).getTime())).toBe('00:00');
  });

  it('accepts ISO strings and rejects garbage', () => {
    expect(formatClock(new Date(2026, 5, 1, 12, 30).toISOString())).toBe('12:30');
    expect(formatClock('not-a-date')).toBe('?');
    expect(formatClock(undefined)).toBe('?');
  });
});

describe('softLimit', () => {
  it('subtracts the reserve from the window', () => {
    expect(softLimit(1_000_000, 16_384)).toBe(983_616);
    expect(softLimit(1_000_000, 400_000)).toBe(600_000);
  });

  it('never goes negative', () => {
    expect(softLimit(100, 500)).toBe(0);
    expect(softLimit(0, 0)).toBe(0);
  });
});

describe('remainingToSoftLimit', () => {
  it('is positive below the soft-limit and negative beyond it', () => {
    expect(remainingToSoftLimit(500, 1_000)).toBe(500);
    expect(remainingToSoftLimit(1_000, 1_000)).toBe(0);
    expect(remainingToSoftLimit(1_200, 1_000)).toBe(-200);
  });
});

describe('estimateTokensFromChars', () => {
  it('uses the conservative chars/4 heuristic, rounding up', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(8_000)).toBe(2_000);
  });
});
