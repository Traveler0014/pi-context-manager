/**
 * Agent-facing tools for pi-context-manager.
 *
 *   context_status   — read-only exact usage + ledger + guards
 *   context_compact  — request a guarded compaction (delegates to ctx.compact)
 *   context_prune    — schedule boundary context_edits that drop stale tool results
 *
 * Every guard is written into the tool description as well as enforced at
 * runtime: a guard the model can see is a guard the model can respect.
 */

import { existsSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadEffectiveCompaction } from './config.js';
import {
  type ContextManagerState,
  type PruneRecord,
  type SessionEntryLike,
  deriveCompactionInfo,
} from './state.js';
import {
  estimateTokensFromChars,
  formatClock,
  formatPercent,
  formatTokens,
  softLimit,
} from './usage.js';

export interface ToolDeps {
  state: ContextManagerState;
  /** True when pi-context-prune (or a compatible pruner) is active; context_prune then yields. */
  isPruneExtensionActive: () => boolean;
}

// ExtensionToolContext (pi 1.1+) extends ExtensionContext; the older bundled dev
// typings only export ExtensionContext, which is structurally sufficient here.
type ToolCtx = ExtensionContext;

interface TextResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function ok(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: 'text', text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: 'text', text }], details, isError: true };
}

// ── shared usage helpers ────────────────────────────────────────────────────

function capacityOf(ctx: ToolCtx): number {
  const usage = ctx.getContextUsage();
  if (usage && typeof usage.contextWindow === 'number' && usage.contextWindow > 0) {
    return usage.contextWindow;
  }
  const model = ctx.model as { contextWindow?: number } | undefined;
  return typeof model?.contextWindow === 'number' ? model.contextWindow : 0;
}

function softLimitOf(ctx: ToolCtx): number {
  const capacity = capacityOf(ctx);
  const effective = loadEffectiveCompaction(
    ctx.cwd,
    ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
  );
  return softLimit(capacity, effective.reserveTokens);
}

function usageLine(ctx: ToolCtx): string {
  const usage = ctx.getContextUsage();
  const capacity = capacityOf(ctx);
  const soft = softLimitOf(ctx);
  if (!usage || usage.tokens === null) {
    return `Usage: recalculating… (capacity ${formatTokens(capacity)})`;
  }
  const pct = capacity > 0 ? formatPercent(usage.tokens / capacity) : '?';
  const remaining = soft - usage.tokens;
  const countdown =
    remaining >= 0
      ? `${formatTokens(remaining)} remaining before soft-limit ${formatTokens(soft)}`
      : `${formatTokens(-remaining)} past soft-limit ${formatTokens(soft)}`;
  return `Usage: ${pct} of capacity (${formatTokens(usage.tokens)} / ${formatTokens(capacity)}) · ${countdown}`;
}

// ── status report (shared with the /context-manager command) ────────────────

export function buildStatusReport(
  ctx: ToolCtx,
  deps: ToolDeps,
  configPath: string,
): string {
  const { state } = deps;
  const branch = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
  const compaction = deriveCompactionInfo(branch);
  const lines = [usageLine(ctx)];

  const lastAt = compaction.lastAt !== undefined ? ` (last ${formatClock(compaction.lastAt)})` : '';
  lines.push(`Window: ${compaction.count + 1} · compacted ${compaction.count}×${lastAt}`);
  if (compaction.lastTokensBefore !== undefined) {
    lines.push(`Last compaction summarized ${formatTokens(compaction.lastTokensBefore)} of prior context`);
  }

  const pruneLast = state.lastPruneAt !== undefined ? ` (last ${formatClock(state.lastPruneAt)})` : '';
  lines.push(`Pruned: ${state.pruneRecords.length} tool result(s)${pruneLast}`);
  if (state.pendingPrune.length > 0) {
    lines.push(`Pending at next boundary: ${state.pendingPrune.map((r) => r.ref).join(' ')}`);
  }
  if (state.queuedCompact) {
    lines.push(
      `Compaction: queued at ${formatClock(state.queuedCompact.requestedAt)} — runs when the current run settles`,
    );
  }

  lines.push(
    `Guards: compact ≥${state.config.lowYieldPercent}% · cooldown ${state.config.compactCooldownMinutes}m`,
  );
  lines.push(
    `         prune quota ${state.config.pruneQuota}/call · cooldown ${state.config.pruneCooldownMinutes}m · min age ${state.config.pruneMinAgeTurns} spans`,
  );
  lines.push(`Config: ${configPath || 'defaults'}`);
  lines.push(
    deps.isPruneExtensionActive()
      ? 'pi-context-prune: ACTIVE — context_prune yields to it (use context_tree_query)'
      : 'pi-context-prune: not active',
  );
  if (state.lastCompactError) lines.push(`Last compaction error: ${state.lastCompactError}`);
  return lines.join('\n');
}

// ── candidate selection for context_prune ───────────────────────────────────

interface PruneCandidate {
  entry: SessionEntryLike;
  index: number;
  entryId: string;
  chars: number;
  toolName?: string;
}

function messageChars(message: unknown): number {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content ?? '').length;
  } catch {
    return 0;
  }
}

function isToolResultEntry(entry: SessionEntryLike): boolean {
  if (entry.type !== 'message') return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === 'toolResult';
}

/** Never prune the context-manager tools' own results. */
const SELF_TOOL_NAMES = new Set(['context_status', 'context_compact', 'context_prune']);

/**
 * Index of the assistant message that invoked `toolCallId`; everything at or
 * after it is the current turn and is never an eligible prune target.
 */
function currentTurnBoundary(branch: readonly SessionEntryLike[], toolCallId: string): number {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const hasCall = (message.content as Array<{ type?: string; id?: string }>).some(
      (block) => block?.type === 'toolCall' && block?.id === toolCallId,
    );
    if (hasCall) return i;
  }
  // Fall back to the last user message.
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type !== 'message') continue;
    if ((entry as { message?: { role?: string } }).message?.role === 'user') return i;
  }
  return branch.length;
}

/** Oldest index a candidate may occupy when no compaction boundary exists. */
function minAgeCutoff(
  branch: readonly SessionEntryLike[],
  boundaryIndex: number,
  minAgeTurns: number,
): number {
  if (minAgeTurns <= 0) return boundaryIndex;
  const userIndices: number[] = [];
  for (let i = 0; i < boundaryIndex; i += 1) {
    const entry = branch[i];
    if (entry.type !== 'message') continue;
    if ((entry as { message?: { role?: string } }).message?.role === 'user') userIndices.push(i);
  }
  if (userIndices.length <= minAgeTurns) return -1;
  return userIndices[userIndices.length - 1 - minAgeTurns];
}

function selectCandidates(
  ctx: ToolCtx,
  deps: ToolDeps,
  toolCallId: string,
  opts: { toolName?: string; minChars: number },
): PruneCandidate[] {
  const branch = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
  // Entries already omitted from model context (null context_edit) are not visible.
  const omitted = new Set<string>();
  for (const entry of branch) {
    if (entry.type === 'context_edit' && entry.replacement === null && entry.targetId) {
      omitted.add(entry.targetId);
    }
  }
  const compaction = deriveCompactionInfo(branch);
  // When a compaction exists, eligible entries must be in the current kept window:
  // at/after the latest compaction's firstKeptEntryId (otherwise they were summarized
  // away — not in context) and before the compaction entry itself (i.e. they survived
  // at least one boundary). Post-compaction entries are protected until the next boundary.
  let firstKeptIndex = -1;
  if (compaction.lastIndex >= 0) {
    const latest = branch[compaction.lastIndex];
    const firstKeptId = latest?.firstKeptEntryId;
    if (firstKeptId) firstKeptIndex = branch.findIndex((entry) => entry.id === firstKeptId);
    if (firstKeptIndex < 0) firstKeptIndex = compaction.lastIndex;
  }
  const boundary = currentTurnBoundary(branch, toolCallId);
  const noBoundaryCutoff = minAgeCutoff(branch, boundary, deps.state.config.pruneMinAgeTurns);

  const candidates: PruneCandidate[] = [];
  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i];
    if (!isToolResultEntry(entry)) continue;
    if (omitted.has(entry.id)) continue;
    if (deps.state.pruneByEntry.has(entry.id)) continue;
    if (i >= boundary) continue;
    // Age guard: prefer the latest compaction boundary; fall back to span age.
    if (compaction.lastIndex >= 0) {
      if (i < firstKeptIndex || i >= compaction.lastIndex) continue;
    } else if (noBoundaryCutoff < 0 || i >= noBoundaryCutoff) {
      continue;
    }
    const message = (entry as { message?: { toolName?: string } }).message;
    const toolName = message?.toolName;
    if (toolName && SELF_TOOL_NAMES.has(toolName)) continue;
    if (opts.toolName && toolName !== opts.toolName) continue;
    const chars = messageChars(message);
    if (chars < opts.minChars) continue;
    candidates.push({ entry, index: i, entryId: entry.id, chars, toolName });
  }
  candidates.sort((a, b) => b.chars - a.chars);
  return candidates;
}

// ── tool registration ───────────────────────────────────────────────────────

export function registerContextManagerTools(
  pi: ExtensionAPI,
  deps: ToolDeps,
  getConfigPath: () => string,
): void {
  const { state } = deps;

  // ── context_status ───────────────────────────────────────────────────────
  pi.registerTool({
    name: 'context_status',
    label: 'Context Status',
    description:
      'Report the exact current context usage: tokens, percent of capacity, remaining before ' +
      'the soft-limit (the auto-compaction threshold), plus the compaction and prune ledger. ' +
      'Read-only. Call this before planning a long task instead of guessing how full the context is.',
    promptSnippet: 'Exact context usage + countdown to soft-limit + ledger',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return ok(buildStatusReport(ctx, deps, getConfigPath()), {
        enabled: state.config.enabled,
      });
    },
  });

  // ── context_compact ──────────────────────────────────────────────────────
  pi.registerTool({
    name: 'context_compact',
    label: 'Compact Context',
    description:
      'Queue a compaction that replaces older conversation context with a summary, starting a new context ' +
      'window. The request is queued and runs only after the current run has fully settled (the agent goes ' +
      'idle), so it never aborts or interrupts the turn and never drops tool calls. CALL ONLY AT A TASK ' +
      'BOUNDARY — after a batch of work or a delivered report, never mid-task, and never twice in a row: ' +
      'every compaction invalidates the prompt cache, which is expensive on this provider. Enforced ' +
      'guards: refuses when real usage is below the low-yield threshold (default 50%, returns the real ' +
      'usage so you can recalibrate), refuses within the cooldown after the last compaction (default ' +
      '10 min), refuses a second request before the queued one runs, and refuses a keep-list larger than ' +
      '5% of the context window. Keep-list entries are passed to the summarizer verbatim.',
    promptSnippet: 'context_compact(instructions?, keep?) — guarded proactive compaction at task boundaries',
    promptGuidelines: [
      'Call context_compact only after finishing a coherent batch of work, never in the middle of a task.',
      'The request is queued and runs when this run settles; finish the current batch after calling it.',
      'Each compaction invalidates the prompt cache; do not call it repeatedly or again in the same run.',
      'Use the keep parameter for facts that must survive verbatim (decisions, rejected paths, exact commands).',
      'If refused for low usage, trust the returned real usage instead of guessing.',
    ],
    parameters: Type.Object({
      instructions: Type.Optional(
        Type.String({
          description:
            'Optional focus for the summary (what to emphasize). Appended before the keep-list.',
        }),
      ),
      keep: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Verbatim facts that must survive compaction (decisions, rejected paths, exact commands, IDs). ' +
            'Total size must be ≤5% of the context window.',
        }),
      ),
    }),
    executionMode: 'sequential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = state.config;
      if (!config.enabled) return fail('context-manager is disabled.');

      if (state.compacting) {
        return fail(
          'A compaction is already in progress. Wait for idle before requesting another.',
        );
      }

      if (state.queuedCompact) {
        return fail(
          'A compaction is already queued for this run. It runs when the run settles; finish the current ' +
          'batch instead of requesting another one.',
        );
      }

      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens === null) {
        return fail(
          `Context usage is being recalculated (right after a compaction). Try again after the next model response. Capacity ${formatTokens(capacityOf(ctx))}.`,
        );
      }

      const capacity = capacityOf(ctx);
      const pct = capacity > 0 ? (usage.tokens / capacity) * 100 : 0;
      if (pct < config.lowYieldPercent) {
        return fail(
          `Low-yield compaction refused: context is only ${formatPercent(usage.tokens / capacity)} full ` +
            `(${formatTokens(usage.tokens)} / ${formatTokens(capacity)}). Compaction below ` +
            `${config.lowYieldPercent}% is disabled to preserve the prompt cache. Keep working; ` +
            `call context_status if you need exact numbers.`,
          { usage: usage.tokens, capacity, percent: pct },
        );
      }

      const now = Date.now();
      const cooldownMs = config.compactCooldownMinutes * 60_000;
      if (
        cooldownMs > 0 &&
        state.lastCompactAt !== undefined &&
        now - state.lastCompactAt < cooldownMs
      ) {
        const waitMin = Math.ceil((cooldownMs - (now - state.lastCompactAt)) / 60_000);
        return fail(
          `Compaction cooldown: the last compaction was ${formatClock(state.lastCompactAt)}. ` +
            `Wait about ${waitMin} more minute(s) before compacting again.`,
        );
      }

      const keep = (params.keep ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
      const keepChars = keep.reduce((sum, s) => sum + s.length, 0);
      const keepTokenBudget = capacity * 0.05;
      if (estimateTokensFromChars(keepChars) > keepTokenBudget) {
        return fail(
          `Keep-list too large: ~${formatTokens(estimateTokensFromChars(keepChars))} tokens exceeds the ` +
            `5% window budget (${formatTokens(keepTokenBudget)} tokens ≈ ${keepTokenBudget * 4} chars). ` +
            `Trim to the essential facts and retry.`,
          { keepChars, keepTokenBudget },
        );
      }

      let customInstructions = (params.instructions ?? '').trim();
      if (keep.length > 0) {
        customInstructions +=
          `${customInstructions ? '\n\n' : ''}MUST PRESERVE VERBATIM (do not paraphrase, summarise away, or drop any of these):\n` +
          keep.map((s, i) => `${i + 1}. ${s}`).join('\n');
      }

      // Do NOT call `ctx.compact()` here: pi's manual compaction starts with
      // `await abort()`, which kills the active run and silently drops every
      // tool call after this one in the batch. Queue the request instead; the
      // `agent_settled` handler performs the compaction once the run is idle.
      state.queueCompaction(customInstructions || undefined);

      return ok(
        'Compaction queued: it runs as soon as this run settles (the agent goes idle), starting a new ' +
          'context window. It does not interrupt the current turn. Do not call context_compact again this ' +
          'run — finish the current batch. The post-compaction usage is reported in the anchor-break ' +
          'message and by context_status.',
        { queued: true, hasInstructions: customInstructions.length > 0, keepCount: keep.length },
      );
    },
  });

  // ── context_prune (withdrawn when a compatible pruner is active) ─────────
  if (!deps.isPruneExtensionActive()) {
    pi.registerTool({
      name: 'context_prune',
      label: 'Prune Context',
      description:
        'Remove old, already-externalized tool results from future context to free space (the raw ' +
        'history is preserved on disk). Requirements, all enforced: (1) externalizedTo is REQUIRED — ' +
        'the file where you saved the original full outputs; (2) only tool results older than the most ' +
        'recent compaction boundary are eligible; (3) per-call quota and a cooldown between batches; ' +
        '(4) every pruned result gets a short recall ref printed so you can read the original later. ' +
        'Use dryRun first to list candidates. Removal is applied at the next turn boundary. Do not ' +
        'prune results you still need verbatim.',
      promptSnippet: 'context_prune(externalizedTo, targets?, dryRun?) — quarantine stale tool results',
      promptGuidelines: [
        'Externalize the original output to a file before calling context_prune; externalizedTo is mandatory.',
        'Prune only stale, large tool results you are unlikely to need verbatim again.',
        'Use dryRun to inspect candidates before committing.',
      ],
      parameters: Type.Object({
        externalizedTo: Type.String({
          description:
            'REQUIRED. Path of the file where the original full outputs were saved (kept for recall).',
        }),
        targets: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Session entry ids of the tool results to prune. Omit to auto-select the largest eligible candidates.',
          }),
        ),
        toolName: Type.Optional(
          Type.String({ description: 'Only consider results produced by this tool.' }),
        ),
        minChars: Type.Optional(
          Type.Number({ description: 'Minimum result size in characters (default 8000).' }),
        ),
        limit: Type.Optional(
          Type.Number({ description: 'Maximum results to prune this call (capped by the quota).' }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({ description: 'List candidates without pruning anything.' }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const config = state.config;
        if (!config.enabled) return fail('context-manager is disabled.');
        if (!config.pruneEnabled) return fail('context_prune is disabled in the context-manager config.');
        if (deps.isPruneExtensionActive()) {
          return fail(
            'pi-context-prune is active; context_prune is yielding to it to avoid double pruning. ' +
              'Use context_tree_query to recall pruned originals.',
          );
        }

        const externalizedTo = (params.externalizedTo ?? '').trim();
        if (!externalizedTo) {
          return fail(
            'externalizedTo is required: give the path where the original full outputs were saved ' +
              '(this becomes part of the prune ledger and the recall ref).',
          );
        }
        if (config.pruneRequireExistingFile && !existsSync(externalizedTo)) {
          return fail(
            `externalizedTo file not found: ${externalizedTo}. Write the original outputs there first, ` +
              `then retry — a prune without a durable copy is not recoverable.`,
          );
        }

        const now = Date.now();
        const cooldownMs = config.pruneCooldownMinutes * 60_000;
        if (
          cooldownMs > 0 &&
          state.lastPruneAt !== undefined &&
          now - state.lastPruneAt < cooldownMs
        ) {
          const waitMin = Math.ceil((cooldownMs - (now - state.lastPruneAt)) / 60_000);
          return fail(
            `Prune cooldown: the last prune batch was ${formatClock(state.lastPruneAt)}. ` +
              `Wait about ${waitMin} more minute(s).`,
          );
        }

        const minChars = Math.max(0, Math.floor(params.minChars ?? config.pruneMinChars));
        const quota = Math.max(1, Math.floor(config.pruneQuota));
        const limit = Math.max(1, Math.min(quota, Math.floor(params.limit ?? quota)));

        const allCandidates = selectCandidates(ctx, deps, _id, {
          toolName: params.toolName,
          minChars,
        });

        if (allCandidates.length === 0) {
          return ok(
            'No eligible tool results to prune: none older than the last compaction boundary meet the ' +
              `size/age criteria (minChars ${minChars}).`,
            { candidates: 0 },
          );
        }

        if (params.targets && params.targets.length === 0) {
          return ok(
            'targets is an empty list — nothing selected. Omit targets entirely to auto-select ' +
              'the largest eligible candidates, or pass entry ids from a dryRun listing.',
            { selected: 0 },
          );
        }

        let chosen = allCandidates.slice(0, limit);
        if (params.targets && params.targets.length > 0) {
          const byId = new Map(allCandidates.map((c) => [c.entryId, c]));
          const selected: PruneCandidate[] = [];
          const rejected: string[] = [];
          for (const target of params.targets) {
            const candidate = byId.get(target);
            if (candidate) selected.push(candidate);
            else rejected.push(target);
          }
          if (rejected.length > 0) {
            return fail(
              `Some targets are not eligible (unknown, too small, too recent, or already pruned): ` +
                `${rejected.join(', ')}. Run context_prune with dryRun to list eligible entry ids.`,
              { rejected },
            );
          }
          chosen = selected.slice(0, limit);
        }
        const truncated = params.targets !== undefined && params.targets.length > chosen.length;

        if (params.dryRun) {
          const lines = chosen.map(
            (c) => `- ${c.entryId} · ${formatTokens(c.chars / 4)} tokens (~${c.chars} chars) · ${c.toolName ?? 'tool'}`,
          );
          return ok(
            `Dry run: ${chosen.length} eligible candidate(s), largest first:\n${lines.join('\n')}\n` +
              (truncated
                ? `Quota is ${quota} per call — ${params.targets?.length ?? limit} requested; the remainder stay for a later batch.\n`
                : '') +
              'Externalize them, then call context_prune with externalizedTo and optionally these entry ids.',
            { dryRun: true, candidates: chosen.map((c) => ({ entryId: c.entryId, chars: c.chars })) },
          );
        }

        const records: PruneRecord[] = chosen.map((c) => ({
          ref: state.nextRef(),
          entryId: c.entryId,
          externalizedTo,
          chars: c.chars,
          toolName: c.toolName,
        }));
        state.addPruneRecords(records);
        state.pendingPrune.push(...records);
        state.lastPruneAt = now;

        const refs = records.map((r) => r.ref).join(' ');
        return ok(
          `Scheduled ${records.length} tool result(s) for removal at the next turn boundary ` +
            `(freed ~${formatTokens(records.reduce((s, r) => s + r.chars, 0) / 4)} tokens). ` +
            (truncated
              ? `Quota is ${quota} per call — the remaining ${params.targets!.length - records.length} eligible target(s) were NOT pruned; call again after the cooldown. `
              : '') +
            `Recall refs: ${refs} → ${externalizedTo}. Read that file if you need the originals.`,
          {
            pruned: records.map((r) => ({ ref: r.ref, entryId: r.entryId, chars: r.chars })),
            externalizedTo,
            truncated,
          },
        );
      },
    });
  }
}
