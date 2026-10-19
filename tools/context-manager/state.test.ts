import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { ContextManagerState, deriveCompactionInfo, type SessionEntryLike } from './state.js';

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

describe('queued compaction', () => {
  const newState = (): ContextManagerState => new ContextManagerState({ ...DEFAULT_CONFIG });

  it('takes the queued request exactly once', () => {
    const state = newState();
    state.queueCompaction('focus on the migration');
    const request = state.takeQueuedCompaction();
    expect(request?.instructions).toBe('focus on the migration');
    expect(state.queuedCompact).toBeUndefined();
    expect(state.takeQueuedCompaction()).toBeUndefined();
  });

  it('keeps the last request when queued twice', () => {
    const state = newState();
    state.queueCompaction('first');
    state.queueCompaction('second');
    expect(state.queuedCompact?.instructions).toBe('second');
  });

  it('clears the queue when cleared explicitly', () => {
    const state = newState();
    state.queueCompaction();
    state.clearQueuedCompaction();
    expect(state.queuedCompact).toBeUndefined();
  });

  it('clears the queue and in-flight flags when a compaction completes', () => {
    const state = newState();
    state.queueCompaction('x');
    state.compacting = true;
    state.pendingCompact = true;
    state.onCompacted(Date.now());
    expect(state.queuedCompact).toBeUndefined();
    expect(state.compacting).toBe(false);
    expect(state.pendingCompact).toBe(false);
  });

  it('drops a stale queue when state is rebuilt from the branch', () => {
    const state = newState();
    state.queueCompaction('x');
    state.rebuildFromBranch([]);
    expect(state.queuedCompact).toBeUndefined();
  });
});

describe('session reset (D3a)', () => {
  it('clears in-flight compaction flags when a new session starts', () => {
    const state = new ContextManagerState({ ...DEFAULT_CONFIG });
    state.markCompacting();
    state.pendingCompact = true;
    expect(state.isCompacting()).toBe(true);

    // session_start → rebuildFromBranch: a different session cannot own our in-flight compaction.
    state.rebuildFromBranch([]);
    expect(state.compacting).toBe(false);
    expect(state.pendingCompact).toBe(false);
    expect(state.isCompacting()).toBe(false);
  });
});
