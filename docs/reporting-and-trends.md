# Reporting and Trends

Stage 9 adds evidence-bound reporting commands under `awb report` while preserving
the legacy run renderer.

## Command Summary

| Command | Reads | Writes | Exit implication |
| --- | --- | --- | --- |
| `awb report --run <dir> --format md,json` | `<dir>/suite-result.json` | `report.md`; rewrites `suite-result.json` when `json` is selected | `0` when the run artifact is readable; tool errors fail with `1` |
| `awb report decision` | `comparison-result.json`, `gate-result.json`, optional reliability/validity reports | `decision-report.json`, `decision-report.md` | `0` only after comparison and gate revalidation; mismatch or invalid schema fails with `1` |
| `awb report trace-diff` | redacted `workflow-trace.json` files | `trace-diff.json` | `0` for a bounded diff; bad mode, missing trace role, untrusted qualification shape, or schema failure exits `1` |
| `awb report trend` | JSON `{ "seriesId": "...", "points": [...] }` | `trend-report.json` | `0` for valid ordered points; empty, duplicate, out-of-order, or schema-invalid input exits `1` |
| `awb report viewer` | already-redacted public artifacts | `viewer.html`, `html-viewer-manifest.json` | `0` when all inputs validate and the viewer hash matches; unredacted/private input exits `1` |
| `awb report trial-metrics` | `reliability-report.json` | `trial-metrics-report.json`, `trial-metrics-report.md` | `2` for valid diagnostic estimates; invalid or blocking source evidence exits `1` |

The Stage 9 command surface was verified with `npm run benchmark -- report
--help` and each subcommand help. The examples below require caller-supplied
artifacts from prior AWB runs; the repository tests execute the same flows with
fixture artifacts.

## Legacy Run Report

```bash
awb report --run reports/runs/my-workflow --format md,json
```

Use this for an existing single run. It does not compare a baseline and
candidate and does not change gate eligibility.

## Decision Report

```bash
awb report decision \
  --comparison reports/regression/comparison/comparison-result.json \
  --gate-result reports/regression/gate/gate-result.json \
  --gate-policy configs/evaluation/gate-policy.json \
  --out reports/regression/decision
```

For qualified live evidence, pass the same public trust anchors used by
`compare` and `gate`:

```bash
awb report decision \
  --comparison reports/observed/comparison/comparison-result.json \
  --gate-result reports/observed/gate/gate-result.json \
  --trusted-observer-key ci/observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/observed/decision
```

`decision` reopens the comparison, verifies the comparison bundle, recomputes
the gate with the selected policy, and compares the supplied `gate-result.json`
with the fresh result. Optional `--reliability` and `--validity` add statistics
only when those reports exist. AWB never invents human truth from missing
validity labels. When a public comparison does not include a private target
role identity, the report assigns remediation to the explicit
`workflow-owner` boundary instead of inventing or exposing a role name. Case
event IDs are loaded only from the fixed canonical candidate snapshot after
bundle verification succeeds; an invalid bundle remains blocked without
dereferencing artifact refs embedded in that bundle.

## Trace Diff

```bash
awb report trace-diff \
  --mode baseline-candidate \
  --baseline reports/observed/baseline/workflow-trace.json \
  --candidate reports/observed/candidate/workflow-trace.json \
  --out reports/observed/trace-diff
```

```bash
awb report trace-diff \
  --mode baseline-mutant-restore \
  --baseline .benchmark-debug/baseline/workflow-trace.json \
  --mutant .benchmark-debug/mutant/workflow-trace.json \
  --restore .benchmark-debug/restore/workflow-trace.json \
  --out reports/debug/trace-diff
```

Only independently qualified signed traces are marked `verified_live`:

```bash
awb report trace-diff \
  --mode baseline-candidate \
  --baseline reports/observed/baseline/workflow-trace.json \
  --candidate reports/observed/candidate/workflow-trace.json \
  --trusted-observer-key ci/observer-public.pem \
  --observer-qualification reports/observed/baseline/observer-qualification.json \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/observed/trace-diff
```

Without the trusted Observer key, trusted qualification key, and valid
qualification artifact, the diff remains diagnostic. Trace diffs store event
references, zero-based source positions, and payload and actor hashes; they do
not write raw payloads or raw actor identifiers. Relative ordering changes are
therefore visible even when the event payloads themselves are unchanged.
When hard-failure trajectories change, the optional `processDefects` section also
captures process-level deltas and severity to support explicit trajectory review.

## Trend Report

```bash
awb report trend \
  --input reports/trends/my-workflow-smoke-input.json \
  --out reports/trends/my-workflow-smoke
```

Trend input points must be ordered and include the comparability fields used by
the report builder:

```json
{
  "seriesId": "my-workflow-smoke",
  "points": [
    {
      "pointId": "2026-07-26T00-00Z",
      "generatedAt": "2026-07-26T00:00:00.000Z",
      "schemaVersion": "0.1.0",
      "policyVersion": "1.0.0",
      "policyHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rulesHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "runnerName": "codex",
      "runnerCapabilitiesHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "conditionsHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "contractHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "suite": "smoke",
      "targetId": "my-workflow",
      "observationLevel": "workflow_trace",
      "gateDecision": "PASS",
      "score": 90
    }
  ]
}
```

AWB splits history into separate eras whenever schema version, gate-policy
version/hash/rules, runner name or capabilities, conditions, contract, target,
suite, or observation level changes. It never draws a chart line across an
incompatible boundary.

## Trial Metrics

```bash
awb report trial-metrics \
  --reliability reports/reliability/reliability-report.json \
  --k 1,2,5 \
  --out reports/reliability/trial-metrics
```

For `n` observed attempts and `c` gate-PASS attempts, the report computes
`pass@k = 1 - C(n-c,k) / C(n,k)` and
`pass^k = C(c,k) / C(n,k)`. `BLOCK` and `DIAGNOSTIC_ONLY` attempts are not
successes. The source file hash, source content hash, contributing attempt
identities, counts, formulas, and estimates are persisted in the registered
artifact.

This command intentionally has a diagnostic ceiling. A reliability report can
be internally self-consistent without independently proving its live Observer
claims, and `trial-metrics` does not receive the original trace bundles or trust
anchors. It therefore never upgrades source JSON to PASS. A future verified
mode must reopen each signed trace and qualification artifact before removing
that ceiling.

## Static Viewer

```bash
awb report viewer \
  --decision reports/regression/decision/decision-report.json \
  --comparison reports/regression/comparison/comparison-result.json \
  --trace-diff reports/regression/trace-diff/trace-diff.json \
  --trend reports/trends/my-workflow-smoke/trend-report.json \
  --title "My Workflow AWB Report" \
  --out reports/regression/viewer
```

The viewer reads only already-redacted public artifacts. It writes static HTML
and a manifest with `publicSafe: true`, `readOnly: true`, and restrictions that
forbid changing gate results, reading unredacted traces, loading remote assets,
executing commands, or writing artifacts. The generated HTML has no scripts,
forms, browser storage, fetch calls, or remote assets. It escapes executable
markup and replaces dangerous `javascript:` display schemes before rendering.

Keep real target names, private paths, business contracts, credentials,
unredacted traces, and personal data out of public artifacts before rendering
the viewer.
