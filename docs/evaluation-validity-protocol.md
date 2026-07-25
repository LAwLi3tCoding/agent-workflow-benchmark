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
environment fingerprints, and flaky quarantine. AWB implements this as a separate diagnostic
study over existing, provenance-validated baseline/candidate run pairs:

```bash
awb debug reliability \
  --study reliability-study.json \
  --out reports/reliability
```

The frozen policy requires five deterministic repeats or twenty live repeats, 100% deterministic
agreement, zero missing attempts, at least 95% gate and per-case consistency, at least 75%
telemetry completeness, no duplicated evidence or fixed-context drift, and zero P0 false PASS.
Live A/A additionally requires every validated comparison to be `UNCHANGED`. The report preserves
every requested attempt, publishes Wilson and deterministic seeded-bootstrap intervals, records
paired deltas and dimension variance, and sets `debugHealth.environmentReproducibility` to a
non-null value without changing target scores.

Each run receives a harness-generated attempt identity that is bound across the runtime manifest
and provenance. Reliability reports hash that identity and quarantine replayed attempts even if a
copied suite is renamed and its unsigned simulated digest is recomputed. This is diagnostic
replay detection for simulated evidence, not an Observer trust substitute: qualified live
attempt identity is derived from the signed workflow-trace hash.

Only qualified independent live `workflow_trace` samples can make a stable live study
`ELIGIBLE`; simulated studies remain `DIAGNOSTIC_ONLY` even when perfectly reproducible.
Deterministic fixture studies therefore use conclusion `DIAGNOSTIC_REPRODUCIBLE` with
`strongConclusionAllowed: false`; unsigned simulated artifacts cannot establish adversarial
sample independence.
Insufficient samples, missing evidence, unqualified/summary-only evidence, or telemetry gaps
refuse a strong conclusion. Unstable cases, repeated evidence, or context drift are quarantined
without deleting failures. Any P0 that is not blocked makes the study `INVALID` and gate
eligibility `BLOCK`.

## Observer Qualification

A signature proves origin and post-signing integrity, not observation completeness. A public key
is release-eligible only after a qualification artifact proves known-good acceptance, every P0
mutation detection, omission and ordering detection, forged-event rejection, key isolation,
filesystem/tool/process/network/token coverage, and repeated-run reproducibility.

AWB now emits an integrity-bound Observer qualification artifact signed by a
separate qualification authority. It binds the Observer identity, version,
public-key fingerprint, content-addressed implementation closure, evidence capabilities, Contract, case
set, evaluation-contract content hash, workflow-trace Schema, and qualification
suite. The bundled reference Observer uses a deny-default macOS Seatbelt
boundary and qualifies only after real signing-key-read, direct-network, and
nested-process canaries are denied with `EPERM`; a static negative marker is
not qualification evidence. Ingest, compare, and gate
must receive both explicit public trust anchors and revalidate the artifact.
Without it, signed traces carry `qualificationStatus: missing` and cannot
produce a real PASS. AWB never adds a public key to a trust root automatically,
and comparison normalizes self-asserted `valid` metadata without a verified
artifact back to `missing`.

The current bundled isolation backend is Darwin-only. Missing
`/usr/bin/sandbox-exec`, a non-Darwin host, a failed boundary probe, or reuse of
the Observer key as the qualification-authority key fails closed.

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

## Stage 4 Status

Proven for the harness: canonical vocabulary, contract hashing boundary, owner-review admission
boundary, deterministic hard-failure precedence, diagnostic evidence ceilings, content-hashed
Gold Corpus fixtures, split label isolation, 12-family good/bad/boundary coverage, P0 mutation
kill 100%, false PASS 0, no known-good block, and a Darwin reference Observer
whose independent authority-signed qualification covers all implemented P0
failures, active isolation canaries, forged events, wrong keys, stale
evaluation contracts, and repeated runs. Reliability studies now bind the
case set, contract, conditions, seed, runner, environment, Observer version,
model, permissions, and budgets; deterministic fixtures reproduce exactly,
and undersized or unstable studies fail closed.

Diagnostic only: signed but unqualified traces and all built-in live contract summaries.

Requires human input: criterion labels and production blocking authorization.

Deferred by protocol: calibration, external validity, CI canary, trends, and
adapter conformance.
