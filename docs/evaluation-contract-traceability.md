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

## Backlog boundary

Observer qualification, reliability thresholds, external
criterion validity, calibrated policy performance, trend analysis, and adapter conformance are
not Stage 1 product claims. Their registry or protocol status remains backlog or
`DIAGNOSTIC_ONLY` until the later stage acceptance evidence exists.
