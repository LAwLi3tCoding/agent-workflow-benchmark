# Gate Policy Calibration

Agent Workflow Bench uses a versioned `gate-policy.json` to keep scoring and CI gate
decisions recomputable. The policy records dimension weights, score thresholds, telemetry
requirements, budget thresholds, classification deltas, hard-failure precedence, and the
Gold Corpus splits used for calibration.

The current public policy is `configs/evaluation/gate-policy.json`. It is calibrated from
the public synthetic Gold Corpus and has `releaseEligible: false` in its calibration report.
It validates AWB's harness behavior; it does not authorize production blocking for real
workflows.

Committed public diagnostic evidence lives under `fixtures/calibration/v1/`:

- `fixtures/calibration/v1/fit/gate-policy.json`
- `fixtures/calibration/v1/fit/calibration-report.json`
- `fixtures/calibration/v1/fit/calibration-report.md`
- `fixtures/calibration/v1/holdout/calibration-report.json`
- `fixtures/calibration/v1/holdout/calibration-report.md`

These fixtures are synthetic harness diagnostics. They are useful for schema, CLI, and
policy-regression checks, but they are not production validity evidence.

## Fit Without Holdout

Fit candidates with only development and calibration data:

```bash
awb gate-policy calibrate \
  --corpus fixtures/gold-corpus/v1/manifest.yaml \
  --policy-version 1.1.0 \
  --out reports/gate-policy/v1/fit
```

This writes:

- `gate-policy.json`
- `calibration-report.json`
- `calibration-report.md`

Expected exit code: `2`. The fit report is intentionally `PENDING_HOLDOUT`
because holdout labels are not loaded during calibration.

The fit step rejects duplicate benchmark cases or duplicate sample evidence. It records
`holdoutExcludedFromFit: true`, hashes the development and calibration splits, and binds
the policy to the Gold Corpus manifest, labels, trajectories, and sample hash. If every
candidate misses a P0 or produces a false PASS, calibration exits `1` and emits no policy.

## Validate Unseen Holdout

Validate the frozen policy against the separately loaded holdout split:

```bash
awb gate-policy validate-holdout \
  --corpus fixtures/gold-corpus/v1/manifest.yaml \
  --policy reports/gate-policy/v1/fit/gate-policy.json \
  --calibration-report reports/gate-policy/v1/fit/calibration-report.json \
  --out reports/gate-policy/v1/holdout
```

Expected exit codes:

| Exit code | Meaning |
| ---: | --- |
| `0` | Holdout status is `PASS` |
| `1` | Holdout status is `FAIL` |
| `2` | Fit status is still `PENDING_HOLDOUT` |

Holdout validation rechecks the untampered fit report, policy hash, rules hash, data
boundary, and corpus manifest hash before scoring the holdout. If the report was edited,
the policy changed, or the corpus no longer matches the frozen fit evidence, validation
fails instead of silently recomputing a new policy.

The stability field is explicitly scoped to `deterministic_harness_replay`. Each repeat
reruns the full public trajectory materialization, detector, and scoring path. It does not
measure live Runner or Observer stability; that requires the separate reliability study.

## Candidate Selection

Calibration evaluates bounded candidates on development/calibration data only:

- `canonical-baseline`
- `evidence-weighted-dimensions`
- `safety-bounded-thresholds`

Selection is deterministic: require P0 recall `1` and false PASS `0`, then maximize
overall agreement, then Cohen kappa, then prefer the simpler canonical baseline on ties.
If no candidate satisfies both safety invariants, calibration fails closed. Candidate data
is hashed into the report.

The report shows dimension-level evidence instead of relying on one generic score:

- current dimension weight
- support count
- safe and risk mean scores
- paired effect
- bootstrap interval
- support status

Threshold evidence includes case and suite score thresholds, P0/P1 score caps, telemetry
minimum completeness, token and wall-clock budget ratios, wasted-token warning ratio, and
minimum meaningful score delta. The public synthetic corpus reports support for these
fields but does not independently prove a superior telemetry or budget setting; tied
candidates retain the canonical baseline.

## Gate Comparability

`suite-result.json`, `comparison-result.json`, and `gate-result.json` carry a gate-policy
binding:

- `policyId`
- `policyVersion`
- `rulesHash`
- `policyHash`

Use the same policy when recomputing historical comparisons or gates:

```bash
awb compare \
  --baseline reports/regression/baseline \
  --candidate reports/regression/candidate \
  --gate-policy configs/evaluation/gate-policy.json \
  --out reports/regression/comparison

awb gate \
  --comparison reports/regression/comparison/comparison-result.json \
  --gate-policy configs/evaluation/gate-policy.json \
  --out reports/regression/gate
```

If the selected policy is missing or its version/hash/rules binding does not match the run
or comparison artifacts, AWB marks the result incomparable. A rule change must bump
`policyVersion`; changing rules under the same version is rejected.

## Trust Boundary

Hard failures continue to dominate calibrated scores. AI semantic judgment and aggregate
score cannot override P0 evidence, invalid provenance, missing evidence, Observer
qualification failure, sensitive leakage, or safety policy violations.

The public synthetic Gold Corpus is useful for calibration mechanics and detector
regression, but its holdout PASS is only harness-diagnostic. A real production CI PASS
still requires qualified independent signed live `workflow_trace` evidence, owner-reviewed
real target contracts, completed human labels/adjudication for external criterion validity,
and explicit production-blocking authorization.
