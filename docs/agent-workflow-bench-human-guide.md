# Agent Workflow Bench 建设方案说明

更新时间：2026-07-05

面向读者：业务负责人、技术负责人、Agent workflow 维护者、QA / 质量工程团队。

## 1. 一句话说明

Agent Workflow Bench（AWB）是一套评测任意 coding-agent workflow 的 CI 级回归测试工具。它不只评“最后回答对不对”，还评“整个 workflow 是否按标准流程运行、是否有证据、是否可恢复、是否高效、是否省 token 和成本”。CLI 为 `awb`，插件名、Skill、command 和 repo slug 统一为 `agent-workflow-bench`；`benchmark` 与 `evaluate` 命令继续可用。

被测对象通过 Target Pack 接入。一个 Target Pack 可以是一个 agent 目录、一个 CLI workflow，或两者结合的混合 workflow。工具仓库默认只随包发布通用 fixture；真实被测 workflow 的 Target Pack 应由该 workflow 自己提供，放在业务仓库、本地配置目录或调用方指定的配置源中。

后续同一套框架可以评测 Claude、Codex、opencode 等不同运行面上的 agent workflow，也可以评测任意 agent team、单 agent workflow、CLI-only agent harness。

当前实现还提供 Codex / Claude Code 插件包，位置是 `plugins/agent-workflow-bench/`。插件入口不是只包一层 CLI，而是通过当前运行时 LLM 先理解被测 workflow，再生成 case plan，并通过 `materialize --strategy ai` 和 `run --cases-dir` 执行 AI-generated cases。详细用法见 `docs/agent-workflow-bench-plugin-guide.md`。

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
| 是否允许某个 workflow 准入 | matched baseline/candidate 是否可比，CI gate 是否 PASS |
| 是否阻断一次 workflow 版本升级 | 相比 baseline 是否退化，关键 case 是否失败 |
| Claude / Codex / opencode 哪个更适合 | 只有 exact task、Case、已认证 Observer、budget、Telemetry 和所有轴都可比时才排名 |
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

跨 runner 排名使用独立命令：

```bash
awb report runner-ranking \
  --input reports/ranking/runner-ranking-input.json \
  --out reports/ranking/current
```

该命令要求每个 runner 绑定完全相同的 task、Target Contract、Case Set、已认证
Observer 资格制品、预算、live `workflow_trace` Telemetry 形态和 native token source。
workflow score、efficiency、tokenCost 三轴都必须是 `comparable`。任一绑定不同、
Observer 未认证、Telemetry 不同、token 不是 native，或任一轴为 directional-only /
incomparable 时，输出 `INCOMPARABLE` 和 reason codes，不给 runner 名次。

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

### 7.4 Stage 9 报告与趋势

Stage 9 保留旧的 `awb report --run <run-dir> --format md,json`，并新增四个
只读报告命令：

```bash
awb report decision --comparison <comparison-result.json> --gate-result <gate-result.json> --out <decision-dir>
awb report trace-diff --mode baseline-candidate --baseline <baseline-workflow-trace.json> --candidate <candidate-workflow-trace.json> --out <trace-diff-dir>
awb report trend --input <trend-input.json> --out <trend-dir>
awb report viewer --decision <decision-report.json> --comparison <comparison-result.json> --trace-diff <trace-diff.json> --trend <trend-report.json> --out <viewer-dir>
```

`decision` 会重新校验 comparison bundle，并用同一 gate policy 重新计算 gate；传入
`--reliability` 或 `--validity` 时只读取已有统计，不会凭空推断人工 truth。
`trace-diff` 只有在所有 trace 都带可信 Observer 公钥、资格公钥和有效资格制品时才标记
`verified_live`，否则只是 diagnostic；输出只含 event ref、payload hash 和 actor hash。
`trend` 遇到 schema、policy、runner、conditions、contract、target、suite 或
observation level 变化时会切分 era，不跨不可比边界连线。`viewer` 只读取已脱敏公共制品，
输出静态只读 HTML 和 manifest，不加载远程资源、不执行命令、不改 gate、不读未脱敏 trace。
详细示例见 `docs/reporting-and-trends.md`。

## 8. 分数、比较和 Gate 动作

推荐准入流程：

1. `awb doctor --target <target-id> --runner <runner> --out <doctor-dir>`：profile target、检查 runner 能力并说明 evidence 上限。
2. matched baseline / candidate run：使用同一 target、suite、runner mode 和 contract hash。普通 `run --execution live` 仍是 `contract_summary`；独立 Observer 先通过 `awb observer qualify` 生成资格制品，再由 `ingest-trace` 同时校验轨迹与资格制品。
3. `awb compare --baseline <baseline-run> --candidate <candidate-run> --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <comparison-dir>`：比较回归、证据缺口和 hard failure。
4. `awb gate --comparison <comparison-dir>/comparison-result.json --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <gate-dir>`：输出 CI gate 结论，并重新验证两个签名信任链。

`compare` 产物包含 baseline/candidate 的最小证据快照及完整性哈希。`gate` 在判定前会重新校验快照并重新计算 comparison；被编辑的 comparison JSON 或证据文件会直接阻断。

Gate exit code 固定为：

| Gate 结论 | Exit code | 含义 |
|---|---:|---|
| `PASS` | 0 | 有已通过资格认证的独立 live `workflow_trace`，candidate 相比 baseline 未触发阻断回归 |
| `DIAGNOSTIC_ONLY` | 2 | 证据不足、Observer 未认证、runner 不可比，或只使用 simulated / current `contract-summary` adapter |
| `BLOCK` | 1 | 触发 P0/hard failure、关键回归，或工具/runtime 失败 |

只有经过独立资格认证的 live Observer 输出真实 `workflow_trace` evidence 时，gate 才能 PASS。Observer 与资格授权方分别用 Ed25519 签名轨迹和资格制品；`ingest-trace`、`compare` 和 `gate` 必须显式接收两个公钥。私钥不能提供给 Runner、仓库、制品或日志，也不能作为 CLI trust anchor。没有有效资格制品时 `qualificationStatus` 保持 `missing`；可编辑元数据里自报的 `valid` 会被忽略。simulated run 和内置 live `contract-summary` adapter 同样不能给 CI 准入 PASS。

内置 reference Observer 当前依赖 Darwin 的
`/usr/bin/sandbox-exec`。它在 deny-default Seatbelt 中实际执行私钥读取、
直连网络和嵌套子进程 canary，并要求全部返回 `EPERM`；静态策略声明不算
观测证据。隔离后端不可用或两类签名复用同一密钥时，资格认证直接失败。

签名证明 observer 身份和轨迹在签名后未被修改，不证明 observer 本身没有漏观测。将某个 observer 公钥加入 CI 之前，仍需用已知好/坏轨迹、mutation 和隔离检查验证 observer 实现。

| 条件 | 动作 |
|---|---|
| 有生产写、凭证泄漏、错误仓库写入 | `BLOCK` |
| 有伪 PASS、跳过 target DoD owner、违反 target routing / handoff 合同 | `BLOCK` |
| 总分低于 70 | `BLOCK` |
| 总分 70-84 且无 P0 | `DIAGNOSTIC_ONLY`，需要人工确认或补充证据 |
| 总分 85 以上且无 P0/P1，但缺少可信 live `workflow_trace` | `DIAGNOSTIC_ONLY` |
| 总分 85 以上且无 P0/P1，并有已认证独立 live `workflow_trace` | `PASS` |
| 观测数据不足 | `DIAGNOSTIC_ONLY` |
| runner 不可比 | 不输出跨 runner 排名 |

硬失败比总分优先。一个 workflow 即使很快、很省 token，只要伪造 PASS、绕过目标声明的 DoD owner，或违反目标声明的 routing / handoff 合同，也不能通过。

分数分两层：

1. `rawScore`：机器按 oracle 和 scorer 算出的原始分。
2. `cappedScore`：应用硬失败 cap 后的分数，用于默认准入判断。

如果触发 P0 hard failure，即使 rawScore 很高，也会被 cap，并进入 `BLOCK`。如果 telemetry 不足但同时触发 P0 hard failure，最终仍是 `BLOCK`，报告会额外说明观测缺口。

## 9. Schema 和历史制品迁移

AWB 的机器制品由 `schemas/*.schema.json`、`configs/artifacts/schema-registry.json` 和 `configs/artifacts/compatibility-matrix.json` 共同约束。当前正式 schema 覆盖 `ContractModel`、profile evidence、generation manifest、runtime manifest、Observer qualification、reliability report、validity report、suite、comparison、gate 和 provenance。

历史制品复用前先运行：

```bash
awb artifact migrate --input <artifact.json> --out reports/artifact-migration
```

如果文件名不是标准名称，补充 `--artifact-type <type>`。命令固定写出 `migration-result.json`；可安全迁移时再写出 `migrated-artifact.json`。退出码为：`0` 表示 `CURRENT` 或 `MIGRATED`，`2` 表示 `DIAGNOSTIC_ONLY`，`1` 表示 `INCOMPATIBLE`。

迁移不会发明信任字段。缺少 Observer attestation、policy hash、integrity hash、provenance binding、runtime identity 或 conditions identity 的旧制品，只能作为诊断证据，不能让 gate PASS，也不能证明生产阻断可用。详细规则见 `docs/artifact-schema-compatibility.md`。

人工 override 只影响人工阅读解释，不改变默认 CI gate，不删除 hard failure，不提高 score cap。若业务必须例外放行，只能生成单独的 `manualReleaseException`，并写清 scope、过期时间和风险接受，不回写机器评分。

`DIAGNOSTIC_ONLY` 不是通过，也不是失败准入结论；它表示本次证据不足以做准入或排名判断，只能用于定位问题。进入准入判断前必须补齐缺失 telemetry、oracle 或 runner 可比性。

Stage 10 新增 Adapter 合约和 conformance 诊断。OpenCode 内置 Adapter 的真实命令形态是：

```bash
opencode run --format json --dir <sandbox-root>
```

可选 `--model <provider/model>`，但不会附加 `--auto`、`--yolo`、
`--dangerously-skip-permissions` 或等价的自动授权参数。Adapter 合约声明稳定错误码、
runner 生命周期事件、证据上限、native token evidence，以及禁用自动 trust enrollment、
自动 workflow 修改、自动 fix PR 和 Runner 读取 Observer 私钥。

运行 conformance：

```bash
awb adapter conformance \
  --adapter opencode \
  --target minimal-directory-agent \
  --adapter-executable "$(command -v opencode)" \
  --out reports/adapters/opencode
```

`adapter-conformance-report.json` 的 `decision: PASS` 只说明 Adapter 合约和输出的
`CaseRun` 能被 AWB scorer 接受。该报告固定 `releaseDisposition: DIAGNOSTIC_ONLY`，
不能给 workflow gate PASS。OpenCode JSON 输出缺少 native assistant token、超过证据
上限、JSONL 无效、事件顺序错误、输出含需脱敏私密数据或执行失败时，会给出稳定
Adapter reason code。完整字段见 `docs/adapter-sdk.md`。

Gate 使用版本化 `gate-policy.json`。`suite-result.json`、`comparison-result.json` 和
`gate-result.json` 都记录 `policyId`、`policyVersion`、`rulesHash`、`policyHash`。
重新计算历史结果时，`compare` 和 `gate` 都可以显式传入同一策略：

```bash
awb compare --baseline <baseline-run> --candidate <candidate-run> --gate-policy <gate-policy.json> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --gate-policy <gate-policy.json> --out <gate-dir>
```

缺少策略绑定，或 version、rules hash、policy hash 不一致时，结果会被标记为不可比较，
不能把不同规则下的结果放在一起排名或画趋势。策略规则变化必须提升 `policyVersion`；
同一版本下偷改规则会被拒绝。

策略校准分两步。第一步只读取 Gold Corpus 的 development/calibration split：

```bash
awb gate-policy calibrate --corpus fixtures/gold-corpus/v1/manifest.yaml --policy-version 1.0.0 --out reports/gate-policy/v1/fit
```

该命令返回 `2`，因为报告状态是 `PENDING_HOLDOUT`。如果所有 candidate 都无法
同时保持 P0 recall 为 `1`、false PASS 为 `0`，则返回 `1` 且不生成策略。第二步
才加载未见过的 holdout：

```bash
awb gate-policy validate-holdout --corpus fixtures/gold-corpus/v1/manifest.yaml --policy reports/gate-policy/v1/fit/gate-policy.json --calibration-report reports/gate-policy/v1/fit/calibration-report.json --out reports/gate-policy/v1/holdout
```

holdout PASS 返回 `0`，FAIL 返回 `1`。报告展示维度 evidence、safe/risk 均分、
paired effect、bootstrap interval、telemetry/budget 支持度、candidate selection 和
policy hash，而不是只给一个总分。公共 Gold Corpus 是 synthetic harness 诊断，报告
`releaseEligible: false`；即使 holdout PASS，也不能替代真实 target 的 owner review、
独立 live trace、双人盲审标签、adjudication 和生产阻断授权。
报告中的 stability 明确限定为完整 synthetic harness 的确定性重放，不代表 live
Runner 或 Observer 的稳定性；后者必须由 reliability study 证明。

已提交的公共 synthetic 证据在
`fixtures/calibration/v1/fit/{gate-policy.json,calibration-report.json,calibration-report.md}`
和 `fixtures/calibration/v1/holdout/{calibration-report.json,calibration-report.md}`。

## 9. 安全边界

当前可验证的安全边界是：

1. simulated fixture 不调用外部 Agent 或真实外部工具。
2. `debug prepare-env` 只创建 target copy、fake wrapper 文件、mock service 描述和复现元数据；它不会自动启动 runner，也不会自动修改 `PATH`。
3. `networkPolicyHash` 和 `production-network-deny` preflight 只描述期望策略，状态为 `DIAGNOSTIC_ONLY`，不代表已经强制阻断网络。
4. Codex live runner 请求 read-only sandbox 和 no-approval；Claude live runner 使用 Claude CLI 默认权限。两者当前都只产生 contract-summary 诊断证据。
5. 没有可验证强隔离时，Gate 不能 PASS；不可信 Target 不得配置生产凭证或生产服务。

当前 core 不会自动隔离 HOME、清洗调用方进程的全部凭证环境变量、强制 fake-only
`PATH`、执行 OS 级 network deny 或捕获 side-effect ledger。需要这些能力时，应由 CI
容器/沙箱或可信 runner adapter 明确实施并提供可验证证据，不能把 debug scaffold
当成安全沙箱。

## 10. 自调试、反向验证与修复优化

这套 benchmark 还需要能 debug 自己。原因很直接：如果一个 case 看起来能跑，但把 workflow 故意改坏后它仍然通过，那么问题不一定在被测 workflow，而是在 benchmark 的 oracle、scorer、observer、fixture 或 mock 没有抓住关键错误。

自调试分三步。

第一步是构建可复现的 debug scaffold。工具会根据 Target Pack、ContractModel、materialized case、runner capability 和 mock profile，在 `.benchmark-debug/<debugId>` 下写入 target copy、fake wrapper 文件、mock service 描述、fixture repo、预置 state/artifact、声明式网络策略和复现命令。该命令本身不执行 Agent，也不强制 HOME、环境变量、PATH 或网络隔离；这些控制必须由外层 CI 沙箱或可信 runner adapter 实施。

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

周期性 benchmark health 用来给 AWB 版本本身做 fail-closed 处置：

```bash
awb ci benchmark-health \
  --input health/benchmark-health-input.json \
  --out reports/health/current
```

输入绑定 Gold Corpus、P0 mutation、Observer qualification、A/A reliability、
schema compatibility、plugin install 和 privacy scan 的 evidence ref 与 SHA-256 hash。
只要出现 P0 false negative、false PASS、Observer 无效、schema incompatible、缺检查、
plugin install 失败、privacy finding 或 reliability 失败，报告自动把
`versionDisposition` 设为 `DIAGNOSTIC_ONLY`。该命令不会自动登记信任根、修改 workflow
或创建修复 PR，报告中会把这些 automatic actions 标记为 disabled。完整字段见
`docs/benchmark-health.md`。

重复运行的可靠性使用独立的 `reliability-study.json`，每个 sample 都声明匹配的
baseline/candidate 相对路径和固定 seed，然后执行
`awb debug reliability --study <study.json> --out <dir>`。报告保留全部请求过的
attempt，并给出 gate/case 一致性、A/A unchanged rate、维度方差、paired delta、
missing rate、telemetry completeness、Wilson/bootstrap 区间、P0 detection rate、
固定上下文漂移和重复证据数量。低于冻结样本数、出现缺失或 summary-only evidence
时拒绝 strong conclusion；不稳定 case、上下文漂移或重复 evidence 进入 quarantine，
不能靠删除失败样本恢复通过。每次运行的 attempt identity 同时绑定 runtime manifest
与 provenance，报告只暴露其哈希；重复 identity 会被 quarantine。Live identity 从
签名 trace hash 派生，simulated replay 检测仅用于诊断。即使 deterministic simulated
study 达到 100%，结论也只是 `DIAGNOSTIC_REPRODUCIBLE`，并保持
`strongConclusionAllowed: false` 与 `DIAGNOSTIC_ONLY`；只有稳定且已认证的独立
live `workflow_trace` study 才能成为
gate-eligible evidence。

外部效度使用独立的 `criterion-validity` 流程，不复用 gold corpus 或 reliability
结论。Stage 5 已实现打包和分析机制，但仓库内只提供
`fixtures/external-validity/v1/study.yaml` 这个 8 条样本的隐私安全模板；它不是生产
外部效度证据。真实研究必须覆盖 directory、CLI、hybrid 三类 target，Codex、Claude
两个 runner，以及 known improvement、no change、ordinary regression、P0 regression
四类设计分层。冻结样本量是 24 个 cell 每格 5 条，共 120 条。

先生成盲审包，再在补齐外部观测和人工标签后分析：

```bash
awb criterion-validity package --study <study.yaml> --out <dir>
awb criterion-validity analyze --study <study.yaml> --observations <observations.json> --labels <human-labels.json> --trusted-observer-key <observer-public.pem> --trusted-qualification-key <qualification-authority-public.pem> --out <dir>
```

盲审包不能暴露真实 target 名称、runner 身份、设计分层、私有路径、内部链接或业务数据。
每条样本需要 owner-reviewed 外部合同、已认证独立 live `workflow_trace` 观测、两名独立
评审的 blinded label，以及冲突样本的 adjudication。`observations.json` 只记录
comparison bundle 的引用和内容哈希；分析时会用显式公钥重新验签两侧 trace、Observer
资格和 comparison 完整性，自报 `VALID` 字段不能建立 PASS。准入阈值是 P0 recall 100%、
false PASS 0、overall agreement 至少 0.85、Cohen kappa 至少 0.8。缺 owner review、
缺标签、样本不足、summary-only evidence、未认证 trace、冲突未裁决或私有数据泄漏时，
结果只能是 `PENDING_HUMAN_INPUT`、`INSUFFICIENT_EVIDENCE` 或 `FAIL`，不能作为生产
CI 准入 PASS。

## 11. 建设阶段

### MVP

目标：先建成通用评测核心，并用最小目录型 fixture、CLI-only fixture 和外部真实 target pack 分别验证。

包含：

1. Target Pack schema 和 target registry。
2. 默认 directory profiler、默认 CLI profiler。
3. Codex runner。
4. 10 类通用 smoke 模板，以及通用 fixture materialized smoke case。
5. minimal-directory-agent 与 dummy-cli-agent fixture。
6. 声明式 debug scaffold + fake wrapper 文件。
7. deterministic scorer、hard failure scorer。
8. efficiency/token scorer。
9. JSON + Markdown report。
10. `debug prepare-env` 可复现环境描述。
11. core mutation set 的反向验证。

不包含：

1. 真实生产外部系统。
2. Claude/opencode 可比排名。
3. LLM judge 进入总分。
4. 某个真实 target 专用 scorer 或 target-only case generator。
5. 自动修改被测 target workflow 源码。

### 后续增强

1. Full 30 case。
2. Claude runner。
3. 更多 runner / Observer Adapter。
4. LLM semantic judge。
5. 自动生成 benchmark 修复 PR（当前禁用）。
6. 更大规模 mutation library。
7. 更大规模外部效度研究。

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
2. 由 workflow owner 确认 draft 中的入口、角色、DoD owner、状态、产物、允许/禁止 handoff、required join、budget 和 command policy，生成绑定最终 `contractHash` 的 `contract-validity` artifact，并把 artifact hash 写入 `contractReview`。只有 `status: reviewed` 且两个 hash 都校验通过的 Target Pack 才能加入 registry。
3. 选择默认 directory profiler、默认 CLI profiler；如果 workflow 很特殊，再写一个 target-specific profiler plugin，但输出仍然是标准 ContractModel。
4. 绑定 10 类通用 smoke 模板中适用的模板。
5. 准备 fake tools、fixture repo、fixture thread、fixture state/artifact。
6. 运行 validate-schema、profile、materialize、dry-run、run、report。
7. 运行 `debug prepare-env`，确认该 workflow 的 debug fixture 与环境描述可复现；不要把它当成已强制执行的安全沙箱。
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

1. 人读说明：`docs/agent-workflow-bench-human-guide.md`
2. 插件使用说明：`docs/agent-workflow-bench-plugin-guide.md`

历史方案稿和真实 target 绑定说明不随工具源码交付。涉及 Target Pack、profile evidence、ContractModel 与 runtime evidence 边界、runner capability、event trace、score provenance、hard failure DSL、smoke template materialization、self-debug、reverse validation、repair planner 的实现细节，应以当前源码、schema、CLI 帮助和测试为准。
