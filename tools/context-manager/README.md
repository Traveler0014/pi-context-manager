# pi-context-manager

给 pi 模型**上下文可见性**（纠偏）与**受控的主动管理能力**（带护栏）。

> 设计共识与论证见仓库 `docs/context-manager-spec/CONSENSUS.md` 与 `RESEARCH.md`。

## 为什么

对真实长会话（约 1M 窗口）的量化分析发现：

- 模型对自身上下文用量**毫无感知**，显式百分比声明全部严重高估（声称 98% 时实际 6–29%）；
- 30% 的 thinking 含上下文焦虑措辞，其中 **46% 发生在真实占用 <60%**（纯虚警）；
- 压缩 summary 遗留的旧自估数字会形成锚点，之后数百轮持续无效自我压抑；
- 默认 `reserveTokens=16384` 使 1M 窗口模型的自动压缩点拖到 98.4%——永远落在任务中途。

本扩展提供 Layer A（可见性，近零副作用）+ Layer B/C（受控主动管理，护栏从严）。

## 四个模块

### A. 状态注入（三通道混合，缓存友好）

> **关键权衡**：system prompt 是上下文最前缀，每轮改动会让 openai-completions 类 provider 退回完整
> checkpoint、其后全部 token 前缀缓存失效。本扩展因此**不**每轮刷新状态行，而是：

| 通道 | 载体 | 频率 | 缓存影响 |
|------|------|------|----------|
| **Boot line** | system prompt（追加文本） | 仅 compaction 边界变化 | 窗口内逐字稳定；压缩时缓存已失效，零额外代价 |
| **里程碑消息** | append-only custom message | 阈值跨越时一次性 | 前缀不变 |
| **`context_status`** | 只读工具，按需 | 模型主动调用 | 无 |
| **破锚消息** | `session_compact` 后 append-only | 每次压缩一次 | 上下文最小点，代价≈0 |

Boot line 示例：

```
[context-manager] window 3 · compacted 2× (last 16:43) · summary covers 977K of prior context · capacity 1M · soft-limit 620K · call context_status before planning long tasks
```

里程碑（append-only，阈值默认 soft-limit 的 40/60/80%，可配）：

```
[context-manager] Context crossed 60% of the soft-limit (590K / 984K; 59% of capacity).
Auto-compaction triggers at 984K. If the current batch of work is wrapping up, call context_compact
at the next boundary; otherwise keep going — do not compact mid-task (each compaction invalidates the prompt cache).
```

压缩后破锚（一次性）：

```
Compaction completed: 977K → 66K. Prior context is now a lossy summary; durable state
(files, /tmp, alarms, git) is intact. Do not assume context is still nearly full.
```

- 压缩次数/最近时间/`tokensBefore` 从 sessionManager 分支上的 compaction entries 推导，零额外状态
- `tokens === null`（压缩后重算中）时 boot line 照常显示容量，但不显示旧百分比；里程碑检测跳过
- 上下文回缩（prune/压缩）时复位对应档位，避免同一窗口内重复告警

### B. `context_compact`（主动压缩，中风险）

- 参数：`instructions?`（聚焦摘要）、`keep?`（逐字保留的关键事实，总量 ≤ 窗口 5%）
- keep-list 内容**显式全文**写入 `customInstructions`（pi 原生压缩把 tool result 截到 2000 字符才送摘要器，引用式保留会丢）
- 护栏（description 与运行时同步声明/执行）：
  - **idle-only**：已有压缩在途时拒绝；工具声明为 `executionMode: "sequential"`
  - **冷却期**：距上次压缩 < 10 分钟拒绝（可配）
  - **低收益拒绝**：真实占用 < 50% 时拒绝并回真实用量
  - **缓存教导**：description 写明"仅在任务边界调用；每次压缩 = 一次缓存失效"
- 执行：工具只做护栏校验并把请求**入队**（`state.queuedCompact`），立即返回 "Compaction queued"。
  真正的 `ctx.compact({ customInstructions, onComplete, onError })` 由 `agent_settled` 处理器在
  **当前 run 完全 settle 之后**发起（此时 `abort()` 是 no-op），完成/失败通过 `session_compact` 破锚消息与 TUI 通知回报
- **不打断回合**：pi 的 manual `compact()` 首行是 `await abort()`；若在工具 `execute()` 里调用，会立刻中断当前 run，
  且 agent loop 在 signal aborted 后直接 break——同一批里排在后面的 tool call 会被**静默丢弃**（实测）。
  因此工具永不直接调用 `ctx.compact()`；请求随 run 结束自然生效；若该 run 被用户 abort，排队请求会被丢弃并提示
- 模型调用后应继续/结束当前批次；重复请求（同一 run 内第二次）会被拒绝，避免排队期间叠加

> 实现注记（`ctx.isIdle`）：pi 的 `isIdle = !isAgentRunActive && !isCompacting`，而工具必然运行在 agent run 内部，
> 因此工具执行期 `ctx.isIdle()` 恒为 false。此处改用等效护栏：`state.compacting` 在途标记 + 顺序执行 + 入队去重。
>
> 实现注记（为何必须在 `agent_settled`）：工具里 `await ctx.compact()` 会死锁（run 等工具、`waitForIdle` 等 run）；
> fire-and-forget 虽绕过死锁，但 abort 仍会打断回合。`agent_settled` 是首个 `_isAgentRunActive === false` 的时刻，
> `ctx.compact()` 内部的 abort 变成 no-op，因此这是工具形态下唯一既不打断回合也不丢调用的调用点。

### C. `context_prune`（定向删除，中风险）

- 删除对象：**仅 toolResult**，绝不碰 user 消息 / assistant 推理 / 当前回合结果
- 落地方式：`turn_end` / `agent_before_settle` 边界返回 `context_edit { targetId, replacement: null }`
  （API 天然只能在边界生效；`appendEntry()` 写不了 context_edit）
- 护栏：
  - **最小年龄**：候选必须**在当前保留窗口内**（entry 索引 ≥ 最近压缩的 `firstKeptEntryId`，否则已被摘要移除、
    裁剪无意义）**且早于最近一条 compaction entry**（即存活过至少一次压缩边界）；无 compaction 时退化为
    「至少早于最近 `pruneMinAgeTurns` 个 user 消息跨度」。压缩后新增的结果受保护，直到下一次压缩边界
  - 每次配额（默认 10 条）+ 冷却（30 分钟）
  - **`externalizedTo` 必填**，且默认要求该文件真实存在（无持久副本不可召回）
  - **召回 ref**：删除后注入 `[context-manager] Pruned N stale tool result(s) … Recall originals: t1→/tmp/x`，
    模型可随时 `read` 原文；台账以 `custom` entry 持久化，会话重载后可重建
- `dryRun: true` 先列出候选（entry id / 大小 / 工具名）

### D. 护栏 hook + 审计 + 命令

- `session_before_compact`：对 B 触发的压缩做最后防线（占用 < 50% cancel 并通知）
- `session_compact` / `session_compact_failed`：记账（次数、时间、前后 token、失败原因）
- `/context-manager` 命令：
  - `status`（默认）：当前用量 / 倒计时 / 账本 / 护栏配置 / 配置来源
  - `on` | `off`
  - `prune on|off`
  - `threshold low-yield <pct>` · `threshold compact-cooldown <min>` · `threshold prune-cooldown <min>` · `threshold prune-quota <n>` · `threshold milestones 40,60,80`

## 工具

| Tool | 说明 |
|------|------|
| `context_status` | 只读：精确用量 + 到 soft-limit 倒计时 + 压缩/裁剪账本 + 护栏配置 |
| `context_compact` | 带护栏的主动压缩（任务边界调用） |
| `context_prune` | 边界删除陈旧、已外置的 tool result，附召回 ref（检测到 pi-context-prune 时自动让位） |

## 配置

配置文件（首个命中生效）：

1. `PI_CONTEXT_MANAGER_CONFIG` 环境变量（内联 JSON 或文件路径）
2. `<project>/.pi/context-manager.json`
3. `~/.pi/agent/context-manager.json`
4. 内置默认值

```json
{
  "enabled": true,
  "statusInjection": true,
  "milestones": true,
  "milestoneThresholds": [40, 60, 80],
  "milestoneBase": "soft",
  "showMilestones": false,
  "anchorBreakMessage": true,
  "showAnchorBreak": true,
  "showPruneRecall": false,
  "footerStatus": true,
  "lowYieldPercent": 50,
  "compactCooldownMinutes": 10,
  "pruneEnabled": true,
  "pruneCooldownMinutes": 30,
  "pruneQuota": 10,
  "pruneMinAgeTurns": 3,
  "pruneMinChars": 8000,
  "pruneRequireExistingFile": true
}
```

`/context-manager` 的 `on/off` 与 `threshold` 子命令会写入 `~/.pi/agent/context-manager.json`。

## 与 pi 原生压缩设置（soft-limit）的关系

Boot line / 里程碑 / `context_status` 里的 **soft-limit = `contextWindow - reserveTokens`**，
即 pi 的自动压缩触发线。用 `compaction.modelOverrides` 提前自动压缩（示例）：

```json
{
  "compaction": {
    "modelOverrides": {
      "<provider>/<model>": { "reserveTokens": 400000 }
    }
  }
}
```

→ 1M 窗口模型的 soft-limit ≈ 600K（约 60%），远早于默认 98.4%。本扩展读取合并后的
`~/.pi/agent/settings.json` + `<project>/.pi/settings.json`，与 pi 的原生分辨率一致
（model override → 普通设置 → 默认 16384）。

## 与 pi-context-prune 共存

检测到 pi-context-prune 处于启用状态时，本扩展**不注册** `context_prune`（避免同名工具冲突与双重裁剪），
`/context-manager status` 会提示让位。检测来源：`.pi/context-prune/settings.json` 与
`~/.pi/agent/context-prune/settings.json` 的 `enabled`，或已注册的 `context_tree_query` 工具。

## 上下文预算

`pi.contextBudget` ≈ **450 tokens**：1 行窗口级静态 boot line + 3 个工具声明
（`context_status` ~80 / `context_compact` ~190 / `context_prune` ~180）。运行期 append-only 里程碑
每窗口 3~5 条 ≈ 100 tokens。

## 安装 / 开发

```bash
# 安装
pi install https://github.com/Traveler0014/pi-context-manager.git

# 本地开发（直接加载插件目录，无需安装）
pi -ne -e ./tools/context-manager -p "say hello"
```

配置变更后 `/reload` 生效。
