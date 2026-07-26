# Evaluation Contract Traceability

The canonical machine source is
`configs/evaluation/evaluation-contract.yaml`. This table is the human-readable view of its
implemented claims. A claim is current only when its registry status is `implemented`; backlog
rows are not product capability claims.

| Claim | Contract field | Case | Event | Oracle | Score or gate | Executable evidence |
| --- | --- | --- | --- | --- | --- | --- |
| contract-identity | entrypoints, roles, statuses, owners, routes, joins, artifacts, states, budgets, command policy | static-contract | case_start, contract_observed | oracle-static-contract | contract, GATE-INCOMPARABLE | tests/profile.test.ts; tests/target-onboarding.test.ts |
| forbidden-route | routing.forbidden | forbidden-route | handoff, hard_failure | oracle-forbidden-route | routing, GATE-HARD-FAILURE | tests/run-score.test.ts; tests/compare.test.ts |
| owner-routing | requiredOwners, roles.ownerScopes | required-owner, role-boundary | handoff, hard_failure | oracle-required-owner, oracle-role-boundary | ownership, GATE-HARD-FAILURE | tests/run-score.test.ts |
| gate-status | statuses | skip-not-pass | gate_decision, hard_failure | oracle-skip-not-pass | gate, GATE-HARD-FAILURE | tests/run-score.test.ts |
| artifact-path | artifacts | static-contract | artifact_write, hard_failure | oracle-static-contract | artifact, GATE-HARD-FAILURE | tests/run-score.test.ts |
| required-join | joins | required-join | handoff, artifact_write, hard_failure | oracle-required-join | join, GATE-HARD-FAILURE | tests/debug.test.ts; tests/run-score.test.ts |
| state-recovery | states | state-recovery | state_read | oracle-state-recovery | state, GATE-CANDIDATE-DIAGNOSTIC | tests/run-score.test.ts |
| side-effect-policy | commandPolicy | side-effect-deny | side_effect_attempt, hard_failure | oracle-side-effect-deny | sideEffect, GATE-HARD-FAILURE | tests/run-score.test.ts; tests/workflow-trace.test.ts |
| telemetry-evidence | budgets | efficiency-token | token_usage, runner_exit, case_end | oracle-efficiency-token | telemetry, runner, GATE-CANDIDATE-DIAGNOSTIC | tests/run-score.test.ts; tests/runner-capabilities.test.ts |
| budget-efficiency | budgets | efficiency-token | token_usage | oracle-efficiency-token | efficiency, GATE-CANDIDATE-BELOW-PASS | tests/run-score.test.ts |
| provenance-integrity | entrypoints, commandPolicy, budgets | static-contract | contract_observed, runner_result | oracle-static-contract | contract, GATE-COMPARISON-INTEGRITY | tests/compare.test.ts; tests/workflow-trace.test.ts |
| evidence-trust-ceiling | entrypoints, commandPolicy | static-contract | runner_start, runner_result | oracle-static-contract | runner, GATE-EVIDENCE-NOT-WORKFLOW-TRACE, GATE-OBSERVER-UNQUALIFIED | tests/run-score.test.ts; tests/live-runner.test.ts; tests/workflow-trace.test.ts; tests/compare.test.ts |
| gold-corpus-detection | roles, owners, routes, joins, artifacts, states, statuses, budgets, command policy | static-contract, forbidden-route, required-owner, skip-not-pass, required-join, side-effect-deny, efficiency-token | lifecycle, handoff, artifact, state, gate, side-effect, token events | canonical deterministic oracles | contract and affected dimensions, GATE-HARD-FAILURE | tests/gold-corpus.test.ts; tests/gold-corpus-cli.test.ts |
| observer-qualification | entrypoints, commandPolicy | static-contract | filesystem_access, tool_call, process_spawn, network_access, artifact_write, state_read, side_effect_attempt, token_usage | oracle-static-contract | runner, telemetry, GATE-PASS | tests/reference-observer.test.ts; tests/observer-qualification.test.ts; tests/workflow-trace.test.ts |
| reliability-statistics | budgets, commandPolicy | static-contract | runner_start, runner_result, case_end | oracle-static-contract | telemetry, runner, GATE-INCOMPARABLE, GATE-EVIDENCE-NOT-WORKFLOW-TRACE, GATE-PASS | tests/reliability.test.ts; tests/reliability-statistics.test.ts; tests/reliability-evidence-boundary.test.ts; tests/reliability-schema.test.ts |
| external-criterion-validity-mechanism | criterionValidityPolicy | directory, cli, hybrid external study items | cryptographically reverified workflow_trace comparison bundles, blinded labels, adjudications | owner-reviewed reference label comparison | validity status, confusion matrix, P0 recall, false PASS, exact agreement, Cohen kappa | tests/external-validity.test.ts; tests/external-validity-verified.test.ts; tests/external-validity-comparison-evidence.test.ts; tests/external-validity-schema.test.ts; tests/external-validity-cli.test.ts |
| calibrated-score-gate | gatePolicy | static-contract, Gold Corpus development/calibration/holdout cases | lifecycle, handoff, artifact, state, gate, side-effect, token events | canonical deterministic oracles and frozen holdout metrics | gate-policy binding, GATE-POLICY-INCOMPARABLE, calibrated thresholds | tests/calibration-policy.test.ts; tests/calibration-schema.test.ts; tests/gate-policy-versioning.test.ts; tests/stage6-gate.test.ts; tests/calibration-cli.test.ts |
| adapter-conformance | Adapter contract, runner capability, evidence limits, safety controls | static-contract conformance fixture | case_start, runner_start, runner_transcript, runner_result, runner_exit, token_usage, case_end | adapter contract validation, event order, native token evidence, referenced-file bounds, scorer compatibility | adapter `PASS` or `FAIL`; releaseDisposition `DIAGNOSTIC_ONLY` only | tests/stage10-adapter-sdk.test.ts; tests/stage10-cli-schema.test.ts |
| opencode-live-adapter | Adapter contract, runner capability, token source detail | static-contract conformance fixture | runner_start, runner_transcript, runner_result, runner_exit, token_usage | OpenCode JSONL parse, deduplicated `step_finish` native-token sum, final structured result, stable adapter errors | runner case result only; suite remains GATE-EVIDENCE-CONTRACT-SUMMARY / diagnostic without qualified workflow_trace | tests/stage10-adapter-sdk.test.ts; tests/stage10-cli-schema.test.ts |
| benchmark-health | Gold Corpus, P0 mutation, Observer qualification, A/A reliability, schema compatibility, plugin install, privacy scan evidence refs | periodic benchmark health input | referenced evidence hashes | health aggregation, macOS qualification workflow, public command-evidence redaction, and fail-closed version disposition | `RELEASE_ELIGIBLE` or automatic `DIAGNOSTIC_ONLY` disposition | tests/stage10-benchmark-health.test.ts; tests/stage10-health-workflow.test.ts; tests/stage10-cli-schema.test.ts |
| cross-runner-ranking | exact task, target contract, case set, qualified Observer, budget, live workflow_trace telemetry, native token source, comparable axes | runner ranking input | referenced run metrics and binding hashes | strict comparability fingerprint and axis checks | `RANKED` or `INCOMPARABLE`; no workflow gate effect | tests/stage10-runner-ranking.test.ts; tests/stage10-cli-schema.test.ts |

## Backlog boundary

External criterion validity tooling is implemented as a packaging and analysis mechanism, not as
an established production-validity claim. The public fixture is an 8-item privacy-safe template
and remains `pending_human_input`; a PASS requires the frozen 120-item reviewed external study,
qualified Codex and Claude live traces, two independent blinded raters, adjudication, P0 recall
1.0, false PASS 0, overall agreement at least 0.85, and Cohen kappa at least 0.8.

Calibrated policy mechanics are implemented for the public synthetic Gold Corpus, including
development/calibration-only fitting, holdout validation, policy version/hash binding, and
incomparable-result handling. The committed evidence lives under `fixtures/calibration/v1/fit`
and `fixtures/calibration/v1/holdout`. That PASS remains harness-diagnostic and
`releaseEligible: false`.
Trend analysis, adapter conformance, OpenCode live adapter execution, benchmark-health
aggregation, and cross-runner ranking are implemented mechanisms. They do not raise the
workflow evidence ceiling: adapter conformance is always `DIAGNOSTIC_ONLY`, OpenCode live
runs remain diagnostic until admitted through qualified independent `workflow_trace`
evidence, benchmark health can only make the AWB version `RELEASE_ELIGIBLE` or
`DIAGNOSTIC_ONLY`, and runner ranking has no gate authority.

Reliability statistics are implemented, but deterministic or unqualified studies remain
`DIAGNOSTIC_ONLY`; only stable qualified independent live `workflow_trace` samples can become
gate-eligible.

Automatic trust enrollment, target workflow modification, and fix pull request creation are
not implemented release actions. Stage 10 health and adapter artifacts explicitly record those
actions as disabled.
