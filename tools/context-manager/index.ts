/**
 * pi-context-manager — lightweight context visibility + guarded active management.
 *
 * A. Status injection (three channels, cache-aware):
 *    1. a window-static "boot line" in the system prompt (changes only at a
 *       compaction boundary, when the cache is already invalidated);
 *    2. append-only milestone messages injected once per threshold crossing;
 *    3. a read-only `context_status` tool for exact, on-demand numbers.
 *    Plus a one-shot anchor-break message after every compaction.
 * B. `context_compact`  — guarded proactive compaction (idle/cooldown/low-yield/keep-size).
 * C. `context_prune`    — boundary context_edits that drop stale, externalized tool results,
 *                         with a recall ledger.
 * D. guard hook + audit ledger + `/context-manager` command.
 *
 * Design rationale and acceptance criteria: docs/context-manager-spec/{CONSENSUS,RESEARCH}.md
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadEffectiveCompaction,
  saveUserConfig,
  type ContextManagerConfig,
} from './config.js';
import {
  ContextManagerState,
  MANAGER_MESSAGE_TYPE,
  PRUNE_LEDGER_TYPE,
  deriveCompactionInfo,
  type SessionEntryLike,
} from './state.js';
import { registerContextManagerTools, buildStatusReport } from './tools.js';
import { formatClock, formatPercent, formatTokens, softLimit } from './usage.js';

const STATUS_KEY = 'context-manager';

interface DeliverableMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

/**
 * Boundary entries the model context can be edited with. Defined locally because
 * the bundled dev typings (pi 0.80.x) predate `SessionBoundaryDraft`, while the
 * runtime (pi 1.1.x) accepts these drafts from turn_end / agent_before_settle.
 */
type BoundaryEntry =
  | { type: 'context_edit'; targetId: string; replacement: null }
  | { type: 'custom'; customType: string; data?: unknown }
  | {
      type: 'custom_message';
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    };

/**
 * A loosened view of the ExtensionAPI that includes the event signatures added
 * after the pinned dev typings. Runtime pi 1.1.x implements all of them.
 */
interface LooseApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): () => void;
}

export default function contextManager(pi: ExtensionAPI) {
  const looseApi = pi as unknown as LooseApi;
  let state = new ContextManagerState({ ...DEFAULT_CONFIG });
  let configPath = 'defaults';
  let pruneExtensionActive = false;

  const reloadConfig = (cwd: string, ctx?: ExtensionContext): void => {
    const loaded = loadConfig(cwd);
    state.config = loaded.config;
    configPath = loaded.source;
    if (loaded.notice && ctx) ctx.ui.notify(loaded.notice, 'warning');
  };

  const deps = {
    state,
    isPruneExtensionActive: () => pruneExtensionActive,
    refreshPruneDetection: (cwd: string) => {
      pruneExtensionActive = detectPruneExtension(cwd, pi);
    },
  };

  // ── config helpers ───────────────────────────────────────────────────────

  const patchConfig = (patch: Partial<ContextManagerConfig>, ctx: ExtensionContext): void => {
    try {
      saveUserConfig(patch);
      // Re-resolve through the normal precedence chain so a project config
      // (which outranks the user file) keeps taking effect.
      reloadConfig(ctx.cwd, ctx);
      ctx.ui.notify(`context-manager updated: ${Object.keys(patch).join(', ')}`, 'info');
    } catch (err) {
      ctx.ui.notify(`context-manager could not save config: ${String(err)}`, 'error');
    }
  };

  // ── status line helpers ──────────────────────────────────────────────────

  const capacityOf = (ctx: ExtensionContext): number => {
    const usage = ctx.getContextUsage();
    if (usage && typeof usage.contextWindow === 'number' && usage.contextWindow > 0) {
      return usage.contextWindow;
    }
    const model = ctx.model as { contextWindow?: number } | undefined;
    return typeof model?.contextWindow === 'number' ? model.contextWindow : 0;
  };

  const softLimitOf = (ctx: ExtensionContext): number => {
    const capacity = capacityOf(ctx);
    const effective = loadEffectiveCompaction(
      ctx.cwd,
      ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    );
    return softLimit(capacity, effective.reserveTokens);
  };

  const buildBootLine = (ctx: ExtensionContext): string => {
    const branch = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    const compaction = deriveCompactionInfo(branch);
    const capacity = capacityOf(ctx);
    const soft = softLimitOf(ctx);
    const parts = [`window ${compaction.count + 1}`];
    if (compaction.count > 0) {
      const last = compaction.lastAt !== undefined ? ` (last ${formatClock(compaction.lastAt)})` : '';
      parts.push(`compacted ${compaction.count}×${last}`);
    }
    if (compaction.lastTokensBefore !== undefined) {
      parts.push(`summary covers ${formatTokens(compaction.lastTokensBefore)} of prior context`);
    }
    parts.push(`capacity ${formatTokens(capacity)}`, `soft-limit ${formatTokens(soft)}`);
    parts.push('call context_status before planning long tasks');
    return `[context-manager] ${parts.join(' · ')}`;
  };

  const buildFooterText = (ctx: ExtensionContext): string | undefined => {
    const usage = ctx.getContextUsage();
    const capacity = capacityOf(ctx);
    const soft = softLimitOf(ctx);
    if (!usage || usage.tokens === null) {
      return `ctx recalculating… / ${formatTokens(capacity)}`;
    }
    const pct = capacity > 0 ? formatPercent(usage.tokens / capacity) : '?';
    return `ctx ${pct} (${formatTokens(usage.tokens)}/${formatTokens(capacity)}) · soft ${formatTokens(soft)}`;
  };

  const checkMilestones = (ctx: ExtensionContext): DeliverableMessage | undefined => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return undefined;
    const capacity = capacityOf(ctx);
    const soft = softLimitOf(ctx);
    const base = state.config.milestoneBase === 'window' ? capacity : soft;
    if (base <= 0) return undefined;

    const pctOfBase = (usage.tokens / base) * 100;
    const crossed: number[] = [];
    for (const threshold of state.config.milestoneThresholds) {
      if (pctOfBase >= threshold && !state.milestonesInjected.has(threshold)) {
        crossed.push(threshold);
      } else if (pctOfBase < threshold) {
        state.milestonesInjected.delete(threshold);
      }
    }
    if (crossed.length === 0) return undefined;
    for (const threshold of crossed) state.milestonesInjected.add(threshold);

    const highest = crossed[crossed.length - 1];
    const baseLabel = state.config.milestoneBase === 'window' ? 'capacity' : 'soft-limit';
    const capacityPct = capacity > 0 ? formatPercent(usage.tokens / capacity) : '?';
    const text =
      `[context-manager] Context crossed ${highest}% of the ${baseLabel} ` +
      `(${formatTokens(usage.tokens)} / ${formatTokens(base)}; ${capacityPct} of capacity). ` +
      `Auto-compaction triggers at ${formatTokens(soft)}. If the current batch of work is wrapping up, ` +
      `call context_compact at the next boundary; otherwise keep going — do not compact mid-task ` +
      `(each compaction invalidates the prompt cache).`;
    return {
      customType: MANAGER_MESSAGE_TYPE,
      content: text,
      display: state.config.showMilestones,
      details: { kind: 'milestone', threshold: highest },
    };
  };

  // ── prune boundary application ───────────────────────────────────────────

  const flushPendingPrune = (): { entries: BoundaryEntry[] } | undefined => {
    if (state.pendingPrune.length === 0) return undefined;
    const records = state.drainPendingPrune();
    const edits: BoundaryEntry[] = records.map((record) => ({
      type: 'context_edit',
      targetId: record.entryId,
      replacement: null,
    }));
    const recall = `[context-manager] Pruned ${records.length} stale tool result(s) from context. Recall originals: ${records
      .map((r) => `${r.ref}→${r.externalizedTo}`)
      .join(', ')}.`;
    return {
      entries: [
        ...edits,
        {
          type: 'custom',
          customType: PRUNE_LEDGER_TYPE,
          data: { at: Date.now(), records },
        },
        {
          type: 'custom_message',
          customType: MANAGER_MESSAGE_TYPE,
          content: recall,
          display: state.config.showPruneRecall,
          details: { kind: 'prune-recall' },
        },
      ],
    };
  };

  // ── boundary injection (prune edits + milestones) ────────────────────────

  const boundaryFlush = (
    ctx: ExtensionContext,
    inherited: readonly BoundaryEntry[] = [],
  ): { entries: BoundaryEntry[] } | undefined => {
    // The boundary emitter REPLACES the entry list with whatever a handler
    // returns: `entries = handlerResult.entries`. Handlers registered earlier on
    // the same boundary (another extension, another handler) therefore must be
    // carried forward here, or their context_edit / message drafts are silently
    // dropped when we return ours.
    const entries: BoundaryEntry[] = [...inherited];

    const prune = flushPendingPrune();
    if (prune) entries.push(...prune.entries);

    if (state.config.enabled && state.config.milestones) {
      const milestone = checkMilestones(ctx);
      if (milestone) {
        entries.push({
          type: 'custom_message',
          customType: milestone.customType,
          content: milestone.content,
          display: milestone.display,
          details: milestone.details,
        });
      }
    }

    if (entries.length === 0) return undefined;
    // Returning even an unchanged list is intentional: it preserves inherited
    // drafts from handlers that ran earlier on this boundary.
    return { entries };
  };

  // ── events ───────────────────────────────────────────────────────────────

  pi.on('session_start', async (event, ctx) => {
    reloadConfig(ctx.cwd, ctx);
    const branch = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    state.rebuildFromBranch(branch);
    pruneExtensionActive = detectPruneExtension(ctx.cwd, pi);
    if (event.reason === 'startup' && pruneExtensionActive) {
      ctx.ui.notify('context-manager: pi-context-prune is active — context_prune will yield to it.', 'info');
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!state.config.enabled) {
      if (ctx.mode === 'tui') ctx.ui.setStatus(STATUS_KEY, undefined);
      return undefined;
    }

    // Append the boot line to the rendered prompt rather than returning
    // structured `sections`: other extensions may return a full `systemPrompt`
    // built as `event.systemPrompt + <their section>`, and whichever extension
    // is asked last would drop this extension's structured sections. Appending
    // keeps the boot line in the final prompt regardless of ordering. The line
    // is window-static, so this remains cache-stable between compaction
    // boundaries.
    const bootLine = buildBootLine(ctx);
    const systemPrompt = state.config.statusInjection
      ? `${event.systemPrompt}\n\n${bootLine}`
      : undefined;

    if (state.config.footerStatus && ctx.mode === 'tui') {
      ctx.ui.setStatus(STATUS_KEY, buildFooterText(ctx));
    }

    const message =
      state.config.milestones ? checkMilestones(ctx) : undefined;

    if (systemPrompt === undefined && message === undefined) return undefined;
    return {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  });

  looseApi.on('turn_end', async (event: any, ctx: any) =>
    boundaryFlush(ctx, event?.entries ?? []),
  );

  looseApi.on('agent_before_settle', async (event: any, ctx: any) =>
    boundaryFlush(ctx, event?.entries ?? []),
  );

  // ── deferred compaction (model-requested, executed once idle) ────────────

  /**
   * Perform a queued `context_compact` request after the run has fully settled.
   *
   * pi's manual `compact()` starts with `await abort()`, which aborts the active
   * run and silently drops every tool call after the requesting one in the same
   * batch. `agent_settled` is the first moment where no run is active, so the
   * abort inside `compact()` is a no-op and the turn is never interrupted.
   */
  const isTui = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.mode === 'tui';
    } catch {
      // The runner invalidates its ctx during shutdown; never let that throw.
      return false;
    }
  };

  const runQueuedCompaction = (ctx: ExtensionContext): Promise<void> => {
    if (!state.queuedCompact) return Promise.resolve();
    if (!state.config.enabled) {
      state.clearQueuedCompaction();
      return Promise.resolve();
    }
    if (state.isCompacting()) return Promise.resolve();

    const request = state.takeQueuedCompaction();
    if (!request) return Promise.resolve();

    state.markCompacting();
    state.pendingCompact = true;
    const ui = ctx.ui;
    const notify = (message: string, level: 'info' | 'warning' | 'error'): void => {
      try {
        ui.notify(message, level);
      } catch {
        /* UI may be gone after the run settles */
      }
    };

    return new Promise<void>((resolve) => {
      let pending: void | Promise<unknown>;
      try {
        pending = ctx.compact({
          customInstructions: request.instructions,
          onComplete: (result) => {
            state.clearCompacting();
            state.pendingCompact = false;
            state.lastCompactAt = Date.now();
            state.lastCompactError = undefined;
            notify(
              `context-manager: compaction complete — ${formatTokens(result.tokensBefore)} of prior context summarized.`,
              'info',
            );
            resolve();
          },
          onError: (err) => {
            state.clearCompacting();
            state.pendingCompact = false;
            state.lastCompactError = err.message;
            notify(`context-manager: compaction failed — ${err.message}`, 'warning');
            resolve();
          },
        });
      } catch (err) {
        state.clearCompacting();
        state.pendingCompact = false;
        state.lastCompactError = err instanceof Error ? err.message : String(err);
        resolve();
        return;
      }
      // `ctx.compact` is typed void and returns undefined at runtime; failures are
      // already surfaced via onError / session_compact_failed. Still guard against
      // a thenable, so a future implementation that returns a rejected promise can
      // never become an unhandled rejection.
      Promise.resolve(pending).catch(() => resolve());
    });
  };

  looseApi.on('agent_settled', async (event: any, ctx: any) => {
    if (!state.queuedCompact) return;
    if (event?.aborted) {
      state.clearQueuedCompaction();
      if (isTui(ctx)) {
        ctx.ui.notify('context-manager: queued compaction dropped (run was aborted).', 'warning');
      }
      return;
    }
    // Awaiting keeps the run settling (and the process alive in print mode)
    // until the summarizer finishes; `compact()`'s internal abort is a no-op here.
    await runQueuedCompaction(ctx);
  });

  pi.on('session_before_compact', async (event, ctx) => {
    // Only veto a compaction THIS tool requested. pi also compacts on its own
    // (reason "threshold" / "overflow"); cancelling those because our low-yield
    // guard applies would abort an unrelated, necessary auto-compaction — and
    // reporting it as "context_compact cancelled" in the TUI is misleading.
    if (event.reason !== 'manual' || !state.config.enabled || !state.pendingCompact) {
      return undefined;
    }
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return undefined;
    const capacity = usage.contextWindow;
    const pct = capacity > 0 ? (usage.tokens / capacity) * 100 : 0;
    if (pct < state.config.lowYieldPercent) {
      state.pendingCompact = false;
      if (ctx.mode === 'tui') {
        ctx.ui.notify(
          `context_compact cancelled: usage ${formatPercent(usage.tokens / capacity)} < ${state.config.lowYieldPercent}%`,
          'warning',
        );
      }
      return { cancel: true };
    }
    return undefined;
  });

  pi.on('session_compact', async (event, ctx) => {
    const parsed = Date.parse(event.compactionEntry.timestamp);
    const at = Number.isNaN(parsed) ? Date.now() : parsed;
    state.onCompacted(at);

    if (!state.config.enabled || !state.config.anchorBreakMessage) return;
    const after = ctx.getContextUsage()?.tokens ?? null;
    const text =
      `Compaction completed: ${formatTokens(event.compactionEntry.tokensBefore)} → ` +
      `${after === null ? 'recalculating' : formatTokens(after)}. ` +
      `Prior context is now a lossy summary; durable state (files, /tmp, alarms, git) is intact. ` +
      `Do not assume context is still nearly full.`;
    pi.sendMessage(
      {
        customType: MANAGER_MESSAGE_TYPE,
        content: text,
        display: state.config.showAnchorBreak,
        details: { kind: 'anchor-break' },
      },
      { triggerTurn: false },
    );
  });

  looseApi.on('session_compact_failed', async (event: any, ctx: any) => {
    state.pendingCompact = false;
    state.clearCompacting();
    state.lastCompactError = event.errorMessage ?? (event.aborted ? 'aborted or cancelled' : 'unknown');
    if (isTui(ctx) && event.errorMessage) {
      ctx.ui.notify(`Compaction failed: ${event.errorMessage}`, 'warning');
    }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    state.clearQueuedCompaction();
    if (ctx.mode === 'tui') ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ── tools ────────────────────────────────────────────────────────────────

  registerContextManagerTools(pi, deps, () => configPath);

  // ── command: /context-manager ────────────────────────────────────────────

  pi.registerCommand('context-manager', {
    description: 'Show context-manager status, or run: on | off | threshold <key> <value> | prune on|off',
    handler: async (args, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] ?? 'status').toLowerCase();

      if (sub === 'on' || sub === 'off') {
        patchConfig({ enabled: sub === 'on' }, ctx);
        return;
      }

      if (sub === 'prune') {
        const value = (argv[1] ?? '').toLowerCase();
        if (value === 'on' || value === 'off') {
          patchConfig({ pruneEnabled: value === 'on' }, ctx);
          return;
        }
        ctx.ui.notify('Usage: /context-manager prune on|off', 'info');
        return;
      }

      if (sub === 'threshold') {
        const key = (argv[1] ?? '').toLowerCase();
        const value = argv[2];
        const num = Number(value);
        if (!key || value === undefined || !Number.isFinite(num)) {
          ctx.ui.notify(
            'Usage: /context-manager threshold <low-yield|compact-cooldown|prune-cooldown|prune-quota|milestones> <value>',
            'info',
          );
          return;
        }
        switch (key) {
          case 'low-yield':
            patchConfig({ lowYieldPercent: Math.min(100, Math.max(0, num)) }, ctx);
            return;
          case 'compact-cooldown':
            patchConfig({ compactCooldownMinutes: Math.max(0, num) }, ctx);
            return;
          case 'prune-cooldown':
            patchConfig({ pruneCooldownMinutes: Math.max(0, num) }, ctx);
            return;
          case 'prune-quota':
            patchConfig({ pruneQuota: Math.max(1, Math.floor(num)) }, ctx);
            return;
          case 'milestones': {
            const values = argv
              .slice(2)
              .flatMap((part) => part.split(','))
              .map((part) => Number(part))
              .filter((n) => Number.isFinite(n) && n > 0 && n <= 200);
            if (values.length === 0) {
              ctx.ui.notify('Usage: /context-manager threshold milestones 40,60,80', 'info');
              return;
            }
            patchConfig({ milestoneThresholds: [...new Set(values)].sort((a, b) => a - b) }, ctx);
            return;
          }
          default:
            ctx.ui.notify(`Unknown threshold key: ${key}`, 'info');
            return;
        }
      }

      if (sub === 'status') {
        pruneExtensionActive = detectPruneExtension(ctx.cwd, pi);
        ctx.ui.notify(
          `context-manager ${state.config.enabled ? 'ON' : 'OFF'}\n` +
            buildStatusReport(ctx, deps, configPath),
          'info',
        );
        return;
      }

      ctx.ui.notify(
        'Usage: /context-manager [status] | on | off | prune on|off | threshold <key> <value>',
        'info',
      );
    },
  });
}

// ── module helpers ─────────────────────────────────────────────────────────

function detectPruneExtension(cwd: string, pi: ExtensionAPI): boolean {
  const settingsPaths = [
    path.join(cwd, '.pi', 'context-prune', 'settings.json'),
    path.join(getAgentDir(), 'context-prune', 'settings.json'),
  ];
  let sawSettings = false;
  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
    sawSettings = true;
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { enabled?: unknown };
      if (parsed?.enabled === true) return true;
    } catch {
      /* ignore malformed settings */
    }
  }
  if (sawSettings) return false;
  // No settings file: treat a registered pruner tool as active (its default is enabled).
  try {
    const tools = pi.getAllTools() as Array<{ name: string }> | undefined;
    if (tools?.some((tool) => tool.name === 'context_tree_query')) return true;
  } catch {
    /* ignore */
  }
  return false;
}
