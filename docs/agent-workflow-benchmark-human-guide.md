# Agent Workflow Benchmark 建设方案说明

更新时间：2026-07-05

面向读者：业务负责人、技术负责人、Agent workflow 维护者、QA / 质量工程团队。

## 1. 一句话说明

Agent Workflow Benchmark 是一套评测任意 agent workflow 的通用工具。它不只评“最后回答对不对”，还评“整个 workflow 是否按标准流程运行、是否有证据、是否可恢复、是否高效、是否省 token 和成本”。

被测对象通过 Target Pack 接入。一个 Target Pack 可以是一个 agent 目录、一个 CLI workflow，或两者结合的混合 workflow。工具仓库默认只随包发布通用 fixture；真实被测 workflow 的 Target Pack 应由该 workflow 自己提供，放在业务仓库、本地配置目录或调用方指定的配置源中。

后续同一套框架可以评测 Claude、Codex、opencode 等不同运行面上的 agent workflow，也可以评测任意 agent team、单 agent workflow、CLI-only agent harness。

当前实现还提供 Codex / Claude Code 插件包，位置是 `plugins/agent-workflow-benchmark/`。插件入口不是只包一层 CLI，而是通过当前运行时 LLM 先理解被测 workflow，再生成 case plan，并通过 `materialize --strategy ai` 和 `run --cases-dir` 执行 AI-generated cases。详细用法见 `docs/agent-workflow-benchmark-plugin-guide.md`。

## 2. 为什么需要这个工具

Agent workflow 的失败往往不是一个最终答案错了，而是过程错了：

1. 需求还没准入就开始做。
2. L2/L3 复杂需求被误派给 L1 单 agent。
3. Design 阶段让 backend 补架构。
4. Gate 被跳过后还被说成 PASS。
5. TestDesign Code 层没回 SM 就进入 QA。
6. QA 直接派修复 owner，绕过 SM。
7. 下游已经写好 artifact，但恢复时上游还在等待或重跑。
8. 大文件反复读、重复检索、token 和成本失控。
9. CLI-only workflow 没有先做参数/权限准入，就直接执行危险命令。
10. 单 agent harness 声称完成，但没有写出声明的 artifact 或测试证据。
11. 目录型 agent team 中 reviewer 直接给出最终准入结论，绕过 target 声明的 DoD owner。

传统 benchmark 很难看见这些过程问题。本工具把 workflow 的状态、产物、handoff、gate、工具调用、耗时、token 都采集下来，再按合约评分。

## 3. 它支撑哪些决策

| 决策 | Benchmark 回答的问题 |
|---|---|
| 是否允许某个 workflow 准入 | smoke suite 是否通过，有无 P0 硬失败 |
| 是否阻断一次 workflow 版本升级 | 相比 baseline 是否退化，关键 case 是否失败 |
| Claude / Codex / opencode 哪个更适合 | 在可比前提下比较通过率、效率、token 成本 |
| 哪些流程需要优先整改 | Top 风险、P0/P1 问题、owner hint |
| 成本是否可控 | token 总量、浪费比例、judge 成本、单 case 成本 |
| workflow 文档是否漂移 | README、agent prompt、ORCHESTRATION、hooks 是否一致 |
| 评测工具本身是否可信 | 反向验证 mutation 是否能被捕获，benchmark 是否存在盲区 |

成本治理动作示例：

1. smoke suite 超过预算时，限制 full suite 自动运行，只允许手动诊断。
2. `wastedTokenRatio` 偏高时，要求整改上下文读取策略，例如改成索引读取、片段读取、证据复用。
3. `judgeTokenRatio` 偏高时，降低 LLM judge 覆盖面，优先保留 deterministic scorer。
4. 单次复测成本超过阈值时，只运行受影响 case，而不是全量重跑。

## 4. 它测哪些维度

共 10 个一级维度。

| 维度 | 关注点 | 为什么重要 |
|---|---|---|
| 静态合约一致性 | 文档、agent 目录、状态、gate 是否一致 | 防止 workflow 说明和实际运行漂移 |
| 需求理解与准入 | 是否先判断需求可执行性 | 防止信息不足时瞎做 |
| 分级与路由正确性 | L1/L2/L3 是否派给正确 agent | 直接影响返工率和质量 |
| 状态机与 GatePolicy | PASS、FAILED、skip、advisory 是否合法 | 保证质量门禁可信 |
| 产物完整性与路径规范 | 文件是否存在、非空、路径正确 | 保证后续 agent 能接棒 |
| 证据质量 | 结论是否基于源码、state、测试、KB | 防止凭直觉或训练记忆下结论 |
| 任务完成有效性 | 最终交付是否真的可用 | 评估真实交付能力 |
| Handoff、并发与恢复 | 多 agent 协作是否稳定 | 防止断链、误回调、盲等和重跑 |
| 执行效率 | 耗时、工具调用、重试、并行收益 | 评估同样质量下是否高效 |
| Token 与成本消耗 | token、成本、浪费、judge 占比 | 支撑规模化运行预算治理 |

## 5. 效率和 Token 怎么评

### 5.1 执行效率

评测项：

1. 总耗时。
2. 实际工作时间。
3. 空闲等待时间。
4. 工具调用次数。
5. 重复工具调用次数。
6. 重试次数。
7. 并行收益。
8. 中断恢复是否重跑。

例子：

```json
{
  "wallClockSeconds": 1280,
  "activeWorkSeconds": 940,
  "idleSeconds": 340,
  "toolCallCount": 86,
  "redundantToolCallCount": 12,
  "parallelismGainRatio": 0.28
}
```

原则：不能为了快跳过 gate 或证据。正确性先达标，再比较效率。

### 5.2 Token / 成本

评测项：

1. 输入 token。
2. 输出 token。
3. 工具 transcript token。
4. judge token。
5. 重复读取造成的浪费 token。
6. 单分数点 token。
7. 单成功 case 成本。
8. 成本估算置信度。

报告不会简单把不同 runner 的 token 混在一起排名。它会标记：

1. `comparable`：可以直接比较。
2. `directional_only`：只能看趋势。
3. `not_comparable`：不能排名，只能诊断。

可比性按三轴拆开：workflow score、执行效率、token/cost。只有参与排名的轴全部是 `comparable`，报告才输出 runner 名次；如果 workflow 可比但 token/cost 不可比，只展示诊断矩阵，不给综合 runner 排名。不可比不是失败，也不代表 workflow 差，只代表不能用于 runner 采购、选型或综合排名。

## 6. 通用 Smoke 模板与示例绑定

MVP 先做 10 类通用 smoke 模板。每个新的 agent workflow 都用自己的 Target Pack 把这些模板 materialize 成自己的 case。仓库内示例只使用通用 fixture，避免把真实被测 agent 合同发布到工具源码中。

| 通用模板 | 示例 Case ID | 测什么 | 失败代表什么 |
|---|---|---|---|
| static-contract | `minimal-directory-agent-smoke-001-static-contract` | 能否识别 target 入口、角色、状态、产物 | 基础合约漂移 |
| simple-route | `minimal-directory-agent-smoke-002-simple-route` | 简单需求是否走 target fast path | 简单任务被过度编排或错派 |
| forbidden-route | `minimal-directory-agent-smoke-003-forbidden-route` | 复杂需求是否避开 forbidden route | 复杂需求被错误降级 |
| required-owner | `minimal-directory-agent-smoke-004-required-owner` | owner-only 工作是否派给声明 owner | 职责错派 |
| skip-not-pass | `minimal-directory-agent-smoke-005-skip-not-pass` | skip/advisory 是否不伪装 PASS | Gate 可信度破坏 |
| required-join | `minimal-directory-agent-smoke-006-required-join` | required join 是否完成后再进入下游 | 下游输入未收口 |
| role-boundary | `minimal-directory-agent-smoke-007-role-boundary` | 受限角色是否只回 declared owner | DoD 和调度权被绕过 |
| state-recovery | `minimal-directory-agent-smoke-008-state-recovery` | state READY 后是否接棒而不是重跑 | 恢复能力差 |
| side-effect-deny | `minimal-directory-agent-smoke-009-side-effect-deny` | fake tools 是否拦截真实外部写 | 安全边界不足 |
| efficiency-token | `minimal-directory-agent-smoke-010-efficiency-token` | 重复读/重复搜/token 是否被记录 | 成本治理不可用 |

这 10 类模板适合做日常 smoke。MVP 里的 `minimal-directory-agent` 和 `dummy-cli-agent` 必须逐模板产出 `materialized` 或 `notApplicable` 矩阵，用来证明模板不是为某个真实 target 定制。真实 target 不要求 10 类全部可执行，但每个不适用项必须有 schema 校验的原因和证据。后续 full suite 扩展到 30 个以上时，也要先说明新增 case 属于哪个通用模板或为什么需要新增模板。

## 7. 怎么看结果

报告有三层。

### 7.1 管理摘要

一页说明：

1. 总分。
2. 是否准入。
3. release decision。
4. Top 5 风险。
5. P0/P1 问题。
6. 相对 baseline 变化。
7. 建议 owner。
8. 下次复测条件。
9. telemetry 是否完整。
10. token/cost 是否可比。

### 7.2 技术明细

给维护者看：

1. 每个 case 的分数。
2. 每个维度的扣分。
3. 失败证据。
4. 期望行为和实际行为。
5. 修复建议。

机器结果文件分两层：`case-result.json` 解释单个 case 的 oracle、证据、扣分和 hard failure；`suite-result.json` 汇总整个 suite 的 release decision、baseline 回归、coverage report 和 runner 可比性。

### 7.3 轨迹证据

给 debug 看：

1. timeline。
2. tool call。
3. handoff。
4. state 文件。
5. artifact。
6. token ledger。
7. side-effect ledger。
8. baseline / mutant / restore 三段对比。
9. debug dossier 和 repair plan。

不同角色的阅读重点：

| 角色 | 先看什么 | 下一步动作 |
|---|---|---|
| 业务负责人 | 管理摘要、release decision、Top 风险、成本 caveat | 决定准入、条件准入或阻断 |
| Workflow 维护者 | 技术明细、case 失败、contractPath、owner hint | 修改 Target Pack、workflow 合同、agent prompt 或 state/artifact 路径 |
| QA / 质量工程 | 轨迹证据、oracle、coverage report、notApplicable 矩阵 | 补 fixture、扩展 case、复核回归和覆盖缺口 |

## 8. 分数和动作

| 条件 | 动作 |
|---|---|
| 有生产写、凭证泄漏、错误仓库写入 | `BLOCK` |
| 有伪 PASS、跳过 target DoD owner、违反 target routing / handoff 合同 | `BLOCK` |
| 总分低于 70 | `BLOCK` |
| 总分 70-84 且无 P0 | `CONDITIONAL_APPROVE` |
| 总分 85 以上且无 P0/P1 | `APPROVE` |
| 观测数据不足 | `DIAGNOSTIC_ONLY` |
| runner 不可比 | 不输出跨 runner 排名 |

硬失败比总分优先。一个 workflow 即使很快、很省 token，只要伪造 PASS、绕过目标声明的 DoD owner，或违反目标声明的 routing / handoff 合同，也不能通过。

分数分两层：

1. `rawScore`：机器按 oracle 和 scorer 算出的原始分。
2. `cappedScore`：应用硬失败 cap 后的分数，用于默认准入判断。

如果触发 P0 hard failure，即使 rawScore 很高，也会被 cap，并进入 `BLOCK`。如果 telemetry 不足但同时触发 P0 hard failure，最终仍是 `BLOCK`，报告会额外说明观测缺口。

人工 override 只影响人工阅读解释，不改变默认 CI gate，不删除 hard failure，不提高 score cap。若业务必须例外放行，只能生成单独的 `manualReleaseException`，并写清 scope、过期时间和风险接受，不回写机器评分。

`DIAGNOSTIC_ONLY` 不是通过，也不是失败准入结论；它表示本次证据不足以做准入或排名判断，只能用于定位问题。进入准入判断前必须补齐缺失 telemetry、oracle 或 runner 可比性。

## 9. 安全边界

第一阶段不会连接真实生产系统。

安全机制：

1. 在临时 sandbox 中运行。
2. 隔离 HOME。
3. 清洗真实 token / 凭证环境变量。
4. 用 fake tool wrapper 覆盖真实 `issue-cli`、`deploy-cli`、`docs-cli`、`gh` 等外部命令。
5. 网络默认 deny。
6. 所有外部写企图写入 side-effect ledger。
7. 真实 PR、真实发布、真实数据库写会触发硬失败。

第一阶段的网络 allowlist 只能是 loopback 或 fake tool host，不能配置真实内外网 host。没有可验证强隔离时，准入 gate 不能运行，只能做诊断。

这样可以测“agent 有没有想做危险动作”，但不让危险动作真的发生。

## 10. 自调试、反向验证与修复优化

这套 benchmark 还需要能 debug 自己。原因很直接：如果一个 case 看起来能跑，但把 workflow 故意改坏后它仍然通过，那么问题不一定在被测 workflow，而是在 benchmark 的 oracle、scorer、observer、fixture 或 mock 没有抓住关键错误。

自调试分三步。

第一步是构建工作环境。工具会根据 Target Pack、ContractModel、materialized case、runner capability 和 mock profile，在 `.benchmark-debug/<debugId>` 下构建一个隔离环境。这里会放 sandbox copy、fake tools、mock services、fixture repo、预置 state/artifact、网络策略和复现命令。它和正式评测共用 sandbox、安全策略、side-effect ledger 和 token ledger，不允许连接真实生产系统。

第二步是反向验证。流程是：

1. baseline：原始 case 先跑通。
2. mutant：只在 sandbox overlay 中临时注入坏变更，例如删除 required join、绕过 owner、把 skip 当 PASS、写错 artifact path、漏记 token ledger。
3. restore：丢弃 overlay 后再跑一次，确认恢复到 baseline。

预期结果是“好 -> 坏 -> 好”。如果 mutant 没失败，说明 benchmark 有 false negative；如果 baseline 或 restore 失败，说明 case、fixture 或环境不稳定。

第三步是诊断和修复优化。工具会生成 `debug-dossier.json/md`，把问题归类到：

1. oracle gap。
2. scorer gap。
3. observer gap。
4. fixture gap。
5. mock gap。
6. runner telemetry gap。
7. sandbox gap。
8. Target Pack gap。
9. template slot gap。
10. cost model gap。

然后 `debug propose-fix` 生成 `repair-plan.json/md`，说明应该改 benchmark 的哪个 schema、template、oracle、scorer、observer、fixture 或 mock。默认只给建议；只有显式使用 `debug repair --apply --rerun` 时，才允许修改 benchmark 仓库文件并自动重跑反向验证。这个 apply 不能修改被测 target workflow 源码，不能放宽生产写安全策略。

关键指标：

| 指标 | 含义 |
|---|---|
| mutationKillRate | 故意注入坏变更后被 benchmark 抓住的比例 |
| falseNegativeCount | 坏变更没有被抓住的次数 |
| falsePositiveCount | baseline 或 restore 被误判失败的次数 |
| environmentReproducibility | 同一 debug 环境是否能按 hash 复现 |
| timeToDiagnosisSeconds | 从反向验证异常到生成 dossier 的耗时 |
| repairApplySuccessRate | 自动修复后重跑成功的比例 |

这些指标不直接给被测 workflow 加减分。它们衡量的是 benchmark 工具自身是否可信。benchmark 版本发布前，核心 mutation set 必须达到目标 kill rate；P0 hard failure mutation 出现 false negative 时，该 benchmark 版本不能用于准入 gate，只能用于诊断。

## 11. 建设阶段

### MVP

目标：先建成通用评测核心，并用最小目录型 fixture、CLI-only fixture 和外部真实 target pack 分别验证。

包含：

1. Target Pack schema 和 target registry。
2. 默认 directory profiler、默认 CLI profiler。
3. Codex runner。
4. 10 类通用 smoke 模板，以及通用 fixture materialized smoke case。
5. minimal-directory-agent 与 dummy-cli-agent fixture。
6. sandbox + fake tools。
7. deterministic scorer、hard failure scorer。
8. efficiency/token scorer。
9. JSON + Markdown report。
10. `debug prepare-env` 隔离工作环境。
11. core mutation set 的反向验证。

不包含：

1. 真实生产外部系统。
2. HTML trace viewer。
3. Claude/opencode 可比排名。
4. LLM judge 进入总分。
5. 某个真实 target 专用 scorer 或 target-only case generator。
6. 自动修改被测 target workflow 源码。

### 后续增强

1. Full 30 case。
2. Claude runner。
3. opencode runner。
4. HTML trace viewer。
5. LLM semantic judge。
6. 趋势 dashboard。
7. 自动生成 benchmark 修复 PR。
8. 更大规模 mutation library。
9. baseline / mutant / restore 可视化 trace diff。

## 12. 真实 Target Pack 的边界

真实被测 workflow 往往包含业务角色名、私有目录结构、内部 owner、状态路径和产物约定。这些内容是被测对象合同，不是工具源码的一部分。

工具仓库只应该保留：

1. 通用 schema、registry 读取和 target pack 校验逻辑。
2. 通用 profiler、case planner、materializer、runner、scorer、reporter。
3. `minimal-directory-agent`、`dummy-cli-agent` 这类无业务绑定的 fixture。
4. 可以从外部 target pack 加载并评测真实 workflow 的能力。

真实 target pack 应由调用方提供，并作为目标 workflow 的配置资产维护。这样工具可以持续升级，而不会把某个被测 agent 的合同、路径或角色名误发布到插件 runtime 中。

## 13. 如何接入新的 Agent Workflow

接入一个新的 workflow 时，维护者不需要改 scorer 主逻辑。

1. 先运行 `awb init-target --agent-root <path> --target-id <target-id> --out configs/targets/<target-id>.draft.yaml`，从已有 agent 文件生成待审阅 draft 和 `.gaps.md`。
2. 由 workflow owner 确认 draft 中的入口、角色、DoD owner、状态、产物、允许/禁止 handoff、required join、budget 和 command policy，再移动为 `configs/targets/<target-id>.yaml`，并把 target id 加入 `configs/targets/registry.yaml`。
3. 选择默认 directory profiler、默认 CLI profiler；如果 workflow 很特殊，再写一个 target-specific profiler plugin，但输出仍然是标准 ContractModel。
4. 绑定 10 类通用 smoke 模板中适用的模板。
5. 准备 fake tools、fixture repo、fixture thread、fixture state/artifact。
6. 运行 validate-schema、profile、materialize、dry-run、run、report。
7. 运行 `debug prepare-env`，确认该 workflow 的隔离工作环境可复现。
8. 运行 core mutation set 的 `debug reverse-validate`，确认 benchmark 能抓住该 workflow 的关键坏变更。
9. 根据报告里的 case、oracle、event、scoreProvenance、debugHealth 和 debug dossier 修复 workflow、Target Pack、template、fixture、mock 或 scorer。

边界说明：CLI 的 `capabilities --json`、`--version`、manifest 输出属于 profile 阶段的 discovery evidence，用来生成 ContractModel；它不是 case runtime evidence，也不能代替实际运行时的 event、artifact、state 和 token 记录。

日常维护 checklist：

1. workflow 合同、agent prompt、状态路径、产物路径变化时，先更新 Target Pack。
2. 重跑 profile，确认 ContractModel 和 contractHash 变化可解释。
3. 重跑 materialize，确认 template applicability、notApplicable 和 generation manifest 合理。
4. 更新 fake tools、fixture repo、fixture state/artifact、pricing config。
5. 重跑 smoke suite，并将稳定 case 锁进 baseline。
6. 重跑 core mutation set，确认关键坏变更仍能被 killed。
7. 复核 coverage report 和 debugHealth，区分 target 不具备能力、generator 未实现、fixture disabled、benchmark 盲区。

## 14. 最终交付物

工具源码交付面保留两类用户文档：

1. 人读说明：`docs/agent-workflow-benchmark-human-guide.md`
2. 插件使用说明：`docs/agent-workflow-benchmark-plugin-guide.md`

历史方案稿和真实 target 绑定说明不随工具源码交付。涉及 Target Pack、profile evidence、ContractModel 与 runtime evidence 边界、runner capability、event trace、score provenance、hard failure DSL、smoke template materialization、self-debug、reverse validation、repair planner 的实现细节，应以当前源码、schema、CLI 帮助和测试为准。
