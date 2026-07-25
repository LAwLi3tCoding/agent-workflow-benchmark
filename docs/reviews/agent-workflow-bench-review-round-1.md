# Agent Workflow Bench 方案评审记录 Round 1

评审日期：2026-07-05

被评审草案：历史技术草案。

## 评审结论汇总

第一轮共 5 个独立视角，全部给出 `NEEDS_CHANGES`。结论不是方向错误，而是草案仍偏架构说明，尚未达到“可直接交给 Codex 实现”的任务书标准。

| 视角 | Verdict | 主要阻塞 |
|---|---|---|
| 业务价值 / 产品 | `NEEDS_CHANGES` | 缺少管理决策映射、准入门槛、一页摘要、MVP 边界 |
| 系统架构 | `NEEDS_CHANGES` | 缺少 lane/handoff 一等事件、case schema 不足、source profile 与 runtime evidence 边界不清 |
| 测试工程 | `NEEDS_CHANGES` | 维度未落到 scorer、oracle 类型不足、LLM judge 边界不硬、稳定性控制不足 |
| 运行器 / 观测 / 成本 | `NEEDS_CHANGES` | runner capability 太薄、trace causality 不足、token ledger 不清、跨 runner 可比性缺失 |
| 实现落地 / 安全 | `NEEDS_CHANGES` | P0-P5 缺 CLI/文件/测试清单，sandbox/fake tools 安全机制不足，硬失败不可执行 |

## 必须修改项与处理策略

### 1. 从架构说明升级为可执行任务书

处理策略：

- 最终实现版方案必须指定技术栈、目录、文件清单、CLI、测试命令、每阶段 DoD。
- P0-P5 每阶段写清：新增文件、命令、测试、验收 artifact、停止条件。
- 明确当前工作区不是 git repo，后续实现如果需要版本控制需单独初始化或由用户指定。

### 2. 增加业务决策与管理动作

处理策略：

- 增加“benchmark 支撑的决策”：workflow 准入、版本回归阻断、runner 对比、成本治理、整改优先级。
- 增加分数到动作映射，例如 `APPROVE`、`CONDITIONAL`、`BLOCK`、`DIAGNOSTIC_ONLY`。
- `report.md` 增加一页管理摘要：准入结论、Top 风险、P0/P1、baseline delta、owner、复测条件。

### 3. 将 10 个维度落成可执行 scorer

处理策略：

- 每个维度补 `observable -> scorer -> pass/partial/fail -> evidence` 表。
- 明确硬失败映射。
- result 中保存 scorer version、confidence、evidence。

### 4. 扩展 oracle 体系

处理策略：

- 定义 event oracle、state oracle、artifact oracle、diff/test oracle、semantic oracle、negative oracle、efficiency oracle、token oracle。
- case materialize 后锁定 `caseHash`、`oracleVersion`、`targetHash`、`generatorVersion`。
- 动态生成不是每次即时随机生成；必须先 materialize，再进入可比运行。

### 5. 固化 deterministic scorer 与 LLM judge 边界

处理策略：

- LLM judge 不得覆盖：gate status、handoff、路径、枚举、文件存在性、测试结果、生产写风险、硬失败。
- LLM judge 只能对摘要质量、风险解释、需求理解等 semantic rubric 打分。
- LLM judge 必须引用 deterministic evidence，且保存 prompt hash、model、temperature、confidence。

### 6. 加强 lane/handoff 事件模型

处理策略：

- event schema 增加 `traceId`、`parentSpanId`、`runAttemptId`、`actor`、`lane`、`laneRole`、`callbackMode`、`mention`、`dispatchedAgentMentions`、receipt/wait signal。
- handoff/sidecar/callback 成为一等事件，不能只作为普通 message。
- 复杂目录型 workflow 的评审 sidecar 和 join 用 case schema 明确表达。

### 7. 增强 runner capability 与 telemetry

处理策略：

- runner adapter 必须声明 capabilities、telemetry availability、limits、exitStatus、sandbox mode、token source。
- 报告将 runner 比较标为 `comparable`、`directional_only`、`not_comparable`。
- 不允许在 telemetry 不完整时给误导性跨 runner 排名。

### 8. 修正 token/cost ledger

处理策略：

- 区分 `observedNative`、`normalizedEstimate`、`billingEstimate`。
- 明确 tool/judge token 是 included bucket 还是 separate bucket，避免总数不一致。
- 保存 tokenizer name/version、confidence、pricing effective date、currency、cached-token pricing。

### 9. 强化 sandbox/fake tools 安全机制

处理策略：

- fake tools 通过 sandbox-local `PATH` wrapper 覆盖真实命令。
- 清洗凭证环境变量，隔离 HOME。
- 网络默认 deny，必要时 allowlist。
- 生产域名、真实 PR/发布/数据库写命令触发安全硬失败。
- side-effect ledger 记录所有外部副作用企图。

### 10. 明确首批 smoke case 与硬失败覆盖

处理策略：

- 首批 10 个 smoke case 必须覆盖：入口、复杂度路由、GatePolicy、`BYPASSED_BY_CONFIG`、测试设计 sidecar/join、回调到声明 owner、state 恢复、生产写拦截、效率/token。
- P0 硬失败逐一映射 case。

### 11. 稳定性与趋势可比

处理策略：

- 固定 seed、case materialization、baseline lock、runner fingerprint、environment fingerprint。
- 增加 flaky quarantine 与重复运行方差阈值。
- 固定核心用例集用于跨版本趋势，动态扩展用例只用于诊断或新合约覆盖。

## 第二轮评审目标

第二轮不再评审初版草案，只评审当前交付文档：

1. `docs/agent-workflow-bench-human-guide.md`
2. `docs/agent-workflow-bench-plugin-guide.md`

第二轮通过标准：

- 没有 `Required changes`。
- Verdict 为 `NO_BLOCKING_SUGGESTIONS`。
- 若仍有建议，必须是非阻塞增强项，且最终文档已记录为后续 backlog 或明确拒绝原因。
