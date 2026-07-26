# Agent Workflow Bench 插件使用说明

Agent Workflow Bench（AWB）定位为 coding-agent workflow 的 CI 级回归测试工具。CLI 为 `awb`，插件名、Skill 和命令 slug 统一为 `agent-workflow-bench`；`benchmark` 与 `evaluate` 用法继续可用。

## 当前形态

本仓库现在提供一个双运行时插件包：

```text
plugins/agent-workflow-bench/
├── .codex-plugin/plugin.json
├── .claude-plugin/plugin.json
├── bin/awb
├── commands/agent-workflow-bench.md
├── runtime/                         # generated bundled runtime for no-source installs
└── skills/agent-workflow-bench/SKILL.md
```

它不是只把旧 CLI 包一层，而是把 benchmark 主流程改成 AI-first：

1. 先运行 `awb doctor --target <target-id> --runner <runner> --out <doctor-dir>`，profile target、确认 runner 能力并查看 evidence 上限。
2. 用同一 target、suite、runner mode 和 contract hash 跑 matched baseline / candidate。
3. 用 `awb compare --baseline <baseline-run> --candidate <candidate-run> --out <comparison-dir>` 比较回归和证据缺口。
4. 用 `awb gate --comparison <comparison-dir>/comparison-result.json --out <gate-dir>` 执行 CI gate：PASS exit `0`，DIAGNOSTIC_ONLY exit `2`，BLOCK exit `1`。
5. 需要验证重复运行稳定性时，用 `awb debug reliability --study <reliability-study.json> --out <reliability-dir>`；它保留所有 attempt，统计 A/A、方差、置信区间、missing、P0 detection 和 quarantine。Unsigned simulated repeat 最多得到 `DIAGNOSTIC_REPRODUCIBLE`，不会输出 strong conclusion；只有稳定且已认证的 live `workflow_trace` 能得到 `RELIABLE`。

需要查看多次 trial 的能力与一致性时，执行
`awb report trial-metrics --reliability <reliability-report.json> --k 1,2,5 --out <trial-metrics-dir>`。
它按 Inspect 的有限样本公式同时输出 pass@k 和 pass^k，且只把 Gate `PASS`
计为成功。当前命令不会重新打开原始签名 Trace，所以仅凭 reliability JSON
始终为 `DIAGNOSTIC_ONLY`；自洽哈希不等于独立认证。

传统分步 evaluate 流程仍兼容：

1. 通过 `profile` 建立被测 workflow 的结构化 `ContractModel`。
2. 通过 `plan-cases` 调用当前运行时 LLM，例如 Codex 或 Claude Code，让 LLM 基于 `ContractModel`、被扫描 agent 文件摘录和覆盖目标先理解 workflow，再生成 case plan。
3. 检查 `ai-case-plan-validation.json`，确认 case 数量、coverage tags、missing targets、bindings、reference/counterexample outcomes 和正反向样本没有明显缺口。
4. 通过 `materialize --strategy ai` 把 LLM plan 结构化成可执行 case YAML。
5. 通过 `run --cases-dir` 执行 AI-generated cases。
6. 通过 `report/score/debug reverse-validate/diagnose` 生成解释性结果和工具自调试证据。

`evaluate` 一键流程会写出 `profile/`、`ai-plan/`、`cases/`、`run/suite-result.json`、`run/report.md`、`run/harness-validation.json`、`run/recommendations.json`、`run/recommendations.md`、`run/p0-cases.json`、`run/p0-cases.md` 和 `evaluation-summary.json`。报告里包含维度评分、agent workflow 修改建议、harness validation 和 P0 case records。

门禁边界：只有通过资格认证的独立 live Observer 输出真实 `workflow_trace` evidence 时，gate 才能 PASS。simulated run、未认证签名 trace 和内置 live `contract-summary` adapter 只能给 `DIAGNOSTIC_ONLY`。`awb observer qualify` 会运行 known-good、全部 P0、事件遗漏/乱序、伪造、错误公钥、私钥泄漏、网络/工具盲区和重复运行检查，并输出由独立资格授权方签名的完整性制品；没有该制品时 `qualificationStatus` 保持 `missing`。

外部 Observer 用 Ed25519 对标准化 workflow trace 签名后，通过 `awb ingest-trace --trace <trace.json> --trusted-observer-key <public.pem> --observer-qualification <artifact.json> --trusted-qualification-key <authority-public.pem>` 导入。`compare` 和 `gate` 必须再次传入 Observer 与资格授权方两个公钥信任锚。私钥不得提供给 Runner，CLI 也会拒绝把私钥当作 trust anchor。

内置 reference Observer 支持两个显式隔离后端：`macos-seatbelt` 和
`linux-oci-docker`。macOS 后端要求 `/usr/bin/sandbox-exec`，使用 deny-default
Seatbelt 边界并实际尝试读取 Observer 私钥、直连网络和启动未声明子进程，三项都必须被系统拒绝。Linux 后端要求 Docker CLI 和不可变的 Observer image ID 或 digest；运行时以只读 rootfs、禁网、无 capabilities、`no-new-privileges`、seccomp 子进程拒绝、最小挂载和非 root 用户执行，并把 Observer 私钥保留在 runner mount 外。两个后端都会写出主动 canary 证据；隔离后端缺失、image ID/digest 不匹配、canary 成功、私钥进入挂载、Observer/资格授权方复用同一密钥，或选择未支持的后端时都会 fail closed。

`compare` 会把 baseline/candidate 的 suite、provenance、runtime manifest 和 workflow trace 快照写入 comparison 目录并记录完整性哈希。`gate` 会重新验证 observer 签名、快照、runtime 执行事实和 provenance，并重新计算 comparison；手工修改 comparison JSON、证据文件或仅重算可编辑哈希都会得到 `BLOCK`，不能伪造 live PASS。

Stage 6 开始，score 和 gate 还绑定版本化 `gate-policy.json`。策略校准只读取
Gold Corpus 的 development/calibration split，holdout 由单独命令验证：

```bash
awb gate-policy calibrate --corpus fixtures/gold-corpus/v1/manifest.yaml --policy-version 1.1.0 --out reports/gate-policy/<target-id>/fit
awb gate-policy validate-holdout --corpus fixtures/gold-corpus/v1/manifest.yaml --policy reports/gate-policy/<target-id>/fit/gate-policy.json --calibration-report reports/gate-policy/<target-id>/fit/calibration-report.json --out reports/gate-policy/<target-id>/holdout
```

`calibrate` 返回 `2`，状态是 `PENDING_HOLDOUT`；如果没有 candidate 同时保持
P0 recall `1` 和 false PASS `0`，则返回 `1` 且不生成策略。`validate-holdout` 返回 `0`
表示 PASS，返回 `1` 表示 FAIL。已提交的公共 synthetic 证据在
`fixtures/calibration/v1/fit/{gate-policy.json,calibration-report.json,calibration-report.md}`
和 `fixtures/calibration/v1/holdout/{calibration-report.json,calibration-report.md}`。
这些报告是 harness 诊断证据，`releaseEligible: false`，不能授权生产 blocking。
其中 stability 是完整 synthetic harness 的确定性重放，不是 live-run reliability。

重算历史 comparison/gate 时显式传入同一策略：

```bash
awb compare --baseline <baseline-run> --candidate <candidate-run> --gate-policy <gate-policy.json> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --gate-policy <gate-policy.json> --out <gate-dir>
```

缺失或不匹配的 `policyVersion`、`rulesHash`、`policyHash` 会让结果不可比较。校准策略只改变分数权重、阈值和分类 delta；它不会改变 Observer evidence 的真伪，也不能让综合分数或 AI 判断覆盖 P0、无效 provenance、缺证据、Observer 资格失败或其他 hard failure。

Stage 7 开始，插件 runtime 同步携带正式 artifact schema registry、兼容矩阵和迁移工具。复用旧制品前先运行：

```bash
awb artifact migrate --input <artifact.json> --out reports/artifact-migration
```

非标准文件名可加 `--artifact-type <type>`，类型取自 registry，例如
`runtime_manifest`、`suite`、`comparison_result` 或 `provenance`。命令固定写出
`migration-result.json`；安全迁移时写出 `migrated-artifact.json`。退出码为：
`0` = `CURRENT`/`MIGRATED`，`2` = `DIAGNOSTIC_ONLY`，`1` =
`INCOMPATIBLE`。稳定 reason code 包括
`ARTIFACT_JSON_INVALID`、`ARTIFACT_TYPE_UNKNOWN`、
`ARTIFACT_SCHEMA_VERSION_MISSING`、`ARTIFACT_SCHEMA_VERSION_INVALID`、
`ARTIFACT_SCHEMA_VERSION_UNSUPPORTED`、`ARTIFACT_TRUST_FIELDS_MISSING`、
`ARTIFACT_SCHEMA_INVALID` 和 `ARTIFACT_METADATA_ADDED`。

迁移只能保留或补充 schema 元数据，不能发明信任。缺少 Observer attestation、
gate-policy hash、integrity hash、provenance binding、runtime identity 或
conditions identity 的旧制品保持 `DIAGNOSTIC_ONLY`，不能用于 CI PASS 或生产
blocking。完整策略见
[`artifact-schema-compatibility.md`](artifact-schema-compatibility.md)。

Stage 10 开始，插件包含 Adapter SDK 合约、OpenCode live Runner Adapter、Adapter
conformance、benchmark health 和 cross-runner ranking。OpenCode Adapter 调用的是：

```bash
opencode run --format json --dir <sandbox-root>
```

可选 `--model <provider/model>`。Adapter 不会添加 `--auto`、`--yolo`、
`--dangerously-skip-permissions` 或等价自动授权参数。它要求 OpenCode JSON 输出中包含
native assistant token evidence；缺失 token、证据超限、JSONL 无效、事件顺序错误、
输出含需脱敏私密数据或进程执行失败都会得到稳定 Adapter reason code。

运行 conformance：

```bash
awb adapter conformance \
  --adapter opencode \
  --target minimal-directory-agent \
  --adapter-executable "$(command -v opencode)" \
  --out reports/adapters/opencode
```

`adapter-conformance-report.json` 的 `decision: PASS` 只代表 Adapter 合约和 `CaseRun`
可被 AWB scorer 接受。报告固定 `releaseDisposition: DIAGNOSTIC_ONLY`，不能授权 workflow
gate PASS。Adapter 合约还固定声明证据上限、stable error codes、runner lifecycle
events、native token source，以及禁用自动 trust enrollment、自动 workflow 修改、
自动 fix PR 和 Runner 读取 Observer 私钥。

周期性 benchmark health 聚合 Gold Corpus、P0 mutation、Observer qualification、
A/A reliability、schema compatibility、plugin install 和 privacy scan：

```bash
awb ci benchmark-health \
  --input health/benchmark-health-input.json \
  --out reports/health/current
```

出现 P0 false negative、false PASS、Observer 无效、schema incompatible、缺检查、
plugin install 失败、privacy finding 或 reliability 失败时，报告自动将 AWB 版本处置为
`DIAGNOSTIC_ONLY`。该命令不会登记信任根、修改 workflow 或创建修复 PR。

跨 runner 排名必须显式输入完全可比的 evidence：

```bash
awb report runner-ranking \
  --input reports/ranking/runner-ranking-input.json \
  --out reports/ranking/current
```

只有 exact task、Target Contract、Case Set、已认证 Observer、budget、live
`workflow_trace` Telemetry、native token source，以及 workflowScore、efficiency、
tokenCost 三轴都可比时才输出排名。否则输出 `INCOMPARABLE` 和 reason codes。

P1/P2 诊断命令现在也随插件 runtime 发布。它们都写入注册 schema 的制品，但默认不授予 gate authority：

```bash
awb trace import-otlp \
  --input telemetry/otlp-export.json \
  --source-ref telemetry/otlp-export.json \
  --out reports/imports/otlp
```

输出 `otlp-diagnostic-import.json`、`trace-import-manifest.json` 和
`diagnostic-events.json`，退出码为 `2`。该命令只做 OTLP span 到脱敏诊断事件的有损映射，
状态固定为 `DIAGNOSTIC_ONLY`、`gateAuthority: NONE`；它不是 Observer qualification，
也不会让外部 telemetry 变成可准入的 live trace。

```bash
awb trace curate-production \
  --input reports/curation/production-trace-curation-input.json \
  --out reports/curation/production-trace
```

输出 `production-trace-curation.json` 和 `production-trace-curation.md`，退出码为 `2`。
输入必须嵌入已脱敏的 diagnostic import、同意与 retention 证据、owner/security review
要求和 reference/holdout 前置条件。输出始终是 draft package，固定
`DIAGNOSTIC_ONLY` / `NONE`，不会激活 case、发布 corpus 或授权生产 gate。

```bash
awb governance benchmark \
  --input reports/governance/benchmark-governance-input.json \
  --out reports/governance/current
```

输出 `benchmark-governance-report.json` 和 `benchmark-governance-report.md`。当 split
isolation、contamination、saturation、reproducibility 和四个必需 domain
adapter 证据完整时，报告为 `POLICY_COMPLETE` 但仍返回 `2`；缺 split、holdout/private
challenge 暴露、强制排名或 domain 证据缺失时，报告为 `BLOCKED` 并返回 `1`。
两种结果都固定 `DIAGNOSTIC_ONLY` / `NONE`。

```bash
awb report workflow-economics \
  --trace-diff reports/observed/trace-diff/trace-diff.json \
  --trajectory-review reports/observed/trajectory-review/trajectory-review.json \
  --baseline-suite reports/runs/baseline/suite-result.json \
  --candidate-suite reports/runs/candidate/suite-result.json \
  --generated-at 2026-07-26T00:00:00.000Z \
  --out reports/observed/workflow-economics
```

输出 `workflow-economics-report.json` 和 `workflow-economics-report.md`，退出码为 `2`。
它重新校验 trace diff、trajectory review 和两侧 suite，按 AWB `0–100`
`cappedScore` 比较质量、token、wall-clock、重试和不可逆副作用指标。调用方必须显式
传入规范 UTC `--generated-at`；只有两侧 token 证据均为 `high` confidence 才允许
Pareto dominance，较低置信度的差值仍会展示，但该 case 标记为 `INCOMPARABLE`。
gate policy、suite、case 或 metric 绑定不一致时同样不可比较。报告只用于成本/效率
诊断，不会改变 gate 结论。

```bash
awb ingest-trace \
  --cases-dir cases/generated/<target-id>/ai-smoke \
  --suite smoke \
  --trace observer-output/workflow-trace.json \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --observer-qualification observer-output/observer-qualification.json \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/runs/<target-id>-observed

awb compare \
  --baseline reports/runs/<target-id>-baseline \
  --candidate reports/runs/<target-id>-candidate \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/comparisons/<target-id>

awb gate \
  --comparison reports/comparisons/<target-id>/comparison-result.json \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/gates/<target-id>
```

签名只证明轨迹来源和签名后完整性。observer 是否完整捕获真实工具、文件、路由和副作用，仍需用已知好/坏轨迹、mutation 和 CI 隔离证据独立验证。
公钥参数不是资格认证。AWB 不会自动把公钥加入信任根。
完整字段、签名规范和 observer 准入检查见
[`workflow-trace-observer-contract.md`](workflow-trace-observer-contract.md)。

## CI 模板与生产阻断边界

仓库自检 CI 在 `.github/workflows/ci.yml` 中定义，覆盖 `git diff --check`、
typecheck、全量测试、plugin build、runtime parity、schema validation、canonical
naming scan、privacy scan 和 fresh-install smoke。任何影响 runtime 的源码、
schema、config、fixture、package 或 lockfile 变更，都必须重新运行
`npm run plugin:build` 并提交生成结果。

可复用的外部 workflow 模板是
`.github/workflows/awb-external-observe-only.yml`。调用方把私有 Target Pack 放在
自己的 `.awb/targets` 目录，模板会 checkout baseline/candidate、复制 Target Pack、
运行 `doctor`、`run`、`compare` 和 `gate`。它是 observe-only：PASS、
`DIAGNOSTIC_ONLY` 和 `BLOCK` 都只记录到 summary，不会仅因为 AWB decision 让调用方
失败；但 AWB 命令无法执行、schema/compare 失败或没有写出 `gate-result.json` 时会
fail closed。summary artifact 默认不上传；只有显式设置
`upload-redacted-artifacts: true` 时才上传短保留期的 redacted summary JSON。
调用方可读取 `decision` 和 `gate_exit_code` 输出做记录或路由，但不能把
observe-only 输出解释为生产授权。

生产 CI 的评估命令是：

```bash
awb ci evaluate-canary --samples <samples.json> --isolation-manifest <manifest.json> --gate-policy <gate-policy.json> --out <canary-dir>
awb ci assess --gate-result <gate-result.json> --runtime-manifest <runtime-manifest.json> --provenance <provenance.json> --isolation-manifest <manifest.json> --canary-report <production-canary-report.json> --out <assessment-dir>
```

当 assess 唯一缺口为 `PROD-BLOCKING-NOT-AUTHORIZED` 时，子 Agent 可运行
`awb ci prepare-authorization` 生成只含公钥指纹的待签请求和精确 payload；生产
授权人在外部签名后，子 Agent 使用 `awb ci finalize-authorization` 验签并回填正式
授权制品。两个命令都不接收生产授权私钥。完整参数与三个人工 checkpoint 见
`docs/human-light-execution.md`。

canary 冻结阈值为：样本数至少 `30`、false positive rate 不高于 `0.02`、false
negative rate 为 `0`、flaky rate 不高于 `0.05`、runtime p95 不高于 `900` 秒、
cost p95 不高于 `10` USD。误报率以 known-good 样本为分母，漏报率以 known-bad
样本为分母；两类样本都必须存在，`sampleSetHash` 绑定完整样本集。`ci assess`
不会因为 canary 通过就启用 blocking；它还要求 evidence gate PASS、qualified
live Observer、caller 提供的强隔离 manifest、外部 trust anchors 和显式签名授权。
授权签名同时绑定 gate、runtime manifest、provenance、isolation、canary 与 gate
policy；替换任一制品都会 BLOCK。

生产 blocking gate 需要 workflow owner 显式授权、已认证的独立 live
`workflow_trace` Observer、调用方提供的 Runner 强隔离证据、临时 HOME/TMPDIR、默认禁网或
allowlist、只读 target、受控工具代理、两个外部公钥 trust anchors，以及只保存脱敏制品的
retention 策略。任一条件缺失时保持 `DIAGNOSTIC_ONLY`。AWB 可以用
`linux-oci-docker` 资格认证 reference Observer，但生产 runner 的隔离 manifest 仍由调用方提供并绑定到授权签名。

## 在 Codex 中使用

在本地源码仓库中注册并安装 Codex 插件：

```bash
codex plugin marketplace add "$(git rev-parse --show-toplevel)"
codex plugin add agent-workflow-bench@agent-workflow-bench
codex plugin list
```

安装后，新开的 Codex 线程可以加载插件内的 `agent-workflow-bench` skill。当前线程如果是在安装前启动的，需要新开线程才能看到新 skill。

直接在本仓库运行：

```bash
plugins/agent-workflow-bench/bin/awb evaluate \
  --target minimal-directory-agent \
  --planner-runner codex \
  --runner codex \
  --coverage-mode full \
  --execution live \
  --live-model gpt-5.3-codex-spark \
  --timeout-ms 180000 \
  --out reports/evaluations/minimal-directory-agent-codex-live
```

需要检查中间产物时，再使用分步命令：

```bash
plugins/agent-workflow-bench/bin/awb plan-cases \
  --target minimal-directory-agent \
  --runner codex \
  --live-model gpt-5.3-codex-spark \
  --max-cases 2 \
  --timeout-ms 180000 \
  --out reports/ai-plans/minimal-directory-agent-codex-live

plugins/agent-workflow-bench/bin/awb materialize \
  --target minimal-directory-agent \
  --suite smoke \
  --strategy ai \
  --ai-plan reports/ai-plans/minimal-directory-agent-codex-live/ai-case-plan.json \
  --out cases/generated/minimal-directory-agent/codex-ai-smoke

plugins/agent-workflow-bench/bin/awb run \
  --cases-dir cases/generated/minimal-directory-agent/codex-ai-smoke \
  --runner codex \
  --execution live \
  --mode diagnostic \
  --out reports/runs/minimal-directory-agent-codex-ai-smoke

plugins/agent-workflow-bench/bin/awb score \
  --run reports/runs/minimal-directory-agent-codex-ai-smoke
```

对单个 AI-generated case 跑 live Codex：

```bash
plugins/agent-workflow-bench/bin/awb run \
  --case cases/generated/minimal-directory-agent/codex-ai-smoke/minimal-directory-agent-ai-001-l1-flow-triage-to-backend-join.yaml \
  --runner codex \
  --execution live \
  --live-model gpt-5.3-codex-spark \
  --timeout-ms 180000 \
  --mode diagnostic \
  --out reports/runs/minimal-directory-agent-codex-ai-live-case
```

## 在 Claude Code 中使用

Claude Code 插件包使用同一目录。插件内提供：

- `commands/agent-workflow-bench.md`：Claude slash command 说明。
- `bin/awb`：命令包装器。
- `skills/agent-workflow-bench/SKILL.md`：Claude/Codex 共享的 benchmark workflow skill。

在 Claude Code 中，推荐把 runner 换成 `claude`：

```bash
awb evaluate --target <target-id> --planner-runner claude --runner claude --coverage-mode full --execution live --out reports/evaluations/<target-id>-claude-ai
```

分步调试时：

```bash
awb plan-cases --target <target-id> --runner claude --coverage-mode full --out reports/ai-plans/<target-id>
awb materialize --target <target-id> --suite smoke --strategy ai --ai-plan reports/ai-plans/<target-id>/ai-case-plan.json --out cases/generated/<target-id>/ai-smoke
awb run --cases-dir cases/generated/<target-id>/ai-smoke --runner claude --execution live --mode diagnostic --out reports/runs/<target-id>-claude-ai
```

当前实现中，Codex live case runner 已用真实 Codex CLI 验证；Claude 已接入 AI case planner 和 live case runner 适配器，并通过 fake Claude CLI 测试覆盖参数和 JSON 解析路径。这些验证覆盖 live runner prompt、transcript 和结构化输出解析，不等同于真实 target entrypoint 观察器或生产发布批准。

OpenCode 已接入 live Runner Adapter 和 conformance CLI，并通过 fixture executable
测试覆盖 `opencode run --format json --dir` 参数、native token 解析、stable Adapter
failure codes 和 `DIAGNOSTIC_ONLY` evidence ceiling。真实 OpenCode target workflow
PASS 仍需要 qualified independent `workflow_trace` admission。

如果尚未安装 `claude` CLI，可以在安装 Claude Code 后先用官方支持的本地插件加载方式验证：

```bash
claude --plugin-dir "$(git rev-parse --show-toplevel)/plugins/agent-workflow-bench"
```

进入 Claude Code 后，插件技能会以命名空间形式加载，插件的 `bin/awb` 会进入 Bash PATH。之后可使用 `/agent-workflow-bench:agent-workflow-bench <target-id>` 或直接让 Claude 执行 `awb plan-cases ...`。

## 验证过的证据

本地已验证：

- `npm run validate`：运行 typecheck 和 Vitest 全量测试。
- `npm test -- tests/plugin-package.test.ts tests/live-runner.test.ts`：验证插件 wrapper、packaged runtime、live runner prompt/transcript 行为。
- `npm test -- tests/stage10-adapter-sdk.test.ts tests/stage10-benchmark-health.test.ts tests/stage10-runner-ranking.test.ts tests/stage10-cli-schema.test.ts`：验证 Adapter SDK/OpenCode conformance、benchmark health、runner ranking 和 CLI/schema surface。
- `plugins/agent-workflow-bench/bin/awb validate-schema`：验证插件 runtime 的 schema、runner config 和 target pack 可加载；带完整 `--target/--runner/--out` 参数的 `doctor` 验证 target profile、runner 能力和 evidence 上限。
- `plan-cases --runner codex` 可以把 agent 文件摘录作为 transient LLM input 生成真实 case plan；持久化的 prompt artifact 只保留相对路径、hash 和字节数，response artifact 只保留内容 hash，不保存原始 excerpt 或原始模型响应。
- `materialize --strategy ai` 成功生成 AI cases。
- `run --cases-dir` 成功执行 AI-generated cases，并保留已保存 plan validation 的 WARN/FAIL 诊断降级。
- AI-generated 单 case 的 `--execution live` Codex verdict 如果为 `PASS`，作用范围仍是 live runner prompt/transcript 诊断结果；在 current `contract-summary` adapter 下不是对真实 target entrypoint 执行的发布批准，也不能作为 CI gate PASS。
