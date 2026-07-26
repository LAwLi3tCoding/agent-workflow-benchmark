# Production CI

Agent Workflow Bench (AWB) CI has two separate surfaces:

- repository self-validation for this tool;
- observe-only external workflow checks for a caller's baseline/candidate pair.

Neither surface grants production blocking authority by itself.

## Repository CI

`.github/workflows/ci.yml` runs on `main` pushes and pull requests. It checks:

- `npm run typecheck`
- full `npm test`
- `npm run plugin:build`
- `git diff --check`
- generated runtime parity under `plugins/agent-workflow-bench/runtime`
- source `awb validate-schema`
- packaged runtime `plugins/agent-workflow-bench/bin/awb validate-schema`
- canonical naming scan over tracked contents and repository-relative paths
- privacy scan over tracked contents and paths for private-path, key, token,
  and private-data categories
- fresh-install smoke from a temporary plugin copy

The runtime parity step is intentional. Any change to source, schema, config,
fixtures, package metadata, or lockfile that affects the plugin runtime must be
followed by `npm run plugin:build` and the generated runtime diff must be
committed.

## External Observe-Only Template

`.github/workflows/awb-external-observe-only.yml` is a reusable workflow for
callers that keep AWB target packs in their own repository. By default it:

1. checks out baseline and candidate refs of the caller repository;
2. checks out an AWB repository/ref supplied by the caller;
3. copies the caller's target pack directory into the AWB checkout;
4. validates schemas and target pack registration;
5. runs `doctor`, baseline `run`, candidate `run`, `compare`, and `gate`;
6. records PASS, DIAGNOSTIC_ONLY, or BLOCK in the job summary without failing
   solely because of the AWB decision;
7. fails closed when AWB cannot execute, validate schemas, compare evidence, or
   write `gate-result.json`.

The reusable workflow exposes `decision` and `gate_exit_code` outputs so the
caller can record or route the observe-only result without silently turning it
into production enforcement.

Caller example:

```yaml
jobs:
  awb:
    uses: GITHUB_OWNER/agent-workflow-bench/.github/workflows/awb-external-observe-only.yml@main
    with:
      awb-repository: GITHUB_OWNER/agent-workflow-bench
      target-id: my-workflow
      target-pack-dir: .awb/targets
      baseline-ref: main
      candidate-ref: ${{ github.sha }}
      upload-redacted-artifacts: false
```

The caller-owned `.awb/targets` directory must contain `registry.yaml`, target
pack YAML files, and any contract-review sidecars required by `validate-schema`.
Keep real private roles, paths, business contracts, credentials, traces, and
target data out of public repositories. Summary artifact upload is explicit
opt-in through `upload-redacted-artifacts`; the default is no upload. When
enabled, the template uploads only summary JSON files and uses short retention
from `artifact-retention-days`.

## Canary and Assessment Commands

Production-CI assessment artifacts are:

```bash
awb ci evaluate-canary --samples <samples.json> --isolation-manifest <manifest.json> --gate-policy <gate-policy.json> --out <canary-dir>
awb ci assess --gate-result <gate-result.json> --runtime-manifest <runtime-manifest.json> --provenance <provenance.json> --isolation-manifest <manifest.json> --canary-report <production-canary-report.json> --out <assessment-dir>
```

The frozen canary policy is version `1.0.0`: at least 30 observe-only samples,
false-positive rate at most `0.02`, false-negative rate `0`, flaky rate at most
`0.05`, runtime p95 at most `900` seconds, and cost p95 at most `10` USD.
False-positive rate uses known-good (`expectedDecision: PASS`) samples as its
denominator; false-negative rate uses known-bad
(`expectedDecision: BLOCK`) samples. Both classes must be present, and
`sampleSetHash` binds the complete sample set.
`awb ci assess` remains `DIAGNOSTIC_ONLY` unless the evidence gate is PASS,
qualified live Observer evidence is bound, the caller supplies a strong
isolation manifest, canary thresholds pass, and explicit signed blocking
authorization is present. That signature binds the gate result, runtime
manifest, provenance, isolation manifest, canary report, and gate-policy
hashes; substituting any one of them blocks assessment.

## Production Blocking

Production blocking requires all of these, outside the default observe-only
template:

- explicit authorization from the workflow owner to make AWB blocking;
- a qualified independent live `workflow_trace` Observer;
- separate Observer and qualification-authority key pairs;
- caller-provided Runner isolation declared as `linux_container` or
  `strong_sandbox`;
- temporary HOME and TMPDIR for the Runner;
- read-only target checkout except declared artifact output paths;
- denied network by default or an explicit allowlist;
- controlled tool proxying and side-effect capture;
- external public trust anchors supplied to `ingest-trace`, `compare`, and
  `gate`;
- artifact retention that stores only redacted evidence.

If isolation, Observer qualification, human labels, or production authorization
is missing, AWB output remains `DIAGNOSTIC_ONLY` and must not be used as a
production release approval.

AWB validates the isolation evidence supplied by the caller. It does not claim
to provide a Linux isolation backend itself.

## Benchmark Health

`awb ci benchmark-health` is the periodic self-check for the AWB version itself.
It consumes precomputed health evidence and writes a fail-closed version
disposition:

```bash
awb ci benchmark-health \
  --input health/benchmark-health-input.json \
  --out reports/health/current
```

The input must bind portable evidence refs and SHA-256 hashes for:

- Gold Corpus detection and P0 mutation kill rate;
- P0 mutation reverse validation;
- Observer qualification;
- A/A reliability;
- schema compatibility;
- plugin fresh install and runtime parity;
- privacy scan.

The command writes `benchmark-health-report.json`. Exit code `0` means the AWB
version is `RELEASE_ELIGIBLE`; exit code `2` means the version is
`DIAGNOSTIC_ONLY`. A P0 false negative, false PASS, invalid Observer
qualification, schema incompatibility, missing check, plugin install failure,
privacy finding, or failed reliability check automatically downgrades the
version to `DIAGNOSTIC_ONLY`.

The report does not enroll trust roots, modify workflows, or create fix pull
requests. It records those automatic actions as disabled. See
[benchmark health](benchmark-health.md) for the input and reason-code contract.
