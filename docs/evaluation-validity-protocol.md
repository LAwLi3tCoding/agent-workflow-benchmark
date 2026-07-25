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
and reviewers. Stage 5 adds the external validity packaging and analysis mechanism, but it does
not establish real external validity by itself. The public repository includes only a
privacy-safe 8-item template at `fixtures/external-validity/v1/study.yaml`; it is intentionally
below the frozen sample threshold and carries `pending_human_input` owner-review status.

The frozen protocol requires directory, CLI, and hybrid targets across Codex and Claude, with
four design strata: known improvement, no change, ordinary regression, and P0 regression. The
minimum sample is 5 items for each of the 24 target-class / runner / stratum cells, for 120
items total. Each item must have an owner-reviewed external contract, qualified independent
Codex or Claude live `workflow_trace` evidence, two independent blinded human ratings, and
adjudication for disagreements.

Use the criterion-validity workflow to create a blinded labeling package and analyze the
completed study:

```bash
awb criterion-validity package \
  --study fixtures/external-validity/v1/study.yaml \
  --out reports/external-validity/v1

awb criterion-validity analyze \
  --study fixtures/external-validity/v1/study.yaml \
  --observations <external-validity-observations.json> \
  --labels <external-validity-human-labels.json> \
  --trusted-observer-key <observer-public.pem> \
  --trusted-qualification-key <qualification-authority-public.pem> \
  --out reports/external-validity/v1
```

Acceptance threshold: P0 recall 100%, false PASS 0, overall agreement at least 0.85, and
Cohen kappa at least 0.8. Missing labels, missing owner reviews, incomplete 120-item coverage,
unqualified or summary-only evidence, unresolved adjudication, leaked private data, duplicate
evidence, unknown hard-failure codes, or any false PASS keep the report `PENDING_HUMAN_INPUT`,
`INSUFFICIENT_EVIDENCE`, or `FAIL` instead of PASS. Criterion validity remains diagnostic-only
until those thresholds pass on qualified external evidence. Observation manifests contain
references and content hashes for AWB comparison bundles, not self-asserted trust flags;
`analyze` reopens each bundle, verifies both signed traces and authority-signed Observer
qualification against explicit public keys, recomputes the gate, and binds target, contract,
runner, baseline, and candidate identities before counting the sample.

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

## Score and Gate Calibration

Gate policy calibration uses only development and calibration Gold Corpus splits to
evaluate bounded candidates for dimension weights, telemetry thresholds, budget thresholds,
and classification rules. A candidate is eligible only with P0 recall `1` and false PASS
`0`; if none qualifies, fitting fails without emitting a policy. The holdout split is loaded
only by the separate validation command. Fit reports must carry
`holdoutExcludedFromFit: true`; holdout labels must not enter planner prompts, repair
context, candidate selection, or policy fitting.

Use the calibration workflow:

```bash
awb gate-policy calibrate \
  --corpus fixtures/gold-corpus/v1/manifest.yaml \
  --policy-version 1.0.0 \
  --out reports/gate-policy/v1/fit

awb gate-policy validate-holdout \
  --corpus fixtures/gold-corpus/v1/manifest.yaml \
  --policy reports/gate-policy/v1/fit/gate-policy.json \
  --calibration-report reports/gate-policy/v1/fit/calibration-report.json \
  --out reports/gate-policy/v1/holdout
```

`calibrate` exits `2` with `PENDING_HOLDOUT`. `validate-holdout` exits `0` for PASS and
`1` for FAIL. Both commands emit machine-readable JSON and Markdown. Reports prioritize
dimension evidence, paired effects, bootstrap intervals, telemetry support, budget support,
candidate selection, and policy hashes rather than a single aggregate score.
Telemetry and budget support in the public synthetic corpus is descriptive; it does not
independently establish a safely superior threshold, and tied candidates retain the
canonical baseline.

The committed public synthetic evidence is
`fixtures/calibration/v1/fit/{gate-policy.json,calibration-report.json,calibration-report.md}`
and `fixtures/calibration/v1/holdout/{calibration-report.json,calibration-report.md}`. It is
harness-diagnostic evidence only and records `releaseEligible: false`.

Acceptance threshold on holdout: P0 recall 100%, false PASS 0, overall agreement at least
0.85, Cohen kappa at least 0.8, and gate-decision stability at least 95%. Any missing,
tampered, or mismatched fit report, corpus hash, policy hash, rules hash, data boundary, or
policy version fails closed.

The holdout stability metric is scoped to `deterministic_harness_replay` and repeats the
full synthetic trajectory materialization, detector, and scoring path. It is not evidence
of live Runner or Observer stability; live stability remains governed by the reliability
study.

Rule changes require a `policyVersion` change. Historical runs are recomputable only when
their `policyId`, `policyVersion`, `rulesHash`, and `policyHash` match the selected policy;
otherwise compare/gate results are explicitly incomparable. Deterministic hard failures
continue to dominate calibrated scores.

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

Empirical thresholds are frozen in their versioned protocol/policy artifacts before holdout
evaluation. A sample below its required size cannot support a strong conclusion.

## Failure Conditions

The validity claim fails closed when provenance is invalid, evidence is missing, Observer
qualification is missing or invalid, P0 evidence exists, privacy or isolation policy is
violated, holdout leakage occurs, deterministic replay diverges, or a required schema cannot be
validated. AI semantic judgment and aggregate scores cannot override any of these conditions.

## Production CI and Safety Isolation

Repository CI must prove the tool can reproduce itself before any external
workflow result is trusted: diff hygiene, typecheck, full tests, plugin build,
runtime parity, schema validation, naming scan, privacy scan, and fresh plugin
install smoke all run as independent checks.

The reusable external workflow template is observe-only. It may compare and
gate a caller-owned baseline/candidate pair, but PASS, DIAGNOSTIC_ONLY, and
BLOCK are recorded rather than enforced. The template fails closed only when AWB
cannot run, validate, compare, or write its gate artifact. Redacted summary
upload is disabled by default and uses short retention when explicitly enabled.

`awb ci evaluate-canary` builds an observe-only production canary report against
the frozen policy: minimum sample count `30`, max false-positive rate `0.02`,
max false-negative rate `0`, max flaky rate `0.05`, max runtime p95 `900`
seconds, and max cost p95 `10` USD. Error rates use their expected-class
denominators, both known-good and known-bad classes are required, and
`sampleSetHash` binds all inputs. `awb ci assess` combines the evidence gate,
runtime manifest, provenance, caller-supplied isolation manifest, canary report,
and optional signed blocking authorization. Production blocking is a separate
authorization decision and requires a qualified independent Observer, explicit
public trust anchors, caller-provided strong Runner isolation, redacted artifact
retention, and workflow-owner approval. Its signature binds gate, runtime,
provenance, isolation, canary, and gate-policy hashes. Missing isolation, missing Observer
qualification, failed canary thresholds, or absent approval keeps the result
diagnostic-only. AWB validates isolation evidence; it does not provide or claim
its own Linux isolation backend.

## Stage 8 Status

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

Implemented mechanism: external validity study/package/observation/label/report schemas,
blinded labeling package generation, human-label/adjudication analysis, confusion matrix,
P0 precision/recall, false-PASS counting, exact agreement, Cohen kappa, public-ref privacy
checks, cryptographic comparison-bundle revalidation, policy/input-bound report hashes, the
criterion-validity CLI surface, versioned gate-policy artifacts, calibration reports,
development/calibration-only fitting, holdout-only validation, policy-bound suite/comparison/gate
artifacts, and policy mismatch incomparability.

Diagnostic only: signed but unqualified traces and all built-in live contract summaries.
Public Gold Corpus policy PASS is also harness-diagnostic and records `releaseEligible: false`;
it does not establish production criterion validity.

Requires human input before an external-validity PASS: a completed 120-item private study with
owner-reviewed real external contracts (the public template is 112 items short and is not
evidence), qualified independent Codex and Claude live traces, two-rater labels, adjudication for
disagreements, and production blocking authorization.

Implemented mechanism through Stage 8: repository CI definition, observe-only
external workflow template, production-blocking authorization guardrails, and
privacy-safe CI documentation.

Deferred by protocol: canary evidence, trends, and adapter conformance.
