import { describe, expect, it } from 'vitest';
import { deriveCompactionInfo, type SessionEntryLike } from './state.js';

function entry(partial: Partial<SessionEntryLike>): SessionEntryLike {
  return { type: 'message', id: partial.id ?? 'e', ...partial };
}

describe('deriveCompactionInfo', () => {
  it('reports no compaction for an empty branch', () => {
    expect(deriveCompactionInfo([])).toEqual({
      count: 0,
      lastAt: undefined,
      lastTokensBefore: undefined,
      lastIndex: -1,
    });
  });

  it('ignores non-compaction entries', () => {
    const branch: SessionEntryLike[] = [
      entry({ id: 'u1' }),
      entry({ id: 'a1' }),
      entry({ id: 'c1', type: 'custom', customType: 'context-manager-prune' }),
      entry({ id: 'ce1', type: 'context_edit', targetId: 'a1', replacement: null }),
    ];
    expect(deriveCompactionInfo(branch)).toEqual({
      count: 0,
      lastAt: undefined,
      lastTokensBefore: undefined,
      lastIndex: -1,
    });
  });

  it('counts compaction entries and keeps the last one', () => {
    const first = new Date(2026, 0, 2, 16, 43).getTime();
    const second = new Date(2026, 0, 3, 9, 5).getTime();
    const branch: SessionEntryLike[] = [
      entry({ id: 'u1' }),
      { type: 'compaction', id: 'c1', timestamp: new Date(first).toISOString(), tokensBefore: 977_000 },
      entry({ id: 'u2' }),
      { type: 'compaction', id: 'c2', timestamp: new Date(second).toISOString(), tokensBefore: 66_000 },
      entry({ id: 'u3' }),
    ];

    const info = deriveCompactionInfo(branch);
    expect(info.count).toBe(2);
    expect(info.lastIndex).toBe(3);
    expect(info.lastTokensBefore).toBe(66_000);
    expect(info.lastAt).toBe(second);
  });

  it('skips invalid timestamps but still records tokensBefore', () => {
    const branch: SessionEntryLike[] = [
      { type: 'compaction', id: 'c1', timestamp: 'not-a-date', tokensBefore: 123 },
    ];
    const info = deriveCompactionInfo(branch);
    expect(info.count).toBe(1);
    expect(info.lastIndex).toBe(0);
    expect(info.lastAt).toBeUndefined();
    expect(info.lastTokensBefore).toBe(123);
  });

  it('tolerates compaction entries without optional fields', () => {
    const branch: SessionEntryLike[] = [{ type: 'compaction', id: 'c1' }];
    const info = deriveCompactionInfo(branch);
    expect(info.count).toBe(1);
    expect(info.lastAt).toBeUndefined();
    expect(info.lastTokensBefore).toBeUndefined();
  });
});
