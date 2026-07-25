# Evaluation Validity Protocol

This protocol defines what Agent Workflow Bench must prove before its output can be used as a
production CI admission decision. It separates current deterministic contract checks from later
empirical validation. Missing proof never becomes PASS.

## Construct Validity

The construct is contract-faithful workflow execution: declared entrypoints, owners, routes,
joins, artifacts, states, statuses, budgets, command policy, evidence provenance, and observer
independence. The canonical definitions and claim mappings live in
`configs/evaluation/evaluation-contract.yaml`.

Proof method: every implemented construct has a ContractModel field, executable case, normalized
event, oracle, score or gate consumer, and regression test. Failure condition: a current claim
has no complete traceability row, two runtime modules assign different meanings to one code, or
an unregistered hard-failure code influences the result.

## Content Validity

Required coverage targets are derived from the reviewed ContractModel and every implemented
generic oracle is materialized. Stage 2 adds a versioned Gold Corpus with independent labels for
known-good, known-bad, and boundary trajectories across every registered P0/P1 failure family.
The corpus proves detector content coverage for synthetic fixtures; it does not prove external
criterion validity or live-runner behavior.

Threshold: every required target is covered or carries a typed exemption, every required failure
family has all three controls, P0 mutation kill is 100%, false PASS is 0, and known-good controls
are not blocked. Failure condition: an uncovered target, missing control, unknown binding,
target-specific private data, label leakage, or a backlog oracle presented as implemented.

## Criterion Validity

Criterion validity compares AWB decisions with labels produced independently by workflow owners
and reviewers. It is not established in Stage 1. Until Stage 5 supplies blinded labels,
confusion matrices, P0 precision/recall, overall agreement, and inter-rater agreement, criterion
validity is `pending_human_input` and results remain diagnostic for this claim.

Suggested acceptance threshold: P0 recall 100%, false PASS 0, overall agreement at the frozen
protocol threshold, and Cohen kappa at least 0.8. Failure condition: missing labels, leaked
holdout labels, unresolved adjudication, or any false PASS.

## Reliability

Reliability requires deterministic replay, repeated live runs, A/A checks, variance analysis,
environment fingerprints, and flaky quarantine. It is not established in Stage 1.

Planned threshold: deterministic fixtures agree 100%, P0 false PASS is 0, and stable live cases
have at least 95% gate agreement with adequate sample size. Failure condition: insufficient
sample size, non-reproducible deterministic fixtures, unstable cases outside quarantine, or
missing environment reproducibility evidence.

## Observer Qualification

A signature proves origin and post-signing integrity, not observation completeness. A public key
is release-eligible only after a qualification artifact proves known-good acceptance, every P0
mutation detection, omission and ordering detection, forged-event rejection, key isolation,
filesystem/tool/process/network/token coverage, and repeated-run reproducibility.

Stage 1 has no qualified Observer. Therefore signed workflow traces are admitted for diagnostics
but carry `qualificationStatus: missing`; they cannot produce a real PASS. AWB never adds a
public key to a trust root automatically, and Stage 1 comparison normalizes any self-asserted
`valid` status in editable run metadata back to `missing`.

## Bias and Leakage Control

Development, calibration, and holdout data must remain separate. Holdout labels must not enter
planner prompts, generated cases, calibration code, or repair context. Real target identities,
private paths, roles, business contracts, traces, credentials, and personal data must remain
outside the public repository.

Failure condition: label leakage, target-specific private data in a public artifact, unredacted
signed evidence, reviewer/runner identity coupling, or calibration performed on holdout labels.

## Thresholds

Deterministic P0 hard failures dominate scores and AI judgments. Current evidence ceilings are:

| Evidence | Maximum decision |
| --- | --- |
| simulated or synthetic events | DIAGNOSTIC_ONLY |
| capability-only or missing evidence | DIAGNOSTIC_ONLY |
| built-in Codex/Claude contract summary | DIAGNOSTIC_ONLY |
| signed workflow trace without valid Observer qualification | DIAGNOSTIC_ONLY |
| qualified independent signed workflow trace | eligible for PASS after all other gates |

Later empirical thresholds are frozen in their versioned protocol/policy artifacts before
holdout evaluation. A sample below its required size cannot support a strong conclusion.

## Failure Conditions

The validity claim fails closed when provenance is invalid, evidence is missing, Observer
qualification is missing or invalid, P0 evidence exists, privacy or isolation policy is
violated, holdout leakage occurs, deterministic replay diverges, or a required schema cannot be
validated. AI semantic judgment and aggregate scores cannot override any of these conditions.

## Stage 2 Status

Proven for the harness: canonical vocabulary, contract hashing boundary, owner-review admission
boundary, deterministic hard-failure precedence, diagnostic evidence ceilings, content-hashed
Gold Corpus fixtures, split label isolation, 12-family good/bad/boundary coverage, P0 mutation
kill 100%, false PASS 0, and no known-good block.

Diagnostic only: signed but unqualified traces and all built-in live contract summaries.

Requires human input: criterion labels and production blocking authorization.

Deferred by protocol: Observer qualification, statistical reliability, calibration, external
validity, CI canary, trends, and adapter conformance.
