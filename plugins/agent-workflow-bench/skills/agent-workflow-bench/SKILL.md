---
name: agent-workflow-bench
description: Agent Workflow Bench (AWB) CI-grade regression testing for coding-agent workflows. Use when the user wants to evaluate, benchmark, compare, gate, debug, or improve an agent workflow in Codex or Claude Code; generate benchmark cases using LLM understanding of the target workflow; run Codex/Claude live benchmark runners and detect opencode compatibility; produce explainable scores, token/efficiency metrics, reports, mutation reverse validation, or benchmark self-debug repair plans.
---

# Agent Workflow Bench

Use `awb` when it is on `PATH`. If it is not on `PATH`, resolve the plugin wrapper at `../../bin/awb` relative to this `SKILL.md` file. For source-checkout development, set `AWB_PROJECT_ROOT` to the repository root to force the wrapper to use local TypeScript sources instead of the bundled plugin runtime. The canonical plugin and skill slug is `agent-workflow-bench`; keep the `benchmark` and `evaluate` commands available.

## Methodology

Use `docs/ai-workflow-evaluation-methodology.md` as the benchmark method. The core rule is: the AI planner must first externalize structured target workflow understanding, then generate cases from ContractModel-derived coverage targets. Scoring uses deterministic rules over emitted runner/simulated events first and AI judgment only for semantic workflow quality. AI judgment must not override forbidden-route, owner-bypass, missing-join, artifact-path, unsafe-side-effect, runner-failure, or telemetry evidence.

## AI-first flow

For CI-grade regression testing, prefer doctor -> matched baseline/candidate run -> compare -> gate:

```bash
awb doctor --target <target-id> --runner simulated --out reports/doctor/<target-id>
awb run --target <target-id> --target-root <baseline-checkout> --runner simulated --execution simulated --out reports/regression/baseline
awb run --target <target-id> --target-root <candidate-checkout> --runner simulated --execution simulated --out reports/regression/candidate
awb compare --baseline <baseline-run> --candidate <candidate-run> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --out <gate-dir>
```

Gate exit codes are `0` for PASS, `2` for `DIAGNOSTIC_ONLY`, and `1` for BLOCK or tool/runtime failure. PASS requires a qualified independent live `workflow_trace`. Simulated runs, current live `contract-summary` adapters, and signed traces without a valid Observer qualification artifact are diagnostic-only. Comparison ignores self-asserted `valid` metadata unless the authority-signed artifact verifies.

For repeated-run reliability diagnostics, use a manifest of matched baseline/candidate run pairs:

```bash
awb debug reliability --study <reliability-study.json> --out <reliability-dir>
```

The report includes deterministic reproducibility, live A/A stability, variance, missing rate, telemetry completeness, attempt-identity and duplicate-evidence quarantine, fixed-context drift, P0 detection rate, and gate eligibility. Live attempt identity is derived from the signed trace hash. Simulated consistency is `DIAGNOSTIC_REPRODUCIBLE` with no strong conclusion; this layer never upgrades simulated or unqualified evidence into release PASS.

For external criterion-validity diagnostics, generate a blinded labeling package before collecting human labels:

```bash
awb criterion-validity package --study <study.yaml> --out <validity-dir>
awb criterion-validity analyze --study <study.yaml> --observations <external-validity-observations.json> --labels <external-validity-human-labels.json> --trusted-observer-key <observer-public.pem> --trusted-qualification-key <qualification-authority-public.pem> --out <validity-dir>
```

The observation manifest references content-hashed comparison bundles. `analyze` revalidates both signed traces, Observer qualification, comparison integrity, and study bindings with explicit public keys; self-asserted trust fields cannot produce PASS. The public `fixtures/external-validity/v1/study.yaml` is only an 8-item privacy-safe template. A real PASS requires 120 reviewed external items: directory, CLI, and hybrid targets across Codex and Claude; known-improvement, no-change, ordinary-regression, and P0-regression strata; qualified independent live `workflow_trace` evidence; two independent blinded raters; adjudication; P0 recall 1.0; false PASS 0; overall agreement at least 0.85; and Cohen kappa at least 0.8. Missing labels, owner reviews, qualified traces, adjudication, or sample coverage keep criterion validity diagnostic-only.

Qualify the reference Observer without changing any trust root:

```bash
awb observer qualify --target <target-id> --suite <suite> --observer-id <observer-id> --observer-version <version> --observer-private-key </secure/observer-private.pem> --qualification-authority-private-key </secure/authority-private.pem> --out <qualification-dir>
```

For an independently observed live run, admit the signed trace with explicit Observer and qualification-authority Ed25519 public-key trust anchors:

```bash
awb ingest-trace --cases-dir <cases-dir> --suite <suite> --trace <workflow-trace.json> --trusted-observer-key <public.pem> --observer-qualification <qualification-dir>/observer-qualification.json --trusted-qualification-key <authority-public.pem> --out <run-dir>
awb compare --baseline <baseline-run> --candidate <candidate-run> --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <gate-dir>
```

Both private signing keys must remain outside the evaluated Runner, repository, artifacts, and logs, and the Observer and qualification authority must use different key pairs. The bundled reference Observer currently requires Darwin plus `/usr/bin/sandbox-exec`; it fails closed elsewhere. Its deny-default boundary actively proves signing-key reads, direct network, and nested process execution are denied with `EPERM`; Runner HOME/TMPDIR changes stay observable, and the signed trace output must be outside every Runner workspace. The qualification suite binds known-good/P0/blind-spot/repeat evidence to the exact Observer implementation, Contract, case set, canonical evaluation-contract content, and Schemas. AWB never enrolls either key automatically.

For a complete local evaluation workflow, the legacy one-shot command remains supported:

```bash
awb evaluate --target <target-id> --planner-runner codex --runner codex --coverage-mode full --execution live --out reports/evaluations/<target-id>
```

For fast local validation or CI smoke checks, use deterministic fixtures:

```bash
awb evaluate --target <target-id> --planner-runner fixture --runner simulated --coverage-mode smoke --out reports/evaluations/<target-id>-simulated
```

`evaluate` writes `profile/`, `ai-plan/`, `cases/`, `run/suite-result.json`, `run/report.md`, `run/harness-validation.json`, `run/recommendations.json`, `run/recommendations.md`, `run/p0-cases.json`, `run/p0-cases.md`, and `evaluation-summary.json`. P0 records can also be appended to a durable JSONL file with `--p0-case-log <path>`. Use `--mutation <mutation-yaml>` only with simulated execution to test whether P0 recording and recommendations trigger correctly.

The report is the benchmark diagnostic decision artifact for the evidence actually collected: it includes release decision, dimension scores, agent modification recommendations, harness validation, P0 case records, case results, and debug health. Treat it as a real workflow release gate only when the target runner/adapter emits trusted live `workflow_trace` events.

If you need manual control over each stage, use the step-by-step flow below.

1. Profile the target only to build the structural ContractModel:

```bash
awb profile --target <target-id> --out reports/profile/<target-id>
```

2. Ask the current runtime LLM to understand the workflow and generate benchmark cases:

```bash
awb plan-cases --target <target-id> --runner codex --coverage-mode smoke --out reports/ai-plans/<target-id>
```

Use `--runner claude` when running inside Claude Code. Use `--coverage-mode full` for broad workflow coverage and `--coverage-mode adaptive` when follow-up generation should target missing coverage. Inspect `ai-case-plan-validation.json`; it records recommended case count, coverage tags, missing targets, unknown tags, and invalid bindings. Do not treat a low-coverage plan as a full workflow benchmark. `--max-cases` is only a per-pass budget override.

3. Materialize executable cases from the AI plan:

```bash
awb materialize --target <target-id> --suite smoke --strategy ai --ai-plan reports/ai-plans/<target-id>/ai-case-plan.json --out cases/generated/<target-id>/ai-smoke
```

Materialization rejects invalid role, join, and artifact bindings.

4. Run and score:

```bash
awb run --cases-dir cases/generated/<target-id>/ai-smoke --runner codex --mode diagnostic --out reports/runs/<target-id>-ai
awb report --run reports/runs/<target-id>-ai --format md,json
awb score --run reports/runs/<target-id>-ai
```

For live runtime execution, add `--execution live`. Codex and Claude runners both have live adapters:

```bash
awb run --case <case-yaml> --runner codex --execution live --mode diagnostic --out reports/runs/<target-id>-live
awb run --case <case-yaml> --runner claude --execution live --mode diagnostic --out reports/runs/<target-id>-claude-live
```

## Self-debug flow

Run overlay-only mutation reverse validation after the main run. This is benchmark scorer/oracle self-debug and must use the simulated runner; it does not mutate the real target source and does not prove live Codex/Claude runner behavior.

```bash
awb gold-corpus validate --corpus fixtures/gold-corpus/v1/manifest.yaml
awb debug reverse-validate --corpus fixtures/gold-corpus/v1/manifest.yaml --runner simulated --out .benchmark-debug/gold-corpus
awb debug reverse-validate --target <target-id> --suite smoke --mutation-set fixtures/mutations/extended.yaml --runner simulated --suite-result reports/runs/<target-id>-ai/suite-result.json --out .benchmark-debug/<target-id>-mutations
awb debug diagnose --debug-run .benchmark-debug/<target-id>-mutations --out .benchmark-debug/<target-id>-mutations/diagnosis
awb debug propose-fix --dossier .benchmark-debug/<target-id>-mutations/diagnosis/debug-dossier.json --out .benchmark-debug/<target-id>-mutations/diagnosis/repair-plan.md
```

## Target onboarding

For a new directory-style agent workflow, generate a reviewable draft first:

```bash
awb init-target --agent-root <path-to-agent-workflow> --target-id <target-id> --out configs/targets/<target-id>.draft.yaml
```

Review the generated `.gaps.md` file with the workflow owner, produce a `contract-validity` artifact bound to the final `contractHash`, and set `contractReview.status: reviewed` with the artifact path/hash before registering it. Drafts remain schema-valid but non-gateable. The AI planner should generate cases from the reviewed Target ContractModel rather than from target-specific assumptions baked into the tool.
