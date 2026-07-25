# Agent Workflow Bench 通用化十轮评审记录

更新时间：2026-07-05

评审目标：确认 Agent Workflow Bench 是通用测评能力，不是某个真实 target 的专用工具；真实 Target Pack 只作为外部验证输入。

评审对象：

1. `docs/agent-workflow-bench-human-guide.md`
2. `docs/agent-workflow-bench-plugin-guide.md`

评审规则：

1. 每轮使用不同业务或技术视角。
2. Required changes 必须修正文档。
3. Recommended improvements 若不进入本轮修正，必须说明进入 backlog 的原因。
4. 若无阻塞建议，记录 `NO_BLOCKING_SUGGESTIONS`。
5. 十轮结束后进行最终一致性检查。

## Round 1 - 通用产品范围 / 产品边界

评审者：analyst 子 agent

Verdict：`NO_BLOCKING_SUGGESTIONS`

Required changes：无。

Recommended improvements：

1. 人读说明第 2 节失败示例偏复杂目录型 team 语境，建议补充 CLI-only、单 agent harness、目录型 agent team 的通用示例。
2. 人读说明第 6 节只有 real-target instance column，建议补充 dummy target 也必须 materialize 最小模板集。
3. 技术方案第 16.2 节建议强调 target-specific binding 不得进入 generic template YAML。

已修正：

1. 在人读说明第 2 节增加 CLI-only 准入、单 agent artifact 缺失、目录型 team owner bypass 示例。
2. 在人读说明第 6 节说明 `minimal-directory-agent` 与 `dummy-cli-agent` 也必须 materialize 最小模板集。
3. 在技术方案第 16.2 节增加 target-specific binding 只能存在于 real target target config / materialized cases / profiler plugin / fixtures 的约束。

Generic scope risk：2/5。

## Round 2 - Target Pack Abstraction / 系统架构

评审者：architect 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. 第 7 节把 Source Profile 定义为“只来自源文件”，但 CLI target 的 profileCommand / capabilities 输出既不是源文件也不是 runtime evidence，导致 CLI-only target 边界不清。
2. ContractModel 被要求作为 profiler 输出，但没有定义 schema，容易让 real-target sample profiler 成为事实标准。
3. Target Pack YAML 仍偏目录型，只给单一 root 与 default entrypoint，CLI/hybrid discovery、execution、permission、provenance 元数据不足。

已修正：

1. 将第 7 节改为四层边界：Target Pack、Profile Evidence、ContractModel、Runtime Evidence。
2. 将 profile 阶段证据拆成 declared source evidence 与 CLI discovery evidence，并明确 CLI discovery 不是 runtime evidence。
3. 增加 `ProfileEvidenceRef` provenance contract。
4. 增加 ContractModel TypeScript 结构、字段生产/消费边界表、profiler plugin 合同。
5. 扩展 Target Pack YAML：`roots`、多个 entrypoints、`profile.sourceScan`、`profile.cliDiscovery`、profile/runtime permissions、mergePolicy。
6. 增加 CLI-only 与 hybrid Target Pack 示例。
7. 在 P0/P1 验收中加入 `profile-evidence.schema.json`、`contract-model.schema.json` 和 golden fixture。
8. 在人读说明中补充 CLI discovery evidence 的边界说明。

Recommended improvements：已全部采纳。

Abstraction risk：修正前 4/5，修正后待后续架构/critic 轮次复核。

## Round 3 - 通用 Case Generation / Oracle 设计

评审者：test-engineer 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. dummy target 只要求覆盖 3 类模板，不能证明 10 类模板不是 target-only。
2. `caseBindings` / `templateBindings` 没有模板参数 slot 定义，case generator 仍可能写死 target-specific prompt、target-specific artifact、target-specific role。
3. case 示例里的 negative oracle 使用自然语言表达式，缺少统一可执行 DSL。
4. dynamic generated case 缺少生成约束、覆盖目标、去重、失败收缩规则。
5. hard failure 覆盖表主要映射 real-target case，generic materialization fixture 不足。

已修正：

1. 增加 `TemplateSpec` schema，声明 required binding slots：owner、route、status、join、state、artifact、fixture、budget 等。
2. Target Pack `caseBindings` 增加 `slots` 示例，materializer 必须把 slot 解析成 ContractModel 字段。
3. Materialized case schema 增加 `generationManifest`：templateVersion、contractHash、seed、coverageGoal、bindingSlotValues、promptFamily、negativeVariant、dedupeHash、maxAttempts、discardReasons。
4. Oracle 改为统一 DSL，包含 `oracleId`、`type`、`mode`、`strength`、`scope`、`inputEvents`、`expectedEvidenceRefs`、`when`、`failureExplanationTemplate`、`reportFields`。
5. 增加 template applicability matrix，other target 对每个模板输出 `materialized | notApplicable`。
6. P0 hard failure 验收要求同时包含 real target 与generic materialization fixture。
7. P5 验收升级为逐模板适用性矩阵和 coverage report。
8. 增加 `template-spec.schema.json`、`generation-manifest.schema.json` 及 golden fixture。
9. 人读说明补充other target 不要求 10 类全执行，但每个不适用项必须有 schema 校验原因和证据。
10. 增加核心目录 target-specific 名称扫描验收命令。

Recommended improvements：已全部采纳。

Case generation risk：修正前 4/5，修正后待后续 test/scoring/critic 轮次复核。

## Round 4 - Hard Failure / Scoring / Release Decision

评审者：test-engineer 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. release decision 的 `BLOCK`、`DIAGNOSTIC_ONLY`、score threshold 优先级不可执行。
2. hard failure DSL 缺少数组绑定语义，`matchesContract` 可能匹配到不同 join/transition。
3. `scoreProvenance` 只有版本和 hash，不能解释每一项分数来源。
4. case-level result 和 suite-level release decision 边界不清。
5. Human override 可能被理解为可以影响 release decision。
6. Implementation phases 的 P0/P1 与问题严重级别 P0/P1 混淆。
7. 人读说明缺少 raw/capped score、score cap、override 不影响机器 gate 的解释。

已修正：

1. 增加 release decision precedence 表和 `releaseRuleId`，明确 safety/P0 hard failure 优先于 telemetry diagnostic。
2. hard failure DSL 增加 `schemaVersion`、`ruleVersion`、`ruleSetHash`、`bind`、`correlationKey`、`whereSame`、`contractPathRefs`、`explanationTemplate`。
3. 将结果拆为 `case-result.json` 与 `suite-result.json`；`releaseDecision` 只在 suite/run 聚合层输出。
4. `scoreProvenance` 增加 `rawScore`、`cappedScore`、`capApplications[]`、`dimensionProvenance[]`、`oracleResults[]`、`evidenceEventIds[]`、`contractPaths[]`。
5. Human override 明确不得消除 safety/P0 hard failure、不得提高 cap、不得改变默认 CI gate；人工放行只能走 `manualReleaseException`。
6. Implementation phases 从 P0-P6 改名为 M0-M6，P0/P1 只用于问题严重级别。
7. 人读说明补充 rawScore/cappedScore、hard failure cap 与人工 override 边界。
8. coverage report 缺口分类固定为 `targetCapabilityAbsent`、`generatorNotImplemented`、`fixtureDisabled`。
9. target-specific 名称扫描纳入 M5 验收命令。

Recommended improvements：已全部采纳。

Scoring explainability risk：修正前 3/5，修正后待后续 runner/security/critic 轮次复核。

## Round 5 - Runner / Telemetry / Token Cost

评审者：critic 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. Runner comparability 是 workflow、efficiency、tokenCost 三轴，但 suite result 示例压成单值，跨 runner ranking 易误导。
2. Runner capability 缺少 modelId、CLI 版本、runtime 版本、entrypoint kind 支持矩阵、token source detail。
3. telemetry completeness 缺少公式、事件桶权重和低置信折算；效率算法引用 `model-active` 但 event schema 没有对应类型。
4. token confidence 与 cost estimate confidence 未分开建模，`>= mixed` 排序未定义。
5. Claude/opencode disabled stubs 未落入 M0/M4 验收；dummy CLI case 只有 dry-run，不能证明 runner 能消费 CLI entrypoint。

已修正：

1. `RunnerCapabilities` 增加 identity、disabledReason、supportsEntrypointKinds、tokenSourceDetail，并明确 capabilitiesHash 输入字段。
2. Event schema 增加 `model_active`、`spanPhase`、`durationMs`。
3. 增加 telemetry completeness rubric：transcript、toolCalls、tokenUsage、fileDiff、exitStatus、artifact、state、sideEffect、spanTiming 权重和折算公式。
4. Token ledger 增加 `costEstimateConfidence`、pricingSource、priceUnit、confidenceReasons、tokensPerPassingCase、costPerPassingCase、tokensPerScorePoint 公式。
5. Suite result 增加三轴 `runnerComparability` 和 `crossRunnerRanking`：status、rankingBasis、excludedAxes、whyDirectionalOrNotComparable。
6. M0 增加 Codex capability、Claude disabled capability、opencode disabled capability golden fixtures。
7. M4 增加 dummy CLI 非 dry-run dangerous-args admission case，要求产出 event、token ledger、exit status。
8. 人读说明补充三轴可比性不一致时只展示诊断，不给综合 runner 排名。

Recommended improvements：已全部采纳。

Runner cost risk：修正前 4/5，修正后待后续 security/implementation/critic 轮次复核。

## Round 6 - Security / Sandbox / Side-effect Safety

评审者：verifier 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. sandbox 只靠 HOME/PATH/env，不足以证明网络和文件系统强隔离。
2. `PATH=.benchmark-runs/bin:{originalSafePath}` 可能被绝对路径命令、curl、ssh、DB client、npx 等逃逸。
3. secret passthrough 例外过宽，缺少 runner-only、ttl、redaction、防泄漏规则。
4. `PRODUCTION_SIDE_EFFECT` 依赖窄命令正则，不能覆盖 document-service/DB/push/merge/HTTP 写等副作用。
5. CLI-only target command 任意，profile discovery 阶段也可能误触真实副作用。

已修正：

1. 增加 gate 模式强隔离要求；强隔离不可验证时 exit 33。
2. `PATH` 改为 sandbox `bin` + 最小 `runtime-bin`，不得拼接宿主机原始 PATH。
3. Target Pack 增加 `commandPolicy`：allowedExecutables、allowedArgTemplates、forbiddenArgs、forbidAbsoluteExecutablesUnlessDeclared、shell=false、requiresDryRunDiscovery、profileReadOnly。
4. profile discovery 同样执行 sandbox、network deny、fake wrappers、commandPolicy。
5. secret passthrough 默认禁止；若必须启用，必须声明 secretId、consumer=runner-only、scope、ttl、redactionPatterns，且不得注入 target CLI。
6. stdout/stderr/event/report/artifact/ledger 全量 secret scan，命中触发 `SECRET_LEAK`。
7. 网络策略增加 DNS/IP/内网段/云元数据/数据库端口 deny，第一阶段 allowlist 只能是 loopback 或 fake tool host。
8. side-effect ledger schema 扩展 caseId、runAttemptId、actor、commandId、cwd、executable、argv、redactedEnv、networkHost、policyHash、decisionSource、redactionStatus。
9. `PRODUCTION_SIDE_EFFECT` 改为由通用 side-effect policy classifier 触发。
10. M2 增加 sandbox escape 与 secret leak dry-run 验收；M2 验收列出绝对路径、curl、npx、DB client、document-service update、git push/gh merge、secret leak。
11. runner `sandbox=none` 或 `approvalControl=none` 只能 diagnostic，不能 gate。
12. 人读说明补充第一阶段 allowlist 限制和强隔离缺失时只能诊断。

Recommended improvements：已全部采纳。

Security risk：修正前 5/5，修正后待后续 verifier/critic 轮次复核。

## Round 7 - Implementation Feasibility / Codex Task Book

评审者：planner 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. Target Pack schema 命名不一致，`--target minimal-directory-agent` / `dummy-cli-agent` 没有唯一加载来源。
2. materializer 文件和 CLI 已在架构中出现，但 M0-M6 没有 milestone 负责。
3. `run --case <path>` 与裸 case id 混用，fixtures/cases 路径未在目录结构中声明。
4. pricing config 已在目录出现，但未纳入验收。

已修正：

1. 统一 canonical schema 名称为 `target-pack.schema.json`。
2. 增加 `configs/targets/registry.yaml`，规定 `--target <id>` 只从 registry 加载。
3. 显式增加 `configs/targets/minimal-directory-agent.yaml` 与 `configs/targets/dummy-cli-agent.yaml`。
4. 新增 M4 Template Materializer MVP，覆盖 `caseMaterializer`、template registry、binding resolver、generation manifest、materialize CLI、10 类 smoke 模板。
5. 原 runner/scorer/full milestones 顺延为 M5/M6/M7。
6. 增加 `fixtures/cases/sandbox` 与 `fixtures/cases/scorer` 目录。
7. `--case` 统一为文件路径；新增 `--case-id <id> --manifest <path>` 作为 id 解析方式。
8. M0/M3 纳入 `configs/pricing/models.example.yaml` 校验和默认加载规则。

Recommended improvements：已采纳。

Implementation risk：修正前 4/5，修正后待最终 critic 轮次复核。

## Round 8 - Human Guide / Business Readability

评审者：writer 子 agent

Verdict：`NO_BLOCKING_SUGGESTIONS`

Required changes：无。

Recommended improvements：

1. 人读说明第 13 节写“三类文档”但列了 4 项。
2. 增加日常维护 checklist。
3. 增加业务负责人、workflow 维护者、QA 各自阅读重点和动作表。
4. 补充 token/cost 不可比不代表 workflow 差，只代表不能用于 runner 选型排名。

已修正：

1. 改为“四类文档”。
2. 第 12 节增加日常维护 checklist。
3. 第 7 节增加角色阅读重点表。
4. 第 5.2 节补充不可比的业务含义。

Human readability risk：2/5。

## Round 9 - Generic Consistency Regression / 文档一致性

评审者：verifier 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. 技术方案第 4 节 `target-pack.schema` 与 canonical `target-pack.schema.json` 不一致。
2. Hard Failure 总表中 `PRODUCTION_SIDE_EFFECT` 仍使用旧的命令 denylist 表达。
3. Hard Failure 总表中 `SECRET_LEAK` 证据范围未覆盖 stdout/stderr/artifact/ledger。

已修正：

1. 统一为 `target-pack.schema.json`。
2. `PRODUCTION_SIDE_EFFECT` 改为基于 `side_effect_attempt.policyDecision=deny` 和分类器。
3. `SECRET_LEAK` 证据范围补齐 stdout/stderr/artifact/event/report/side-effect ledger。
4. 人读说明增加 `case-result.json` 与 `suite-result.json` 两层机器结果解释。

Recommended improvements：

1. 评审记录中的旧 P5/P0-P6 表述为历史问题原文，不影响当前方案。
2. Hard Failure 总表后续作为唯一 code/evidence 总表维护。

Consistency risk：修正前 3/5，修正后待最终对抗评审复核。

## Round 10 - Final Adversarial Review

评审者：critic 子 agent

Verdict：`NEEDS_CHANGES`

Required changes：

1. `PRODUCTION_SIDE_EFFECT` 的 canonical 字段不一致：Hard Failure 表、DSL、side-effect ledger、smoke 覆盖和 M2 验收混用 `policyDecision` 与 `allowed`。
2. `SECRET_LEAK` 的证据范围不一致：部分章节漏掉 side-effect ledger。

已修正：

1. 统一 side-effect event payload：`policyDecision` 是 scorer 消费字段；`allowed` 是派生字段，必须满足 `allowed === (policyDecision === "allow")`。
2. `PRODUCTION_SIDE_EFFECT` DSL 从 `any` 改为 `all(policyDecision=deny, classifiedAs in write categories)`。
3. side-effect ledger 示例增加 `policyDecision=deny`。
4. P0 覆盖表、smoke matrix、M2 验收全部同步到 `policyDecision=deny` + `allowed=false` 派生校验。
5. `SECRET_LEAK` 在总表、覆盖表、M2 验收中统一覆盖 stdout/stderr/artifact/event/report/side-effect ledger。
6. M2 增加 side-effect ledger 泄漏 positive fixture 和 redacted negative fixture 要求。
7. 统一 `model_active` 命名。
8. 增加强隔离首选落地路径：CI/Linux container 或 namespace/firewall/proxy；本地 macOS 无强隔离时 gate exit 33，只能 diagnostic。
9. `generationManifest` 增加 `reproduceCommand`。

Recommended improvements：已采纳。

Final blocker risk：修正前 4/5，修正后进入最终本地验证。

## Round 11 - Self-Debug / Reverse Validation 增量评审

评审视角：architect、test-engineer、verifier、critic 综合增量评审。

Verdict：`NO_BLOCKING_SUGGESTIONS_AFTER_FIXES`

触发原因：用户新增要求 benchmark 支持自身 debug：根据 target workflow 构建工作环境、临时修改 workflow 内容做反向验证，并扩展到工具自身诊断、修复和优化能力。

Required changes：

1. debug 环境不能另起一套宽松执行链，必须复用正式 run 的 sandbox、fake tools、network policy、side-effect ledger、observer、token ledger。
2. 临时修改必须限定在 sandbox copy 或 overlay，不能修改真实 target workflow 源码。
3. 反向验证必须是 baseline pass -> mutant fail -> restore pass 的红绿合同，否则无法区分目标问题、benchmark 盲区和环境污染。
4. mutation 未被检测时必须输出可解释的盲区分类，而不是只给失败日志。
5. repair 能力默认只能给 benchmark-side 修复建议；自动 apply 不能修改 target workflow，不能放宽生产写安全策略。
6. debugHealth 必须和 target score 分离，避免把 benchmark 自身健康度误算成被测 workflow 质量。

已修正：

1. 技术方案新增第 21 节 `Benchmark Self-Debug、反向验证与修复优化闭环`。
2. 目录结构新增 `schemas/debug-environment.schema.json`、`schemas/mutation.schema.json`、`schemas/debug-dossier.schema.json`、`schemas/repair-plan.schema.json` 和 `src/debug/*`。
3. CLI 新增 `debug prepare-env`、`debug reverse-validate`、`debug diagnose`、`debug propose-fix`、`debug repair` 及 60-67 退出码。
4. `suite-result.json` 新增 `debugHealth`，并明确 `doesNotAffectTargetScore=true`。
5. Target Pack Onboarding 新增 `debug prepare-env` 和 core mutation set 的 `debug reverse-validate`。
6. Implementation Task Book 新增 M8 Self-Debug Environment 与 Reverse Validation、M9 Repair Planner 与 Benchmark Optimization Loop。
7. 人读说明新增第 10 节，解释“好 -> 坏 -> 好”的反向验证、盲区分类和修复边界。

Recommended improvements：

1. 更大规模 mutation library 进入 Backlog。
2. baseline / mutant / restore trace diff viewer 进入 Backlog。
3. 自动生成 benchmark 修复 PR 进入 Backlog。

Residual risk：self-debug 能力已纳入方案，但真实有效性仍依赖实现阶段的 fixture 质量、runner telemetry 完整度和 mutation set 覆盖面；这些已在 M8/M9 验收中绑定。
