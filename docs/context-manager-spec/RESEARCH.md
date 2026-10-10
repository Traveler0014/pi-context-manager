# pi 上下文压缩插件生态调研（设计依据）

> 调研日期：2026-10-09。来源：pi.dev package gallery（5407 包）、npm registry（含真实下载量）、awesome-pi-agent 索引、官方 examples。

## 1. 排名（上月下载，npm registry 实测）

| 插件 | 下载/月 | 机制 |
|---|---|---|
| billion-context (+acp-kernel) | 779.6K | 代理层压缩：模型自主 compress/decompress/search_context/acp_status 四工具，增量范围折叠，缓存友好 |
| @astrosheep/pi-context | 9.8K | Codex 式重置窗口 + 持久 notes + 9 个 history 工具 |
| pi-context-view | 8.6K | 用量可视化 + 检查隐藏上下文构成 |
| pi-context (ttttmr) | 4.1K | ACM：context_checkpoint/timeline/compact 三工具 |
| @henryqw/pi-auto-compact | 2.9K | 阈值压缩 + 重复 read 确定性去重 |
| pi-context-prune（已安装但禁用中） | 2.3K | 摘要化旧 toolResult + context_tree_query 召回；5 种触发模式 |
| @context-guardian/pi | 2.3K | 压缩前 topic 级人工审查 |
| pi-context-usage | 1.5K | 用量点阵图 |
| @maskpoint/pi | 850 | 确定性遮蔽（占位符）替代 LLM 摘要 |
| pi-compact | 758 | 无 LLM 压缩 + 精确历史召回 |

小众针对性强的：pi-midrun-compact（长工具循环中途安全压缩+续跑）、pi-pact（只压旧历史）、pi-press（后台预计算摘要）、proper-compact（证据保全）、pi-prefix-cache-compaction / pi-compaction-cache（复用服务端 KV 前缀缓存）。

## 2. 直接影响设计的发现

### 2.1 模型自主管理已被生态验证（Layer B 可行性）
- **billion-context**：生产级研究（4.5 个月、174,327 次调用、18.76B tokens、204.8K 窗口零违规），有论文；pi 原生插件形态。模型决定 when/what 压缩；`decompress` 可还原；`search_context` 跨摘要检索；`acp_status` 报用量+可压缩区段。
- **pi-context-prune 的 `agentic-auto` 模式（其默认）**：暴露 `context_prune` 工具，系统提示教模型"完成有意义的一批工作后才调用"。其 README 明确警告：模型调用过频会把缓存搅成 every-turn 模式——**直接印证我们的护栏设计**。
- **ttttmr/pi-context 的 checkpoint 命名规范**：`-start/-done/-pivot/-pause/-resume` 后缀结构化声明阶段边界——"语义边界"的可操作化参考。

### 2.2 前缀缓存是我们原设计漏掉的维度
- billion-context 健康基线：**95–97% 前缀缓存命中率，压缩本身成本 ≤2%**；做法是小范围增量折叠、缓存前缀保持完整。
- pi-context-prune 五模式权衡：`every-turn` 最伤缓存（仅调试）；`agent-message`（最终文本回复时一次剪）是最安全的自动化默认。
- 在缓存读取与输入单价相差约 50 倍的 provider 上尤其重要：每次过早压缩 = 一次 cache bust。
- 结论：B 工具 description 必须写明缓存成本意识；冷却期护栏必要。

### 2.3 删后可召回是生态标配（三位独立作者殊途同归）
- pi-context-prune：`context_tree_query` + 摘要尾部短 ref（`t1`,`t2` 映射真实 toolCallId）
- billion-context：`decompress` 还原压缩段
- proper-compact：压缩时送全文给摘要器（**发现 pi 原生压缩把 tool result 截到 2000 字符，长日志末尾的错误可能永远到不了摘要器**——我们的 keep-list 必须显式给全文）+ 事后证据召回

### 2.4 可见性的成熟做法（Layer A 参考）
- @astrosheep `get_context_remaining`：**倒计时到警戒线而非满窗**（`reserve + 16384`）
- @astrosheep budget close-out：硬储备上方设 warning 线，允许模型多回合收尾（写完 notes/发完报告）再压缩、新窗口继续而非停止——解决"任务中途被压缩打断"
- @astrosheep boot block：每个窗口头部一段 cache 稳定的静态块（窗口身份 + notes 索引 + 恢复协议）
- @arcanemachine/pi-context-available：极简只读工具，验证了"unknown"（压缩后 null）必须显式处理

### 2.5 确定性手法（零 LLM 成本，无幻觉）
- @maskpoint/pi：tool result → `[tool result omitted: read, ok, 72 lines, 2201 chars]` 占位符；只在占位符更小时遮蔽；cut point 完全尊重 pi 原生选择；实测 reasoning 遮蔽后 prompt tokens 降至 1/3 且 state recall 更好
- @henryqw/pi-auto-compact：重复 read 去重——旧 read 结果在近期受保护上下文有逐字相同新版本（工具名+参数+文本全等）时替换；失败/含图/已编辑的保留

### 2.6 压缩质量护栏
- @context-guardian：压缩预览审计"被否决的路径及其原因"是否保留（防止压缩后重蹈覆辙）——对我们 keep-list 的内容引导有参考：优先保"决策+否决理由+关键命令原文"，不是流水账
- proper-compact：bounded summaries + 可配置摘要器模型/预算/调用上限

## 3. 对共识稿的修订（已并入 CONSENSUS.md）

| 模块 | 修订 | 来源 |
|---|---|---|
| A | 倒计时口径（remaining before soft-limit） | @astrosheep |
| A | null 窗口显式处理 | @arcanemachine |
| B | 冷却 + 低收益拒绝 + 缓存成本教导 | pi-context-prune / billion-context |
| B | keep-list 显式全文 | proper-compact 的 2000 字符截断发现 |
| C | externalizedTo 必填 + 短 ref 召回 | 三重印证（见 2.3） |
| C | 与已装 pi-context-prune 的共存检测 | 共存实测 |
| F | read 去重、budget close-out、可压缩区段列为 Phase 2 | @henryqw / @astrosheep / acp_status |

## 4. 与其他方案的对比

本扩展定位为轻量方案，与 billion-context 等代理层方案互补：
- billion-context 是代理层方案，可与自建网关串联，适合作为对照实现
- 对比基准指标：95–97% 缓存命中率（billion-context 论文值）+ 长会话的焦虑措辞频率与输出体量
- 差异化优势 = 轻量、零代理、贴合原生 pi 会话与缓存模型

## 5. 案例观察（脱敏后的聚合数据）

对一段真实长会话（约 1M 窗口）的聚合观察，供验证时对照：

- 1540 条 assistant 消息中 462 条（约 30%）thinking 含上下文焦虑措辞；**其中 46% 发生在真实占用 <60% 时**
- 显式百分比声明 14 次，全部严重高估（声称 98% 时实际 6–29%；锚点来自压缩 summary 遗留的旧数字）
- 越接近满窗，模型越倾向"最后一次命令搞定"的仓促收尾，操作失误概率上升
- usage 结构：`input + cacheRead` ≈ 真实上下文；满窗附近偶发服务端限流
