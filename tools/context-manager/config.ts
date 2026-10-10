/**
 * Configuration for pi-context-manager.
 *
 * Resolution order (first match wins):
 *   1. PI_CONTEXT_MANAGER_CONFIG env var — inline JSON object, or a path to a JSON file
 *   2. .pi/context-manager.json          — project-local
 *   3. ~/.pi/agent/context-manager.json  — user-global
 *   4. DEFAULT_CONFIG                    — built-in defaults
 *
 * Unknown keys are ignored; known keys fall back individually to defaults so a
 * partial config file is valid.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface ContextManagerConfig {
  /** Master switch. When false the extension is inert (handlers no-op). */
  enabled: boolean;
  /** Inject the window-static boot line into the system prompt. */
  statusInjection: boolean;
  /** Inject append-only milestone messages when usage crosses a threshold. */
  milestones: boolean;
  /**
   * Milestone thresholds as percentages of the chosen base (see milestoneBase),
   * ascending. Default [40, 60, 80].
   */
  milestoneThresholds: number[];
  /** Base for milestone thresholds: "soft" (soft-limit) or "window" (full capacity). */
  milestoneBase: 'soft' | 'window';
  /** Render milestone messages in the TUI transcript (still appended to model context either way). */
  showMilestones: boolean;
  /** Inject the one-shot anchor-break message after a compaction. */
  anchorBreakMessage: boolean;
  /** Render the anchor-break message in the TUI transcript. */
  showAnchorBreak: boolean;
  /** Render the prune recall line in the TUI transcript. */
  showPruneRecall: boolean;
  /** Show a live user-facing status line in the footer (does not enter model context). */
  footerStatus: boolean;
  /** Minimum real usage (percent of capacity) required for context_compact. */
  lowYieldPercent: number;
  /** Minimum minutes between compactions (context_compact cooldown). */
  compactCooldownMinutes: number;
  /** Enable the context_prune tool. */
  pruneEnabled: boolean;
  /** Minimum minutes between prune batches. */
  pruneCooldownMinutes: number;
  /** Maximum tool results removed per prune call. */
  pruneQuota: number;
  /** Minimum age in user-message spans when no compaction boundary exists. */
  pruneMinAgeTurns: number;
  /** Minimum content size (characters) for an auto-selected prune candidate. */
  pruneMinChars: number;
  /** Require externalizedTo to point at an existing file. */
  pruneRequireExistingFile: boolean;
}

export const DEFAULT_CONFIG: ContextManagerConfig = {
  enabled: true,
  statusInjection: true,
  milestones: true,
  milestoneThresholds: [40, 60, 80],
  milestoneBase: 'soft',
  showMilestones: false,
  anchorBreakMessage: true,
  showAnchorBreak: true,
  showPruneRecall: false,
  footerStatus: true,
  lowYieldPercent: 50,
  compactCooldownMinutes: 10,
  pruneEnabled: true,
  pruneCooldownMinutes: 30,
  pruneQuota: 10,
  pruneMinAgeTurns: 3,
  pruneMinChars: 8000,
  pruneRequireExistingFile: true,
};

export interface LoadedConfig {
  config: ContextManagerConfig;
  /** Where the config came from (for diagnostics). */
  source: string;
  /** Non-fatal notice to surface once (e.g. malformed file ignored). */
  notice?: string;
}

export function loadConfig(cwd: string): LoadedConfig {
  const envRaw = process.env.PI_CONTEXT_MANAGER_CONFIG?.trim();
  if (envRaw) {
    try {
      if (envRaw.startsWith('{')) {
        return { config: mergeConfig(JSON.parse(envRaw)), source: 'PI_CONTEXT_MANAGER_CONFIG' };
      }
      const expanded = expandHome(envRaw);
      const filePath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      return readConfigFile(filePath);
    } catch (err) {
      return {
        config: { ...DEFAULT_CONFIG },
        source: 'defaults',
        notice: `PI_CONTEXT_MANAGER_CONFIG ignored: ${String(err)}`,
      };
    }
  }

  const projectConfig = path.join(cwd, '.pi', 'context-manager.json');
  if (existsSync(projectConfig)) return readConfigFile(projectConfig);

  const userConfig = path.join(getAgentDir(), 'context-manager.json');
  if (existsSync(userConfig)) return readConfigFile(userConfig);

  return { config: { ...DEFAULT_CONFIG }, source: 'defaults' };
}

function readConfigFile(filePath: string): LoadedConfig {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return { config: mergeConfig(JSON.parse(raw)), source: filePath };
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: filePath,
      notice: `context-manager config ${filePath} ignored: ${String(err)}`,
    };
  }
}

function mergeConfig(raw: unknown): ContextManagerConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ContextManagerConfig = { ...DEFAULT_CONFIG };

  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  if (typeof input.statusInjection === 'boolean') out.statusInjection = input.statusInjection;
  if (typeof input.milestones === 'boolean') out.milestones = input.milestones;
  if (Array.isArray(input.milestoneThresholds)) {
    const values = input.milestoneThresholds
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0 && v <= 200);
    if (values.length > 0) out.milestoneThresholds = [...new Set(values)].sort((a, b) => a - b);
  }
  if (input.milestoneBase === 'soft' || input.milestoneBase === 'window') {
    out.milestoneBase = input.milestoneBase;
  }
  if (typeof input.showMilestones === 'boolean') out.showMilestones = input.showMilestones;
  if (typeof input.anchorBreakMessage === 'boolean') out.anchorBreakMessage = input.anchorBreakMessage;
  if (typeof input.showAnchorBreak === 'boolean') out.showAnchorBreak = input.showAnchorBreak;
  if (typeof input.showPruneRecall === 'boolean') out.showPruneRecall = input.showPruneRecall;
  if (typeof input.footerStatus === 'boolean') out.footerStatus = input.footerStatus;
  if (typeof input.lowYieldPercent === 'number') {
    out.lowYieldPercent = clamp(input.lowYieldPercent, 0, 100);
  }
  if (typeof input.compactCooldownMinutes === 'number') {
    out.compactCooldownMinutes = Math.max(0, input.compactCooldownMinutes);
  }
  if (typeof input.pruneEnabled === 'boolean') out.pruneEnabled = input.pruneEnabled;
  if (typeof input.pruneCooldownMinutes === 'number') {
    out.pruneCooldownMinutes = Math.max(0, input.pruneCooldownMinutes);
  }
  if (typeof input.pruneQuota === 'number') {
    out.pruneQuota = Math.max(1, Math.floor(input.pruneQuota));
  }
  if (typeof input.pruneMinAgeTurns === 'number') {
    out.pruneMinAgeTurns = Math.max(0, Math.floor(input.pruneMinAgeTurns));
  }
  if (typeof input.pruneMinChars === 'number') {
    out.pruneMinChars = Math.max(0, Math.floor(input.pruneMinChars));
  }
  if (typeof input.pruneRequireExistingFile === 'boolean') {
    out.pruneRequireExistingFile = input.pruneRequireExistingFile;
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface ConfigWriteResult {
  path: string;
  config: ContextManagerConfig;
}

/** Persist a partial patch to the user-global config and return the merged result. */
export function saveUserConfig(patch: Partial<ContextManagerConfig>): ConfigWriteResult {
  const dir = getAgentDir();
  const filePath = path.join(dir, 'context-manager.json');
  let current: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...patch };
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { path: filePath, config: mergeConfig(merged) };
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── effective pi settings resolution ────────────────────────────────────────

const DEFAULT_RESERVE_TOKENS = 16384;

interface CompactionSettingsLike {
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
  modelOverrides?:
    | Record<string, { reserveTokens?: unknown; keepRecentTokens?: unknown }>
    | undefined;
}

/**
 * Resolve the effective `reserveTokens` the same way pi does:
 * model override → ordinary setting → built-in default. Invalid values fall
 * back to the default rather than throwing (the extension must never block pi).
 */
export function resolveReserveTokens(
  settings: Record<string, unknown> | undefined,
  model: { provider: string; id: string } | undefined,
): number {
  const compaction = settings?.compaction as CompactionSettingsLike | undefined;
  const ordinary = compaction?.reserveTokens;
  const key = model ? `${model.provider}/${model.id}` : undefined;
  const override = key ? compaction?.modelOverrides?.[key]?.reserveTokens : undefined;
  return asNonNegativeInt(override) ?? asNonNegativeInt(ordinary) ?? DEFAULT_RESERVE_TOKENS;
}

export interface EffectiveCompaction {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  source: string;
}

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Read the merged global + project pi settings and resolve compaction budgets.
 * Reading the files directly (instead of `pi.getSettings()`) keeps the
 * extension working across pi versions whose ExtensionAPI surface differs.
 */
export function loadEffectiveCompaction(
  cwd: string,
  model: { provider: string; id: string } | undefined,
): EffectiveCompaction {
  const globalPath = path.join(getAgentDir(), 'settings.json');
  const projectPath = path.join(cwd, '.pi', 'settings.json');
  const merged = mergeSettings(readJsonObject(globalPath), readJsonObject(projectPath));
  const compaction = (merged.compaction ?? {}) as CompactionSettingsLike & {
    enabled?: unknown;
    keepRecentTokens?: unknown;
  };
  const key = model ? `${model.provider}/${model.id}` : undefined;
  const override = key ? compaction.modelOverrides?.[key] : undefined;
  const source = existsSync(projectPath) ? projectPath : existsSync(globalPath) ? globalPath : 'defaults';
  return {
    enabled: compaction.enabled !== false,
    reserveTokens: resolveReserveTokens(merged, model),
    keepRecentTokens:
      asNonNegativeInt(override?.keepRecentTokens) ??
      asNonNegativeInt(compaction.keepRecentTokens) ??
      DEFAULT_KEEP_RECENT_TOKENS,
    source,
  };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mergeSettings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeSettings(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
