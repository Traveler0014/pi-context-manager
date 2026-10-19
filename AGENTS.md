# AGENTS.md — repository guide

Standalone single-plugin repo for **pi-context-manager**, published to GitHub and installed with `pi install`.

## Layout

```
.
├── README.md                     # manual preamble + auto-generated catalog (<!-- AUTO --> marker)
├── package.json                  # repo config: repository / installUrl / pi.extensions
├── tsconfig.json                 # root typecheck (tools/** + scripts/**)
├── vitest.config.ts
├── scripts/
│   ├── update-docs.ts            # AST scan of pi.extensions → regenerate README catalog
│   └── release.sh                # bump plugin version + commit + tag + push
├── docs/context-manager-spec/    # design consensus + research (source of truth for behavior)
└── tools/context-manager/        # the extension itself
    ├── index.ts                  # pi registration glue (only file that imports the pi API)
    ├── tools.ts                  # context_status / context_compact / context_prune
    ├── config.ts                 # config resolution + pi compaction-settings resolution
    ├── state.ts                  # session state, prune ledger, compaction derivation
    ├── usage.ts                  # pure formatting / math helpers
    ├── usage.test.ts             # vitest unit tests
    ├── package.json              # plugin metadata + pi manifest
    ├── tsconfig.json             # plugin-local typecheck
    └── README.md                 # user-facing docs
```

## Commands

```bash
npm install                      # dev deps only
npm run typecheck                # tsc --noEmit over tools/** and scripts/**
npm test                         # vitest unit tests
npm run update-docs              # regenerate the README catalog (never hand-edit that section)
npm run release -- tools/context-manager patch   # version + commit + tag + push
```

Development smoke test (loads the extension without installing):

```bash
pi -ne -e ./tools/context-manager -p 'list available tools'
```

Runtime self-check inside a session: `/context-manager status`.

## Plugin conventions

Plugin design rules (naming, tool/command design, error signaling, testing, state, environment
dependencies) live in the **pi-extension-dev skill** — load `/skill:pi-extension-dev` rather than
duplicating them here. Repo-specific notes:

- Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`) stay in `peerDependencies`
  with `"*"`; never move them to `dependencies` (pi maps them at runtime and warns on duplicates).
- Runtime dependencies, if ever added, must go in `dependencies` — `pi install` runs
  `npm install --omit=dev`.
- The plugin's user-facing docs live in `tools/context-manager/README.md`; keep it in sync with the
  behavior and configuration fields.

## Release

Tags follow `<extension-path>@<semver>` → `tools/context-manager@0.1.0`.

`bash scripts/release.sh tools/context-manager <major|minor|patch|x.y.z>` bumps the plugin version,
regenerates the README catalog, commits, tags, and pushes. Version semantics: patch = fixes only;
minor = new tools / backward-compatible features; major = tool renames or removals, breaking contracts.

Two constraints of the script that shape the workflow:

- **Dirty worktree aborts.** Preflight runs `git diff --quiet -- <extension-path>` and exits 1, so the
  fix/docs commit must land *before* `release.sh`.
- **Staging is `git add <extension-path> README.md`.** `docs/` and the root `package.json` are never
  staged, so any change under `docs/` (e.g. `docs/context-manager-spec/CONSENSUS.md`) must be in its own
  commit first — otherwise it stays in the worktree and the pushed docs keep the old wording.

So a release is always two commits: the change commit (code + tests + `docs/`) and the release commit
(`package.json` version bump only).

Before releasing: `npm run typecheck` clean, `npm test` green, README updated, smoke test passes,
and CI (`.github/workflows/ci.yml`) green.
