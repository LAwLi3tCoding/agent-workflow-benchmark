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
