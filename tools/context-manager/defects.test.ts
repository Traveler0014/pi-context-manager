/**
 * Regression tests for the context-manager defects fixed after the standalone
 * extraction. Run with: `npm test` (vitest).
 *
 * These deliberately drive the REAL extension entry point through a fake
 * ExtensionAPI, because every defect here lived in event wiring (boundary
 * entry replacement, compaction reason, registration order) rather than in a
 * pure helper.
 */

import { afterAll, describe, expect, it } from 'vitest';
import contextManager from './index.js';
import { DEFAULT_CONFIG } from './config.js';
import { ContextManagerState } from './state.js';
import { formatTokens } from './usage.js';

// ── harness ────────────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
  on(event: string, handler: Handler): void;
  registerTool(tool: { name: string; execute: Function }): void;
  registerCommand(name: string, options: unknown): void;
  getAllTools(): Array<{ name: string }>;
  handlers: Map<string, Handler[]>;
  tools: Map<string, { name: string; execute: Function }>;
  emit(event: string, ev: any, ctx: any): Promise<unknown>;
  callTool(name: string, params: unknown, ctx: any): Promise<any>;
}

function makePi(options: { allTools?: Array<{ name: string }> } = {}): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { name: string; execute: Function }>();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.set(tool.name, tool as { name: string; execute: Function });
    },
    registerCommand() {
      /* not exercised */
    },
    getAllTools: () => options.allTools ?? [],
    async emit(event, ev, ctx) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler(ev, ctx);
      return result;
    },
    async callTool(name, params, ctx) {
      const tool = tools.get(name);
      expect(tool, `tool ${name} is registered`).toBeTruthy();
      return tool!.execute('call-1', params, undefined, undefined, ctx);
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): any {
  const branch = (overrides.branch as unknown[]) ?? [];
  return {
    cwd: '/tmp/context-manager-test',
    mode: 'print',
    model: { provider: 'test', id: 'test-model', contextWindow: 1_000_000 },
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }),
    compact: () => {},
    ...overrides,
  };
}

const ORIGINAL_CONFIG_ENV = process.env.PI_CONTEXT_MANAGER_CONFIG;
afterAll(() => {
  if (ORIGINAL_CONFIG_ENV === undefined) delete process.env.PI_CONTEXT_MANAGER_CONFIG;
  else process.env.PI_CONTEXT_MANAGER_CONFIG = ORIGINAL_CONFIG_ENV;
});

/** Boot the extension with a deterministic config (inline env, highest precedence). */
async function boot(pi: FakePi, ctx: any): Promise<void> {
  process.env.PI_CONTEXT_MANAGER_CONFIG = JSON.stringify({ enabled: true });
  contextManager(pi as any);
  await pi.emit('session_start', { reason: 'startup' }, ctx);
}

// ── D7: token formatting at the K/M boundary ───────────────────────────────

describe('D7 formatTokens', () => {
  it('never renders 1000K', () => {
    expect(formatTokens(999_499)).toBe('999K');
    expect(formatTokens(999_500)).toBe('1M');
    expect(formatTokens(999_999)).toBe('1M');
    expect(formatTokens(1_000_000)).toBe('1M');
  });
});

// ── D3: compacting flag has a TTL and self-heals ───────────────────────────

describe('D3 compacting flag', () => {
  it('does not lock the tool forever after a lost event', () => {
    const state = new ContextManagerState({ ...DEFAULT_CONFIG });
    const t0 = 1_000_000;
    state.markCompacting(t0);
    expect(state.isCompacting(t0 + 1_000)).toBe(true);
    expect(state.isCompacting(t0 + ContextManagerState.COMPACTING_TTL_MS + 1)).toBe(false);
    expect(state.compacting).toBe(false);

    state.markCompacting(t0);
    state.clearCompacting();
    expect(state.isCompacting(t0)).toBe(false);
  });
});

// ── D4: context_prune is registered regardless of load order ───────────────

describe('D4 context_prune registration', () => {
  it('registers even when a pruner looks active, and yields at runtime', async () => {
    // A pruner that loaded before us is exactly the case that used to suppress
    // registration outright, permanently removing the tool for the session.
    const pi = makePi({ allTools: [{ name: 'context_tree_query' }] });
    const ctx = makeCtx();
    await boot(pi, ctx);

    expect(pi.tools.has('context_status')).toBe(true);
    expect(pi.tools.has('context_compact')).toBe(true);
    expect(pi.tools.has('context_prune')).toBe(true);

    const yielded = await pi.callTool('context_prune', { externalizedTo: '/tmp/x.txt' }, ctx);
    expect(yielded.isError).toBe(true);
    expect(yielded.content[0].text).toMatch(/yielding/);
  });
});

// ── D1: boundary entries are replaced, so inherited drafts must survive ────

describe('D1 boundary entry carry-forward', () => {
  it('turn_end preserves entries produced by earlier handlers', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await boot(pi, ctx);

    const inherited = [
      { type: 'custom_message', customType: 'other-ext', content: 'hi', display: false },
    ];
    const result = (await pi.emit(
      'turn_end',
      { type: 'turn_end', entries: inherited, continue: false },
      ctx,
    )) as { entries: unknown[] } | undefined;

    expect(result).toBeTruthy();
    expect(result!.entries).toEqual(inherited);

    const empty = (await pi.emit('turn_end', { type: 'turn_end', entries: [] }, ctx)) as
      | { entries: unknown[] }
      | undefined;
    expect(empty).toBeUndefined();
  });

  it('agent_before_settle applies the same carry-forward rule', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await boot(pi, ctx);

    const inherited = [{ type: 'context_edit', targetId: 'e1', replacement: null }];
    const result = (await pi.emit('agent_before_settle', { entries: inherited }, ctx)) as
      | { entries: unknown[] }
      | undefined;

    expect(result?.entries).toEqual(inherited);
  });
});

// ── D6: the low-yield guard only vetoes compaction this tool requested ─────

describe('D6 low-yield guard', () => {
  it('never cancels auto-compaction, still cancels its own', async () => {
    const pi = makePi();
    let finishCompact: (() => void) | undefined;
    const ctx = makeCtx({
      getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000 }),
      // The runtime detaches compact() internally; model that by capturing the
      // callbacks so the test controls when completion is reported.
      compact: (options: any) => {
        finishCompact = () => options?.onComplete?.({ tokensBefore: 600_000 });
      },
    });
    await boot(pi, ctx);

    // Queue through this extension's own tool path, then let `agent_settled`
    // start the real compaction (that is what arms the pendingCompact guard).
    const queued = await pi.callTool('context_compact', {}, ctx);
    expect(queued.isError).toBeFalsy();
    expect(queued.content[0].text).toMatch(/queued/i);

    const settled = pi.emit('agent_settled', { type: 'agent_settled', aborted: false }, ctx);

    const lowUsage = makeCtx({
      getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_000_000 }),
    });

    for (const reason of ['threshold', 'overflow'] as const) {
      const verdict = await pi.emit('session_before_compact', { reason }, lowUsage);
      expect(verdict).toBeUndefined();
    }

    const verdict = await pi.emit('session_before_compact', { reason: 'manual' }, lowUsage);
    expect(verdict).toEqual({ cancel: true });

    finishCompact?.();
    await settled;
  });
});

// ── B: context_compact must never call ctx.compact() from inside the tool ──
//
// pi's manual compact() starts with `await abort()`, which sets
// `_agentRunAbortRequested` synchronously (before its first await). Calling it
// from a tool therefore aborts the run and silently drops every later tool call
// in the same batch. The tool only queues; `agent_settled` performs the work.

describe('B deferred compaction', () => {
  it('queues instead of calling ctx.compact from the tool', async () => {
    let compactCalls = 0;
    let finishCompact: (() => void) | undefined;
    const ctx = makeCtx({
      getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000 }),
      compact: (options: any) => {
        compactCalls += 1;
        finishCompact = () => options?.onComplete?.({ tokensBefore: 600_000 });
      },
    });
    const pi = makePi();
    await boot(pi, ctx);

    const queued = await pi.callTool('context_compact', {}, ctx);
    expect(queued.isError).toBeFalsy();
    expect(compactCalls).toBe(0); // the regression this test exists to catch

    const settled = pi.emit('agent_settled', { type: 'agent_settled', aborted: false }, ctx);
    expect(compactCalls).toBe(1); // ...and only once the run has settled

    finishCompact?.();
    await settled;
  });

  it('refuses a second request before the queued one runs', async () => {
    const ctx = makeCtx({
      getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000 }),
      compact: () => {},
    });
    const pi = makePi();
    await boot(pi, ctx);

    expect((await pi.callTool('context_compact', {}, ctx)).isError).toBeFalsy();

    const second = await pi.callTool('context_compact', {}, ctx);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/already queued/i);
  });

  it('drops the queued request when the run is aborted', async () => {
    let compactCalls = 0;
    const ctx = makeCtx({
      getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000 }),
      compact: () => {
        compactCalls += 1;
      },
    });
    const pi = makePi();
    await boot(pi, ctx);

    expect((await pi.callTool('context_compact', {}, ctx)).isError).toBeFalsy();
    await pi.emit('agent_settled', { type: 'agent_settled', aborted: true }, ctx);

    expect(compactCalls).toBe(0);
    // The queue is empty again, so a new request is accepted.
    expect((await pi.callTool('context_compact', {}, ctx)).isError).toBeFalsy();
  });
});

// ── stale ctx: teardown reports through an invalidated ctx ─────────────────
//
// `dispose()` aborts compaction and only *then* invalidates the extension
// runner (agent-session.js: `abortCompaction()` … `invalidate()`), while
// `compact()`'s catch awaits `_emitSessionCompactFailed(...)` afterwards. So a
// compaction that fails during session replacement/quit is reported through an
// already-invalidated ctx. `runner.createContext()` itself does not throw —
// `mode`/`ui` are getters that call `assertActive()` — so the protection must be
// narrowed to reading `mode`, not wrap the whole handler: the state cleanup in
// that handler still has to run in the invalid window.

describe('stale ctx', () => {
  const STALE = 'This extension ctx is stale after session replacement or reload.';

  function staleCtx(): any {
    return {
      get mode(): string {
        throw new Error(STALE);
      },
      get ui(): unknown {
        throw new Error(STALE);
      },
    };
  }

  it('session_compact_failed tolerates a ctx invalidated by teardown', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await boot(pi, ctx);

    await expect(
      pi.emit(
        'session_compact_failed',
        { type: 'session_compact_failed', errorMessage: 'Compaction cancelled', aborted: true },
        staleCtx(),
      ),
    ).resolves.toBeUndefined();
  });

  // `session_shutdown` deliberately has no such guard: pi always emits it BEFORE
  // invalidating the runner (agent-session-runtime.js:106-112 for quit,
  // :297-302 for the other teardown, agent-session.js:2972-2973 for reload), so
  // `ctx.mode` is valid there. Adding `isTui()` would hide a real ordering
  // regression instead of surfacing it.
});
