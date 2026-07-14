# Agent Workflow Benchmark 插件使用说明

## 当前形态

本仓库现在提供一个双运行时插件包：

```text
plugins/agent-workflow-benchmark/
├── .codex-plugin/plugin.json
├── .claude-plugin/plugin.json
├── bin/awb
├── commands/agent-workflow-benchmark.md
├── runtime/                         # generated bundled runtime for no-source installs
└── skills/agent-workflow-benchmark/SKILL.md
```

它不是只把旧 CLI 包一层，而是把 benchmark 主流程改成 AI-first：

1. 通过 `profile` 建立被测 workflow 的结构化 `ContractModel`。
2. 通过 `plan-cases` 调用当前运行时 LLM，例如 Codex 或 Claude Code，让 LLM 基于 `ContractModel`、被扫描 agent 文件摘录和覆盖目标先理解 workflow，再生成 case plan。
3. 检查 `ai-case-plan-validation.json`，确认 case 数量、coverage tags、missing targets 和 bindings 没有明显缺口。
4. 通过 `materialize --strategy ai` 把 LLM plan 结构化成可执行 case YAML。
5. 通过 `run --cases-dir` 执行 AI-generated cases。
6. 通过 `report/score/debug reverse-validate/diagnose` 生成解释性结果和工具自调试证据。

现在推荐优先使用 `evaluate` 一键执行完整流程。它会写出 `profile/`、`ai-plan/`、`cases/`、`run/suite-result.json`、`run/report.md`、`run/harness-validation.json`、`run/recommendations.json`、`run/recommendations.md`、`run/p0-cases.json`、`run/p0-cases.md` 和 `evaluation-summary.json`。报告里包含维度评分、agent workflow 修改建议、harness validation 和 P0 case records。

## 在 Codex 中使用

在本地源码仓库中注册并安装 Codex 插件：

```bash
codex plugin marketplace add "$(git rev-parse --show-toplevel)"
codex plugin add agent-workflow-benchmark@agent-workflow-benchmark-local
codex plugin list
```

安装后，新开的 Codex 线程可以加载插件内的 `agent-workflow-benchmark` skill。当前线程如果是在安装前启动的，需要新开线程才能看到新 skill。

直接在本仓库运行：

```bash
plugins/agent-workflow-benchmark/bin/awb evaluate \
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
plugins/agent-workflow-benchmark/bin/awb plan-cases \
  --target minimal-directory-agent \
  --runner codex \
  --live-model gpt-5.3-codex-spark \
  --max-cases 2 \
  --timeout-ms 180000 \
  --out reports/ai-plans/minimal-directory-agent-codex-live

plugins/agent-workflow-benchmark/bin/awb materialize \
  --target minimal-directory-agent \
  --suite smoke \
  --strategy ai \
  --ai-plan reports/ai-plans/minimal-directory-agent-codex-live/ai-case-plan.json \
  --out cases/generated/minimal-directory-agent/codex-ai-smoke

plugins/agent-workflow-benchmark/bin/awb run \
  --cases-dir cases/generated/minimal-directory-agent/codex-ai-smoke \
  --runner codex \
  --execution live \
  --mode diagnostic \
  --out reports/runs/minimal-directory-agent-codex-ai-smoke

plugins/agent-workflow-benchmark/bin/awb score \
  --run reports/runs/minimal-directory-agent-codex-ai-smoke
```

对单个 AI-generated case 跑 live Codex：

```bash
plugins/agent-workflow-benchmark/bin/awb run \
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

- `commands/agent-workflow-benchmark.md`：Claude slash command 说明。
- `bin/awb`：命令包装器。
- `skills/agent-workflow-benchmark/SKILL.md`：Claude/Codex 共享的 benchmark workflow skill。

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

如果尚未安装 `claude` CLI，可以在安装 Claude Code 后先用官方支持的本地插件加载方式验证：

```bash
claude --plugin-dir "$(git rev-parse --show-toplevel)/plugins/agent-workflow-benchmark"
```

进入 Claude Code 后，插件技能会以命名空间形式加载，插件的 `bin/awb` 会进入 Bash PATH。之后可使用 `/agent-workflow-benchmark:agent-workflow-benchmark <target-id>` 或直接让 Claude 执行 `awb plan-cases ...`。

## 验证过的证据

本地已验证：

- `npm run validate`：运行 typecheck 和 Vitest 全量测试。
- `npm test -- tests/plugin-package.test.ts tests/live-runner.test.ts`：验证插件 wrapper、packaged runtime、live runner prompt/transcript 行为。
- `plugins/agent-workflow-benchmark/bin/awb validate-schema`：验证插件 runtime 的 schema 和 runner config 可加载。
- `plan-cases --runner codex` 成功生成真实 LLM case plan，prompt 中包含 `Workflow evidence excerpts` 和 agent 文件内容摘录。
- `materialize --strategy ai` 成功生成 AI cases。
- `run --cases-dir` 成功执行 AI-generated cases。
- AI-generated 单 case 的 `--execution live` Codex verdict 为 `PASS`，作用范围是 live runner prompt/transcript 诊断结果，不是对真实 target entrypoint 执行的发布批准。
