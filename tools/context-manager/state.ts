/**
 * Session-scoped state for pi-context-manager.
 *
 * Nothing here is required for correctness of the model-facing status line:
 * compaction facts are always re-derived from the branch (zero extra state, per
 * the design). The prune ledger is persisted as `custom` entries so it survives
 * session reloads; the rest is in-memory.
 */

import type { ContextManagerConfig } from './config.js';

/** custom entry type used to persist prune batches (not sent to the LLM). */
export const PRUNE_LEDGER_TYPE = 'context-manager-prune';
/** custom message type used for milestone / anchor-break / recall messages. */
export const MANAGER_MESSAGE_TYPE = 'context-manager';

export interface PruneRecord {
  /** Short recall alias (t1, t2, …). */
  ref: string;
  /** Session message entry id the context_edit targets. */
  entryId: string;
  /** Where the original full output was externalized (required guard). */
  externalizedTo: string;
  /** Approximate removed size in characters. */
  chars: number;
  /** Tool that produced the result, for diagnostics. */
  toolName?: string;
}

export interface PruneBatch {
  at: number;
  records: PruneRecord[];
}

/** A compaction requested by the model, waiting for the agent to settle. */
export interface PendingCompactRequest {
  /** Focus passed to the summarizer (already merged with the keep-list). */
  instructions?: string;
  /** When the model asked (for diagnostics / status). */
  requestedAt: number;
}

/** Minimal structural view of a session entry; avoids importing internal types. */
export interface SessionEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  summary?: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  customType?: string;
  data?: unknown;
  targetId?: string;
  replacement?: unknown;
}

export interface CompactionInfo {
  count: number;
  lastAt?: number;
  lastTokensBefore?: number;
  /** Index of the most recent compaction entry on the branch, -1 when none. */
  lastIndex: number;
}

export function deriveCompactionInfo(branch: readonly SessionEntryLike[]): CompactionInfo {
  let count = 0;
  let lastAt: number | undefined;
  let lastTokensBefore: number | undefined;
  let lastIndex = -1;
  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i];
    if (entry?.type === 'compaction') {
      count += 1;
      lastIndex = i;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(ts)) lastAt = ts;
      if (typeof entry.tokensBefore === 'number') lastTokensBefore = entry.tokensBefore;
    }
  }
  return { count, lastAt, lastTokensBefore, lastIndex };
}

export class ContextManagerState {
  config: ContextManagerConfig;

  /** All prune records ever applied this session (rebuilt on reload). */
  pruneRecords: PruneRecord[] = [];
  /** entryId → record, for dedupe and target validation. */
  readonly pruneByEntry = new Map<string, PruneRecord>();
  /** Most recent prune batch time. */
  lastPruneAt: number | undefined;
  /** Records selected by a context_prune call, awaiting the next boundary. */
  pendingPrune: PruneRecord[] = [];

  /** Milestone thresholds (percent values) already injected in the current window. */
  readonly milestonesInjected = new Set<number>();

  /** Set while a context_compact call is in flight (idle-guard substitute + reentry guard). */
  compacting = false;
  /** Set while a tool-initiated compaction awaits session_before_compact (last-defense guard). */
  pendingCompact = false;
  /**
   * Compaction requested by `context_compact`, executed by the `agent_settled`
   * handler once the run has fully settled. Never executed from inside a tool:
   * pi's manual compaction aborts the active run first.
   */
  queuedCompact: PendingCompactRequest | undefined;

  /** Last compaction timestamp as observed via events (fallback for cooldown). */
  lastCompactAt: number | undefined;
  /** Last compaction failure, for /context-manager status. */
  lastCompactError: string | undefined;

  private refCounter = 0;

  constructor(config: ContextManagerConfig) {
    this.config = config;
  }

  nextRef(): string {
    this.refCounter += 1;
    return `t${this.refCounter}`;
  }

  addPruneRecords(records: readonly PruneRecord[]): void {
    for (const record of records) {
      this.pruneByEntry.set(record.entryId, record);
      this.pruneRecords.push(record);
      const n = Number.parseInt(record.ref.replace(/^t/, ''), 10);
      if (Number.isFinite(n) && n > this.refCounter) this.refCounter = n;
    }
  }

  /** Record a model-requested compaction; the last request wins. */
  queueCompaction(instructions?: string): void {
    this.queuedCompact = { instructions, requestedAt: Date.now() };
  }

  /** Drop a queued request (aborted run, disabled extension, or after it ran). */
  clearQueuedCompaction(): void {
    this.queuedCompact = undefined;
  }

  /** Take the queued request, clearing it (the caller performs the compaction). */
  takeQueuedCompaction(): PendingCompactRequest | undefined {
    const request = this.queuedCompact;
    this.queuedCompact = undefined;
    return request;
  }

  /** Clear pending prune selections (after they have been emitted at a boundary). */
  drainPendingPrune(): PruneRecord[] {
    const drained = this.pendingPrune;
    this.pendingPrune = [];
    return drained;
  }

  /** Reset transient window state when a new compaction window begins. */
  onCompacted(at: number): void {
    this.milestonesInjected.clear();
    this.lastCompactAt = at;
    this.lastCompactError = undefined;
    this.pendingCompact = false;
    this.compacting = false;
    this.queuedCompact = undefined;
  }

  /** Rebuild persisted state from the session branch (called on session_start). */
  rebuildFromBranch(branch: readonly SessionEntryLike[]): void {
    this.pruneRecords = [];
    this.pruneByEntry.clear();
    this.pendingPrune = [];
    this.queuedCompact = undefined;
    this.refCounter = 0;
    this.lastPruneAt = undefined;

    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== PRUNE_LEDGER_TYPE) continue;
      const data = entry.data as PruneBatch | undefined;
      if (!data || !Array.isArray(data.records)) continue;
      this.addPruneRecords(data.records);
      if (typeof data.at === 'number' && (this.lastPruneAt === undefined || data.at > this.lastPruneAt)) {
        this.lastPruneAt = data.at;
      }
    }

    const compaction = deriveCompactionInfo(branch);
    if (compaction.lastAt !== undefined) this.lastCompactAt = compaction.lastAt;
  }
}
