# pi-context-manager 设计共识（开发规格）

> 本文是开发前的设计共识。开发前请通读全文。
> 背景案例论证见 RESEARCH.md；pi 官方文档：
> `<pi-pkg>/docs/compaction.md`、`<pi-pkg>/docs/extensions.md`（`<pi-pkg>` = pnpm 全局目录下 `@earendil-works/pi-coding-agent@1.1.0` 包路径）；
> 类型定义：`<pi-pkg>/dist/core/extensions/types.d.ts`。

## 0. 问题定义（为什么做）

对真实长会话（约 1M 窗口、数千条条目）的量化分析发现：

1. **模型对自身上下文用量毫无感知，自估误差高达 90 个百分点**（声称 98% 时实际 6–29%）。pi 不向模型注入真实用量。
2. 约 30% 的 assistant thinking 含上下文焦虑措辞；其中 **46% 发生在真实占用 <60% 时**（纯虚警）。压缩后 summary 遗留的旧自估数字形成锚点，之后数百轮持续无效自我压抑。
3. 真实濒死期（>95%）产生"ONE command"仓促收尾行为，诱发操作失误。
4. 默认 `reserveTokens=16384` 使 1M 窗口模型拖到 98.4% 才自动压缩，压缩点永远落在任务中途而非语义边界。

**目标**：给模型上下文可见性（纠偏）+ 受控的主动管理能力（引入新自由度但带护栏）。前者几乎无副作用，后者必须护栏从严。

## 1. 模块规格

### A. 状态注入（三通道混合）

> **修订（2026-10-09，实现期确认）**：原方案「每轮向 `systemPromptOptions` 追加状态行」不可接受。
> system prompt 是上下文最前缀，每轮改动会使 openai-completions 类 provider 无法表达增量、退回完整 checkpoint，
> 其后全部 token 前缀缓存失效——在缓存读取与输入单价相差约 50 倍的 provider 上，接近满窗的上下文每轮都会多付可观的费用。
> 反向方案「每轮 append-only custom message」也有隐蔽缺陷：500 轮 × ~30 tokens = 15K 陈旧读数永久驻留，
> 且互相矛盾的旧数字正是本扩展要修掉的「陈旧锚点」。
> 故改为三通道混合：**静态 boot 块** + **阈值里程碑一次性追加** + **按需只读工具**，兼顾缓存与新鲜度。

**1. Boot line（system prompt section，窗口级静态，cache-stable）**

只在 compaction 边界变更内容——压缩本身已重写全部上下文、缓存已死，此时改 system prompt 零额外代价；
窗口存活期内字符串逐字不变。写入 `systemPromptOptions.sections['context-manager']`。

```
[context-manager] window 3 · compacted 2× (last 16:43) · summary covers 977K of prior context · capacity 1M · soft-limit 620K · call context_status before planning long tasks
```

- 窗口编号 = 分支上 compaction entries 数 + 1；压缩次数/最近时间/`tokensBefore` 均从分支推导，零额外状态
- 不含每轮变化的百分比（否则破坏 cache-stable 前提）；soft-limit = 警戒阈值（见 E）
- `tokens === null` 时 boot line 照常显示容量，但不显示旧百分比

**2. 里程碑消息（append-only custom message，阈值跨越时一次性注入）**

`before_agent_start` 中比对 `getContextUsage()` 与已注入档位，**跨越才注入、不跨不注入**。

- 档位为 soft-limit 的比例，默认 `[40, 60, 80]`（可配 `milestoneThresholds`）
- 每窗口最多 3~5 条 ≈ 100 tokens，单调递增、互不矛盾
- 上下文回缩（prune / 压缩后回落）时复位对应档位记录；压缩后进入新窗口清空全部记录
- `null` 窗口（压缩后重算中）跳过本轮检测

**3. `context_status` 只读工具（按需）**

无参数，返回精确用量 + 倒计时到 soft-limit + 压缩/裁剪账本 + 护栏配置；
boot line 教模型「规划长任务前调用」。工具声明约 80 tokens，计入上下文预算。

**压缩后一次性破锚消息**（`session_compact` 触发，append-only 注入一次）：

```
Compaction completed: 977K → 66K. Prior context is now a lossy summary; durable state (files, /tmp, alarms, git) is intact. Do not assume context is still nearly full.
```

- 该消息发生在上下文最小点，append-only，缓存代价 ≈ 0，保留原设计

**额外收益**：D 模块的 TUI footer 状态行每轮刷新给**用户**看（渲染不进模型上下文，零缓存代价）——
用户看实时，模型看里程碑与 boot line，两不误。

### B. `context_compact` 工具（主动压缩，中风险带护栏）

- 参数：`instructions`（可选，聚焦摘要；含 keep-list）、`keep`（可选字符串数组，逐字保留的关键事实，**总量 ≤ 窗口 5%**，超限报错）
- keep-list 内容必须**显式给全文**写入 `customInstructions`——pi 原生压缩把 tool result 截到 2000 字符才送摘要器，引用式保留会丢（proper-compact 的发现，见 RESEARCH.md）
- 护栏（全部实现）：
  - **idle-only**：`ctx.isIdle()` 为 false 时拒绝并回"wait for idle"
    > **实现澄清**：pi 的 `isIdle = !isAgentRunActive && !isCompacting`，而工具 `execute()` 必然运行在 agent run 内部，
    > 因此工具执行期 `ctx.isIdle()` 恒为 false。改用等效护栏：`state.compacting`（已有压缩在途）为 true 时拒绝并提示 "wait for idle"；
    > 同时把工具声明为 `executionMode: "sequential"`，避免与同批兄弟工具并发。
    > `session_before_compact` 钩子仍按规格对 B 触发的压缩做占用 <50% 的 cancel 最后防线（仅 `reason === 'manual'`）；
    > 在途标记复位分两层：**确定性**复位在 `rebuildFromBranch()`（每次 `session_start`）——新会话不可能拥有上一个会话的在途压缩，
    > 无条件成立；**兜底**是 10 分钟 TTL，覆盖同一会话内丢事件，避免工具被永久锁死。
  - **冷却期**：距上次压缩 < 10 分钟拒绝（可配置）
  - **低收益拒绝**：真实占用 < 50% 时拒绝并回当前真实用量
  - **教导式 description**：写明"仅在任务边界（一批工作完成、报告已交付后）调用；勿连续调用；每次压缩 = 一次缓存失效"
- 执行：工具只做护栏校验并**入队**（`state.queuedCompact`）；真正的 `ctx.compact({ customInstructions, onComplete })` 由
  `agent_settled` 处理器在当前 run 完全 settle 后发起，完成/失败由 `session_compact` / `session_compact_failed` 与锚定消息回报
  > **实现修订 v2（已实测，取代 fire-and-forget）**：pi 的 `ctx.compact()` 首行是 `await abort()`。从工具 `execute()` 里调用它，
  > 即使不 await，abort 的**效果**也已同步生效（置 `_agentRunAbortRequested = true` 并调用 `agent.abort()`；
  > 只有那个 async 函数本身要等到 `waitForIdle()` 才返回）：当前 run 被中断，agent loop 在 `signal.aborted` 后直接 break——同一批中排在后面的
  > tool call 被**静默丢弃**（无 toolResult），并多出一条 `stopReason=error` 的 aborted assistant 消息；若压缩随后失败
  > （如 "Nothing to compact"），中断已经发生且不可撤销。因此改为**排队 + 延迟执行**：`agent_settled` 是首个
  > `_isAgentRunActive === false` 的时刻，此处的 `ctx.compact()` 内部 abort 为 no-op，既不打断回合也不丢调用。
  > 若 run 被用户 abort，则丢弃排队请求并提示；同一 run 内重复请求被拒绝。
  >
  > **旧结论纠偏**：早先那版“若在工具里 `await ctx.compact()` 会死锁”只解释了不可 await 的原因，容易被读成
  > “别 await，fire-and-forget 就行”——而 fire-and-forget 同样会打断回合。正确结论是：**只要当前 run 仍在活动，
  > 任何形式的 `ctx.compact()` 调用都不安全，与是否 await 无关**；唯一安全的调用点是 run 完全 settle 之后。

### C. `context_prune` 工具（定向删除，中风险带护栏）

- 删除对象：**仅 toolResult**（绝不碰 user 消息、assistant 推理、当前回合结果），且必须是已蒸馏外置的陈旧大体积输出
- 落地方式：`turn_end` / `agent_before_settle` 边界事件返回 `ContextEditEntryDraft { targetId, replacement: null }`（API 天然只能在边界生效；`appendEntry()` 写不了 context_edit，不要尝试）
- 护栏：
  - 最小年龄：只能删上一压缩边界之前的条目
    > **实现口径**：候选必须处于当前保留窗口内（索引 ≥ 最近压缩的 `firstKeptEntryId`，否则已被摘要移除）
    > **且**早于最近一条 compaction entry（存活过边界）；无任何 compaction 时退化为「至少早于最近 `pruneMinAgeTurns`（默认 3）个 user 消息跨度」。
    > 压缩后新增的条目受保护，直到下一次压缩。
  - 每次配额（默认 10 条）+ 冷却（30 分钟）
  - **`externalizedTo` 必填**：参数中必须给出"原文已外置到哪个文件"的路径，写入删除台账
  - **召回 ref**：删除后注入一行短别名（如 `pruned refs: t1 t2 t3 → /tmp/xxx, /tmp/yyy`），模型可随时引用——生态三位独立作者都做了删后可召回（context_tree_query / decompress / evidence recall），这是标配不是可选项
  > **实现口径**：边界事件的返回值是**替换**语义（`entries = handlerResult.entries`），故 `turn_end` / `agent_before_settle`
  > 必须把 `event.entries` 带上再追加自己的草稿，否则同一边界上先跑的 handler 产出的 `context_edit` 会被静默丢弃。
- 若会话里装了 pi-context-prune，prune 动作要检测并让位（避免双重裁剪），status 行提示
  > **实现口径**：工具**无条件注册**，让位只在运行期判定（加载期检测只能看到已加载的扩展，与加载顺序竞争）。

### D. 护栏 hook + 审计

- `session_before_compact`：对 B 触发的压缩做最后防线（占用 < 50% cancel 并通知）；只拦 `reason === 'manual'`
  且由本扩展发起的那次，pi 自己的 `threshold` / `overflow` 自动压缩不受影响
- `session_compact` / `session_compact_failed`：记账（次数、时间、触发方、前后 token、失败原因），供 A 的状态行和 `/context-manager` 命令展示
- 注册 `/context-manager` 命令：status（当前用量/账本/护栏配置）、on/off、threshold 设置

### E. 配套（零代码，随扩展 README 交付）

```json
"compaction": { "modelOverrides": { "<provider>/<model>": { "reserveTokens": 400000 } } }
```
→ soft-limit ~60% 提前自动压缩。README 中说明该设置与本扩展的关系（状态行的 soft-limit 读此值）。

### F. Phase 2（本期不做，接口预留）

- 可压缩区段提示（"哪还能省"，参考 acp_status）
- read 去重（@henryqw 做法）：旧 read 结果在受保护近期上下文有逐字相同新版本时确定性替换
- budget close-out（@astrosheep）：警戒线上方允许模型多回合收尾再压缩、新窗口续跑——若 B + E 落地后案例行为仍不理想再上

## 2. 通用约束

- 仓库结构遵循 pi 插件惯例；`pi.contextBudget` 诚实标注（目标 ≤ 300 tokens：1 状态行 + 2 工具声明）
- 工具 description 全部写明护栏规则本身（模型看得见的护栏才是护栏）
- 优先 Layer A 验证：A 单独生效就可能消除一半问题；B/C 的必要性等 A 上线后观察
- 测试：用 1M 窗口的真实长会话验证
- 同步更新公开插件索引

## 3. 验收标准

1. Boot line 在每轮 system prompt 可见、窗口内逐字稳定；里程碑消息按阈值跨越一次性注入；`context_status` 数值与 `getContextUsage()` 一致；压缩后 null 窗口正确处理；破锚消息触发一次
2. 虚警场景（占用 <50% 调 compact）被拒且返回真实用量
3. keep-list 超限被拒；prune 无 externalizedTo 被拒；prune 只在边界生效且台账完整
4. 回放真实长会话时，`context_status` / boot line 数字与 jsonl 里 usage 记录吻合
