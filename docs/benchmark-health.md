# Benchmark Health

`awb ci benchmark-health` is the periodic self-check for an Agent Workflow Bench
(AWB) version. It aggregates already produced evidence and chooses whether the
AWB version is release-eligible or must be used only for diagnostics.

It does not evaluate a target workflow release. It does not enroll trust roots,
modify workflows, or create fix pull requests.

## Command

```bash
awb ci benchmark-health \
  --input health/benchmark-health-input.json \
  --out reports/health/current
```

The command writes `benchmark-health-report.json`.

| Version disposition | Exit code | Meaning |
| --- | ---: | --- |
| `RELEASE_ELIGIBLE` | `0` | Every supplied health check passed and no fail-closed trigger was present |
| `DIAGNOSTIC_ONLY` | `2` | One or more checks failed, were missing, or hit a fail-closed trigger |

Repository maintainers can produce every required input and aggregate it in one
run:

```bash
npm run build
node scripts/run-benchmark-health.mjs
```

The harness writes to `reports/benchmark-health` by default, runs the real Gold,
P0, Observer, A/A, schema, fresh-plugin-install/runtime-parity, and privacy
checks, then invokes `awb ci benchmark-health`. Command metadata redacts
ephemeral and external absolute paths. The scheduled
`.github/workflows/benchmark-health.yml` job uses `macos-14` because the
reference Observer qualification requires the macOS Seatbelt backend; using an
unsupported Linux runner would correctly force diagnostic-only health.

## Required Input

`benchmark-health-input.json` must use `benchmarkVersion: "0.1.0"` and bind each
evidence item with a portable `evidenceRef` and SHA-256 `evidenceHash`.

| Input section | Required evidence |
| --- | --- |
| `goldCorpus` | Gold Corpus status, P0 mutation kill rate, false negatives, false PASS count, known-good blocked count |
| `p0Mutation` | P0 mutation detection rate, false negatives, false PASS count |
| `observerQualification` | Observer decision, P0 detection rate, false PASS count, private-key visibility |
| `aaReliability` | A/A gate eligibility, deterministic agreement, stable gate agreement, P0 false PASS count, sample sufficiency |
| `schemaCompatibility` | schema compatibility and incompatible artifact count |
| `pluginInstall` | fresh plugin install and runtime parity |
| `privacyScan` | privacy finding count |

Evidence refs must be relative portable paths. Absolute paths, drive-letter
paths, and `..` segments are rejected.

## Fail-Closed Triggers

The report sets `versionDisposition: "DIAGNOSTIC_ONLY"` when any of these are
present:

- missing check;
- Gold Corpus failure;
- P0 mutation failure;
- P0 false negative;
- false PASS;
- invalid, missing, or incomplete Observer qualification;
- failed reliability or insufficient reliability sample;
- schema incompatibility;
- plugin install or runtime parity failure;
- privacy finding.

The most important diagnostic triggers have stable reason codes:

| Reason code | Trigger |
| --- | --- |
| `HEALTH_P0_FALSE_NEGATIVE` | Gold Corpus or P0 mutation evidence missed a P0 |
| `HEALTH_FALSE_PASS` | Gold Corpus, mutation, Observer, or reliability evidence showed a false PASS |
| `HEALTH_OBSERVER_UNQUALIFIED` | Observer qualification was invalid, incomplete, or exposed a private key to the Runner |
| `HEALTH_SCHEMA_INCOMPATIBLE` | schema compatibility failed or incompatible artifacts were found |
| `HEALTH_PLUGIN_INSTALL_FAILED` | fresh install or runtime parity failed |
| `HEALTH_PRIVACY_SCAN_FAILED` | privacy scan found one or more findings |

## Automatic Actions

The report records:

```json
{
  "versionDispositionApplied": true,
  "trustEnrollment": "disabled",
  "workflowModification": "disabled",
  "fixPullRequestCreation": "disabled"
}
```

Only the version disposition is applied by this command. Trust enrollment,
target workflow modification, and fix PR creation are explicitly disabled.

## Verification

Current source-backed checks:

```bash
npm test -- tests/stage10-benchmark-health.test.ts tests/stage10-cli-schema.test.ts
npm test -- tests/stage10-health-workflow.test.ts
```

Those tests cover healthy release eligibility, automatic diagnostic-only
downgrade for P0 false negatives, false PASS, invalid Observer qualification,
schema incompatibility, plugin/privacy failures, portable evidence refs,
schema-valid CLI output, and exit codes.
