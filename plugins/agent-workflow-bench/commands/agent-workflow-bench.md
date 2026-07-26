# Agent Workflow Bench

Use this command to run CI-grade regression testing for a coding-agent workflow from Claude Code. The canonical slash-command and plugin slug is `agent-workflow-bench`, and the CLI is `awb`.

Recommended gate pipeline: `doctor` -> matched baseline/candidate run -> `compare` -> `gate`.

```bash
awb doctor --target "$ARGUMENTS" --runner simulated --out reports/doctor/"$ARGUMENTS"
awb run --target "$ARGUMENTS" --target-root <baseline-checkout> --runner simulated --execution simulated --out reports/runs/"$ARGUMENTS"-baseline
awb run --target "$ARGUMENTS" --target-root <candidate-checkout> --runner simulated --execution simulated --out reports/runs/"$ARGUMENTS"-candidate
awb compare --baseline <baseline-run> --candidate <candidate-run> --out reports/comparisons/"$ARGUMENTS"
awb gate --comparison reports/comparisons/"$ARGUMENTS"/comparison-result.json --out reports/gates/"$ARGUMENTS"
```

For repeated-run reliability diagnostics, write a `reliability-study.json` with matched baseline/candidate pairs and run:

```bash
awb debug reliability --study <reliability-study.json> --out reports/reliability/"$ARGUMENTS"
```

Reliability reports preserve every requested attempt and quarantine unstable or duplicated evidence. Unsigned simulated repeats can only produce `DIAGNOSTIC_REPRODUCIBLE`; only stable qualified live `workflow_trace` studies can produce a strong `RELIABLE` conclusion and become gate-eligible.

For external criterion-validity diagnostics, generate a blinded package and analyze it only after external observations and independent human labels are present:

```bash
awb criterion-validity package --study <external-validity-study.yaml> --out reports/external-validity/"$ARGUMENTS"
awb criterion-validity analyze --study <external-validity-study.yaml> --observations <external-validity-observations.json> --labels <external-validity-human-labels.json> --trusted-observer-key <observer-public.pem> --trusted-qualification-key <qualification-authority-public.pem> --out reports/external-validity/"$ARGUMENTS"
```

The observation manifest contains comparison-bundle references and hashes, not trusted status claims. Analysis revalidates both signed traces, Observer qualification, comparison integrity, and study bindings with the explicit public keys. The bundled public fixture is an 8-item privacy-safe template, not production validity evidence. A real external-validity PASS requires the frozen 120-item study across directory/CLI/hybrid targets, Codex/Claude runners, four design strata, owner-reviewed contracts, qualified independent live `workflow_trace` observations, two independent blinded raters, adjudication, P0 recall 1.0, false PASS 0, overall agreement at least 0.85, and Cohen kappa at least 0.8. Until then the result remains pending or diagnostic-only.

The package also emits two isolated Agent-prelabel templates marked
`humanTruth: false`. They never count as human labels. Completed labels must
disclose Agent assistance and bind external confirmation evidence for both
human raters.

For gate-policy calibration, fit on development/calibration only, then validate holdout separately:

```bash
awb gate-policy calibrate --corpus fixtures/gold-corpus/v1/manifest.yaml --policy-version 1.0.0 --out reports/gate-policy/"$ARGUMENTS"/fit
awb gate-policy validate-holdout --corpus fixtures/gold-corpus/v1/manifest.yaml --policy reports/gate-policy/"$ARGUMENTS"/fit/gate-policy.json --calibration-report reports/gate-policy/"$ARGUMENTS"/fit/calibration-report.json --out reports/gate-policy/"$ARGUMENTS"/holdout
```

`calibrate` exits `2` with `PENDING_HOLDOUT`; it exits `1` without a policy when no candidate preserves P0 recall `1` and false PASS `0`. `validate-holdout` exits `0` for PASS and `1` for FAIL. Holdout stability is deterministic full-harness replay, not live-run reliability. Public Gold Corpus PASS is harness-diagnostic with `releaseEligible: false`; it is not production criterion-validity evidence and cannot authorize blocking gates.

Committed public synthetic evidence lives under `fixtures/calibration/v1/fit` and `fixtures/calibration/v1/holdout`; use it for harness/schema/policy regression checks only.

Gate exit codes are `0` for PASS, `2` for DIAGNOSTIC_ONLY, and `1` for BLOCK or tool/runtime failure. PASS requires a qualified independent live `workflow_trace`. Simulated runs, current live `contract-summary` adapters, and signed traces without a valid authority-signed qualification artifact are diagnostic-only.

Use `--gate-policy <gate-policy.json>` on `compare` and `gate` when recomputing previous artifacts. Missing or mismatched policy version, rules hash, or policy hash is incomparable. Deterministic hard failures continue to dominate calibrated scores.

For artifact compatibility, run:

```bash
awb artifact migrate --input <artifact.json> --out <migration-dir>
```

Use `--artifact-type <type>` for non-canonical filenames. The command writes
`migration-result.json` and, when safe, `migrated-artifact.json`; exits are `0`
for `CURRENT`/`MIGRATED`, `2` for `DIAGNOSTIC_ONLY`, and `1` for
`INCOMPATIBLE`. Migration never invents trust: missing Observer attestation,
policy hashes, integrity hashes, provenance bindings, runtime identity, or
conditions identity remain diagnostic-only.

Stage 10 Adapter conformance is implemented for the OpenCode Runner Adapter:

```bash
awb adapter conformance --adapter opencode --target <target-id> --adapter-executable "$(command -v opencode)" --out reports/adapters/<target-id>-opencode
```

The Adapter invokes `opencode run --format json --dir <sandbox-root>` and may
add `--model <provider/model>` when requested. It never adds `--auto`, `--yolo`,
`--dangerously-skip-permissions`, or equivalent automatic approval flags. The
contract requires native token evidence, stable error codes, bounded evidence,
canonical runner lifecycle events, and disabled automatic trust enrollment,
workflow modification, fix PR creation, and Runner access to Observer private
keys. Conformance `PASS` only means the Adapter contract and emitted `CaseRun`
are scorer-compatible; `adapter-conformance-report.json` always carries
`releaseDisposition: DIAGNOSTIC_ONLY` and cannot grant workflow PASS.

Stage 9 reporting keeps the legacy run renderer and adds evidence-bound
subcommands:

```bash
awb report --run <run-dir> --format md,json
awb report decision --comparison <comparison-result.json> --gate-result <gate-result.json> --out <decision-dir>
awb report trace-diff --mode baseline-candidate --baseline <baseline-workflow-trace.json> --candidate <candidate-workflow-trace.json> --out <trace-diff-dir>
awb report trace-diff --mode baseline-mutant-restore --baseline <baseline-workflow-trace.json> --mutant <mutant-workflow-trace.json> --restore <restore-workflow-trace.json> --out <trace-diff-dir>
awb report trend --input <trend-input.json> --out <trend-dir>
awb report viewer --decision <decision-report.json> --comparison <comparison-result.json> --trace-diff <trace-diff.json> --trend <trend-report.json> --out <viewer-dir>
```

`decision` revalidates the comparison and matching gate before writing; optional
reliability/validity inputs add supplied statistics only. `trace-diff` stores
event refs, source positions, and payload and actor hashes, not raw payloads or
actor ids; `verified_live`
requires trusted Observer and qualification evidence. `trend` splits
incompatible schema, policy, runner, conditions, contract, target, suite, and
observation eras. `viewer` reads already-redacted artifacts and writes static
read-only HTML with no remote assets, commands, gate mutation, artifact writes,
or unredacted trace reads.

Qualify the reference Observer first. This writes evidence and an integrity-bound artifact but never changes a trust root:

```bash
awb observer qualify --target <target-id> --suite smoke --observer-id <observer-id> --observer-version <version> --observer-private-key </secure/observer-private.pem> --qualification-authority-private-key </secure/authority-private.pem> --out <qualification-dir>
```

For a release-grade externally observed run, ingest the Ed25519-signed trace and pass both explicit public trust anchors to comparison and gate:

```bash
awb ingest-trace --cases-dir <cases-dir> --suite smoke --trace <workflow-trace.json> --trusted-observer-key <public.pem> --observer-qualification <qualification-dir>/observer-qualification.json --trusted-qualification-key <authority-public.pem> --out <run-dir>
awb compare --baseline <baseline-run> --candidate <candidate-run> --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --trusted-observer-key <public.pem> --trusted-qualification-key <authority-public.pem> --out <gate-dir>
```

Never make either private key available to the evaluated Runner, repository, artifacts, or logs, and never reuse the Observer key as the qualification-authority key. The bundled reference Observer currently requires Darwin plus `/usr/bin/sandbox-exec`. Its deny-default boundary actively verifies that signing-key reads, direct network, and undeclared nested processes fail with `EPERM`; unsupported isolation fails closed. The qualification suite covers known-good, every P0 mutation, omission/order/forgery, wrong key, private-key leakage, tool/network blind spots, repeats, and the canonical evaluation-contract content hash. Never auto-enroll either public key.

For GitHub CI, this repository runs `.github/workflows/ci.yml`: `git diff
--check`, typecheck, full tests, plugin build, runtime parity, schema
validation, canonical naming scan, privacy scan, and fresh-install smoke.
External callers can copy or call
`.github/workflows/awb-external-observe-only.yml` for observe-only
baseline/candidate checks. PASS, DIAGNOSTIC_ONLY, and BLOCK are recorded, not
enforced, by that template; AWB execution or artifact-write failures still fail
closed. Redacted summary upload is explicit opt-in with short retention.

Production CI assessment uses:

```bash
awb ci evaluate-canary --samples <samples.json> --isolation-manifest <manifest.json> --gate-policy <gate-policy.json> --out <canary-dir>
awb ci assess --gate-result <gate-result.json> --runtime-manifest <runtime-manifest.json> --provenance <provenance.json> --isolation-manifest <manifest.json> --canary-report <production-canary-report.json> --out <assessment-dir>
awb ci prepare-authorization --gate-result <gate-result.json> --runtime-manifest <runtime-manifest.json> --provenance <provenance.json> --isolation-manifest <manifest.json> --canary-report <production-canary-report.json> --authorized-by authority://workflow-owner --expires-at <ISO-8601-UTC> --authority-public-key <authorization-public.pem> --out <request-dir>
awb ci finalize-authorization --request <request-dir>/production-blocking-authorization-request.json --signature <signature.base64> --trusted-authorization-key <authorization-public.pem> --out <authorization-dir>
awb ci benchmark-health --input <benchmark-health-input.json> --out <benchmark-health-dir>
```

The frozen canary policy requires at least 30 observe-only samples, false
positive rate <= 0.02, false negative rate 0, flaky rate <= 0.05, runtime p95
<= 900 seconds, and cost p95 <= 10 USD. False-positive and false-negative
rates use known-good and known-bad denominators respectively; both classes are
required, and `sampleSetHash` binds the full sample set.

`benchmark-health` aggregates Gold Corpus, P0 mutation, Observer
qualification, A/A reliability, schema compatibility, plugin install, and
privacy evidence for the AWB version. Any P0 false negative, false PASS,
invalid Observer qualification, schema incompatibility, missing check, plugin
install failure, privacy finding, or failed reliability check sets
`versionDisposition: DIAGNOSTIC_ONLY`. It records automatic trust enrollment,
workflow modification, and fix PR creation as disabled.

Rank runners only with exact comparable bindings:

```bash
awb report runner-ranking --input <runner-ranking-input.json> --out <runner-ranking-dir>
```

Ranking requires the same task, target contract, case set, qualified Observer,
budget, live `workflow_trace` telemetry, native token source, and comparable
workflowScore, efficiency, and tokenCost axes. Otherwise the report is
`INCOMPARABLE` and has no gate effect.

Do not enable production blocking from this slash command alone. Blocking
requires explicit workflow-owner authorization, a qualified independent live
Observer, caller-provided `linux_container` or `strong_sandbox` isolation
evidence, separate public trust anchors, denied or allowlisted network,
read-only target input, controlled tool proxying, and redacted artifact
retention. The authorization signature binds gate, runtime manifest,
provenance, isolation, canary, and gate-policy hashes. AWB validates supplied
isolation evidence; it does not provide a Linux isolation backend.

Agents may run every safe preparation and verification step, but the workflow
owner must confirm the contract, two humans must confirm the blinded labels and
adjudications, and the production authority must sign externally. The
authorization preparation and finalization commands accept only the public key;
the private key remains outside AWB, the Runner, repository, artifacts, and
logs.

Legacy compatible pipeline: `evaluate` for the complete flow, or `plan-cases` -> inspect `ai-case-plan-validation.json` -> `materialize --strategy ai` -> `run --execution live` when you need manual stage control.

Preferred complete run:

```bash
awb evaluate --target "$ARGUMENTS" --planner-runner claude --runner claude --coverage-mode full --execution live --out reports/evaluations/"$ARGUMENTS"-claude-ai
```

This writes profile, AI plan, cases, `run/suite-result.json`, `run/report.md`, `run/harness-validation.json`, `run/recommendations.json`, `run/recommendations.md`, `run/p0-cases.json`, `run/p0-cases.md`, and `evaluation-summary.json`. The report includes dimension scores, agent modification recommendations, harness validation, and P0 case records.

Use the manual flow below only when you need to inspect or replace an intermediate artifact.

1. Build an AI case plan with Claude Code:

```bash
awb plan-cases --target "$ARGUMENTS" --runner claude --coverage-mode full --out reports/ai-plans/"$ARGUMENTS"
```

The plan must include `workflowUnderstanding`, `coverageTags`, and `scoringRubric`; coverage gaps are written to `ai-case-plan-validation.json`. Use `--max-cases` only to override the per-pass budget.

2. Materialize executable cases from that AI plan:

```bash
awb materialize --target "$ARGUMENTS" --suite smoke --strategy ai --ai-plan reports/ai-plans/"$ARGUMENTS"/ai-case-plan.json --out cases/generated/"$ARGUMENTS"/ai-smoke
```

3. Run the benchmark through Claude Code live execution:

```bash
awb run --cases-dir cases/generated/"$ARGUMENTS"/ai-smoke --runner claude --execution live --mode diagnostic --out reports/runs/"$ARGUMENTS"-claude-ai
```

For a single case with a live adapter:

```bash
awb run --case cases/generated/"$ARGUMENTS"/ai-smoke/<case>.yaml --runner claude --execution live --mode diagnostic --out reports/runs/"$ARGUMENTS"-claude-live
```

4. Generate the report:

```bash
awb report --run reports/runs/"$ARGUMENTS"-claude-ai --format md,json
awb score --run reports/runs/"$ARGUMENTS"-claude-ai
```

5. For benchmark self-debug, run overlay-only mutation reverse validation. This path validates benchmark scorer/oracle behavior and must use the simulated runner; it is not a live Claude/Codex runner check:

```bash
awb gold-corpus validate --corpus fixtures/gold-corpus/v1/manifest.yaml
awb debug reverse-validate --corpus fixtures/gold-corpus/v1/manifest.yaml --runner simulated --out .benchmark-debug/gold-corpus
awb debug reverse-validate --target "$ARGUMENTS" --suite smoke --mutation-set fixtures/mutations/extended.yaml --runner simulated --suite-result reports/runs/"$ARGUMENTS"-claude-ai/suite-result.json --out .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations
awb debug diagnose --debug-run .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations --out .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations/diagnosis
```
