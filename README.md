# Agent Workflow Bench

**Evidence-first regression testing and release gates for coding-agent workflows.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)
Agent Workflow Bench (AWB) evaluates the workflow around a coding agent—not just its final answer.
It tests rules, skills, hooks, sub-agents, routing, handoffs, gates, artifacts, state, budgets, side-effect policy, and recovery.

The canonical product name is **Agent Workflow Bench**. The package, repository, plugin, Skill, and command slug is `agent-workflow-bench`; the CLI is `awb`.

> AWB is evidence-first. Deterministic contract violations and invalid
> provenance take precedence over aggregate scores and AI judgment. Simulated,
> incomplete, or incomparable evidence cannot produce a real CI PASS.

## What AWB Does

AWB turns workflow expectations into a versioned contract, derives coverage,
materializes executable cases, captures evidence, compares matched baseline and
candidate runs, and produces a deterministic release decision.
The standard path is `doctor` -> `profile` -> `plan-cases` -> `materialize` ->
matched baseline/candidate `run` -> `compare` -> `gate`.

| Area | Examples |
| --- | --- |
| Contract integrity | Entrypoints, roles, owners, statuses, required joins |
| Routing and gates | Forbidden routes, owner bypass, false PASS, missing callback |
| Artifacts and state | Missing files, wrong paths, stale or invalid state |
| Side effects | Forbidden commands, external writes, production operations |
| Execution quality | Required evidence, completion, interruption recovery |
| Efficiency | Wall-clock time, retries, repeated work, token usage |
| Harness quality | Coverage, mutation kill rate, false negatives, reproducibility |

## Install

### Requirements

- Node.js 22 or newer and npm. Hosted CI is pinned to Node.js 22.
- Codex or Claude Code for the corresponding live runner.
- No live agent CLI is required for simulated runs.

Replace `GITHUB_OWNER` with the account or organization hosting the repository.

### From source

```bash
git clone https://github.com/GITHUB_OWNER/agent-workflow-bench.git
cd agent-workflow-bench
npm ci
npm run validate
npm run benchmark -- --help
```

### Codex plugin

```bash
codex plugin marketplace add \
  https://github.com/GITHUB_OWNER/agent-workflow-bench \
  --ref main

codex plugin add \
  agent-workflow-bench@agent-workflow-bench
```

### Claude Code plugin

Inside Claude Code:

```text
/plugin marketplace add GITHUB_OWNER/agent-workflow-bench
/plugin install agent-workflow-bench@agent-workflow-bench
/reload-plugins
```

The plugin ships a self-contained JavaScript runtime, schemas, configs,
fixtures, Skill, command, and `bin/awb` wrapper.

## Quick Start

This safe local flow exercises discovery, matched comparison, and the gate
without calling a live coding agent:

```bash
awb doctor \
  --target minimal-directory-agent \
  --runner simulated \
  --out reports/doctor

awb run \
  --target minimal-directory-agent \
  --runner simulated \
  --execution simulated \
  --out reports/regression/baseline

awb run \
  --target minimal-directory-agent \
  --runner simulated \
  --execution simulated \
  --out reports/regression/candidate

awb compare \
  --baseline reports/regression/baseline \
  --candidate reports/regression/candidate \
  --out reports/regression/comparison

awb gate \
  --comparison reports/regression/comparison/comparison-result.json \
  --out reports/regression/gate
```

The final command returns exit code `2`. That is expected: simulated evidence
validates the harness and scorer but remains `DIAGNOSTIC_ONLY`.

Source-checkout users can replace `awb ...` with
`npm run benchmark -- ...`.

## CI Gate and Trust Boundary

### Gate decisions

| Decision | Exit code | Meaning |
| --- | ---: | --- |
| `PASS` | `0` | Qualified independent live `workflow_trace` and no blocking regression |
| `DIAGNOSTIC_ONLY` | `2` | Simulated, unqualified, incomplete, or incomparable evidence |
| `BLOCK` | `1` | Hard failure, regression, invalid provenance, or tool failure |

Implemented hard failures always dominate score: missing or reordered evidence,
forged Observer evidence, forbidden routing, owner bypass, objective drift,
prompt/task injection, tool-chain escalation, delayed handoff trigger, state poisoning,
unsafe recovery, false PASS, missing joins, artifact-path drift, unsafe production
side effects, telemetry or token-ledger loss, sensitive leakage, invalid
provenance, and unregistered hard-failure codes. P0 failures block; P1 failures
cap a case below PASS.

AWB ships schema-validated `trajectory-review` reports with deterministic
recovery metadata and enforced `baseline` timestamps in trace deltas. The
long-horizon safety mutation family (`prompt-injection`, `objective-hijack`,
`tool-chain-escalation`, `handoff-delay-trigger`, `memory-poison`,
`unsafe-recovery`) is registered as hard-fails in the contract and covered by
fixtures.

### Current runner evidence

| Runner | Current evidence boundary | Gate consequence |
| --- | --- | --- |
| Codex | Live `contract_summary` | Diagnostic-only without external observation |
| Claude Code | Live `contract_summary` | Diagnostic-only without external observation |
| OpenCode | Live Adapter contract and conformance | Diagnostic-only unless admitted through qualified workflow-trace observation |
| Simulated | Synthetic events | Harness/scorer validation only |

### Signed workflow-trace admission

The reference Observer runs the evaluated Runner behind an explicit fail-closed
boundary with a scrubbed environment. AWB currently includes two reference
backends:

| Backend | Boundary |
| --- | --- |
| `macos-seatbelt` | macOS `/usr/bin/sandbox-exec`; allows workspace writes and the exact Runner executable, denies signing-key reads, network, and unobserved nested executables, and requires active canaries to fail closed |
| `linux-oci-docker` | Linux OCI/Docker image bound by immutable image identity, no network, read-only rootfs, dropped capabilities, `no-new-privileges`, seccomp child-process denial, signing key outside the mount, and active key/network/nested-process/write canaries |

The Observer then collects, redacts, and Ed25519-signs filesystem, tool,
process, network-policy, artifact, state, side-effect, and token evidence.
Qualification also makes the controlled Runner attempt direct network and
nested-tool bypasses. Qualify it with a separate authority before release
gating:

```bash
awb observer observe --request observer-request.json --observer-private-key /secure/observer-private.pem --out observer-output/workflow-trace.json
awb observer qualify --target my-workflow --suite full --observer-id my-observer --observer-version 1.0.0 --observer-private-key /secure/observer-private.pem --qualification-authority-private-key /secure/qualification-authority-private.pem --out observer-output/qualification

awb ingest-trace \
  --cases-dir cases/generated/my-workflow \
  --suite full \
  --trace observer-output/workflow-trace.json \
  --trusted-observer-key ci/observer-public.pem \
  --observer-qualification observer-output/qualification/observer-qualification.json \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/observed/baseline

awb compare \
  --baseline reports/observed/baseline \
  --candidate reports/observed/candidate \
  --trusted-observer-key ci/observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/observed/comparison

awb gate \
  --comparison reports/observed/comparison/comparison-result.json \
  --trusted-observer-key ci/observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/observed/gate
```

AWB revalidates the signature, case set, lifecycle evidence, provenance,
runtime manifest, comparison snapshot, and gate recomputation. A changed trace,
wrong key, missing case, missing required evidence, or absent trust anchor
cannot produce PASS.

The trace signature proves Observer identity and post-signing integrity. The
authority signature proves that the exact Observer id, version, key,
content-addressed implementation closure, evidence capabilities, contract, case set, evaluation
contract, trace Schema, and qualification suite passed the frozen checks. The
Observer and qualification authority must use distinct key pairs. Both public trust anchors are
always supplied explicitly; AWB never enrolls either key. A signed trace without
a valid qualification artifact remains `DIAGNOSTIC_ONLY`, and editing run
metadata to self-assert `valid` is ignored. The private keys must stay outside
the Runner, repository, generated artifacts, and logs. See the
[workflow-trace Observer contract](docs/workflow-trace-observer-contract.md).

Unsupported isolation fails closed, produces no valid qualification artifact,
and cannot exceed `DIAGNOSTIC_ONLY`. The Linux Docker qualification path is
available for hosted or Linux environments, but a commit must still pass its
Linux Observer job before that commit can rely on Linux qualification evidence.

## Common Workflows

### Validate the benchmark Gold Corpus

```bash
awb gold-corpus validate --corpus fixtures/gold-corpus/v1/manifest.yaml
awb debug reverse-validate --corpus fixtures/gold-corpus/v1/manifest.yaml --runner simulated --out reports/gold-corpus
```

This is harness-only synthetic evidence. The report always records
`releaseEligible: false`; it cannot produce a real workflow release PASS. See
the [Gold Corpus contract](docs/gold-corpus.md).

### Calibrate the gate policy

Use only development/calibration Gold Corpus data to fit a versioned policy:

```bash
awb gate-policy calibrate --corpus fixtures/gold-corpus/v1/manifest.yaml --policy-version 1.1.0 --out reports/gate-policy/v1/fit
```

The command writes `gate-policy.json`, `calibration-report.json`, and
`calibration-report.md`, then exits `2` because the fit report is
`PENDING_HOLDOUT`. It exits `1` without a policy if no candidate preserves P0 recall
`1` and false PASS `0`. Validate the frozen policy separately on the unseen holdout:

```bash
awb gate-policy validate-holdout --corpus fixtures/gold-corpus/v1/manifest.yaml --policy reports/gate-policy/v1/fit/gate-policy.json --calibration-report reports/gate-policy/v1/fit/calibration-report.json --out reports/gate-policy/v1/holdout
```

Holdout validation exits `0` for `PASS` and `1` for `FAIL`. Its stability metric is deterministic full-harness replay, not live-run reliability. Public Gold Corpus PASS remains harness-diagnostic with `releaseEligible: false`; real criterion validity, human labels, qualified live traces, and production-blocking authorization remain separate. See [gate policy calibration](docs/gate-policy-calibration.md); committed synthetic evidence is under `fixtures/calibration/v1/{fit,holdout}`.

### Matched baseline/candidate regression

Use isolated checkouts and keep target contract, case set, runner, permissions,
budgets, and validation conditions aligned:

```bash
awb run --target my-workflow --target-root <baseline-checkout> --runner codex --execution live --mode diagnostic --out reports/regression/baseline
awb run --target my-workflow --target-root <candidate-checkout> --runner codex --execution live --mode diagnostic --out reports/regression/candidate
awb compare --baseline reports/regression/baseline --candidate reports/regression/candidate --gate-policy configs/evaluation/gate-policy.json --out reports/regression/comparison
```

Use `--runner claude` for Claude Code. Built-in live adapters remain
diagnostic-only until their runs are admitted through trusted workflow-trace
evidence.

Use the same `--gate-policy` when running `awb gate` to recompute historical
results. Missing or mismatched policy version, rules hash, or policy hash makes
the result incomparable instead of silently mixing policies.

### One-command evaluation

```bash
awb evaluate --target my-workflow --target-root <candidate-checkout> --planner-runner codex --runner codex --coverage-mode full --execution live --out reports/evaluations/my-workflow
```

Use `smoke` for fast feedback, `full` for broad contract coverage, and
`adaptive` to generate follow-up cases for missing coverage.

### Self-debug and mutation validation

```bash
awb debug reverse-validate \
  --target my-workflow \
  --suite smoke \
  --mutation-set fixtures/mutations/extended.yaml \
  --runner simulated \
  --out .benchmark-debug/my-workflow
```

Mutation overlays test the benchmark scorer and oracles. They do not mutate the
target source and do not prove live runner behavior.

## Commands and Artifacts

| Command | Purpose |
| --- | --- |
| `doctor` | Discover target, runner, and evidence readiness |
| `init-target` | Generate a reviewable target-pack draft |
| `profile` | Build a stable workflow `ContractModel` |
| `plan-cases` | Generate balanced cases with contract coverage and reference/counterexample outcomes |
| `materialize` | Produce executable case YAML and manifest |
| `run` | Execute a case or suite |
| `evaluate` | Run profile, planning, cases, scoring, and reports |
| `ingest-trace` | Verify and score an independently signed live trace |
| `compare` | Compare matched baseline and candidate evidence |
| `gate` | Apply deterministic CI release policy |
| `gate-policy ...` | Calibrate or holdout-validate a versioned scoring and gate policy |
| `artifact migrate` | Read or migrate registered artifacts with stable status and reason codes |
| `trace import-otlp` | Import untrusted OTLP JSON into sanitized diagnostic events and a schema-valid trace import manifest |
| `trace curate-production` | Build a redacted production-trace curation draft with explicit owner, security, reference-run, and holdout prerequisites |
| `governance benchmark` | Assess split isolation, contamination, saturation, reproducibility, and domain adapter evidence |
| `adapter conformance` | Validate a Runner Adapter contract and emitted `CaseRun` shape as diagnostic evidence |
| `ci benchmark-health` | Aggregate periodic benchmark self-checks into a fail-closed version disposition |
| `score` / `report` | Inspect runs; render decision, trace-diff, trend, runner-ranking, and static viewer artifacts |
| `report trajectory-review` | Rebuild deterministic process-defect trajectories from trace-diff evidence and optional judge/human labels |
| `report workflow-economics` | Compute diagnostic workflow efficiency and economics from trace-diff, trajectory-review, and matched suite results |
| `report trial-metrics` | Compute finite-sample pass@k and pass^k; source reports alone remain diagnostic-only |
| `criterion-validity ...` | Package blinded external studies or analyze independent labels |
| `debug ...` | Reverse-validate the harness or analyze repeated-run reliability |

| Artifact | Purpose |
| --- | --- |
| `contract-model.json` | Normalized target contract |
| `ai-case-plan-validation.json` | Coverage and binding validation |
| `events/*` / `case-results/*` | Per-case evidence and verdicts |
| `suite-result.json` | Single-run aggregate |
| `runtime-manifest.json` | Observed runner/runtime facts |
| `provenance.json` | Target, case, environment, and integrity identity |
| `schema-registry.json` / `compatibility-matrix.json` | Artifact schema inventory, semver policy, and migration rules |
| `workflow-trace.json` | Independently signed normalized live trace |
| `comparison-result.json` | Integrity-bound paired classification |
| `gate-result.json` | Deterministic release decision |
| `gate-policy.json` / `calibration-report.*` | Versioned policy, fit evidence, and holdout diagnostics |
| `otlp-diagnostic-import.json` / `trace-import-manifest.json` / `diagnostic-events.json` | Sanitized OTLP-derived diagnostic import, import manifest, and normalized diagnostic events |
| `production-trace-curation.json` / `production-trace-curation.md` | Redaction-reviewed draft that still requires owner/security review, a reference run, and holdout isolation |
| `benchmark-governance-report.json` / `benchmark-governance-report.md` | Diagnostic benchmark governance review for split isolation, contamination, saturation, reproducibility, and domain evidence |
| `report.md` / `decision-report.*` / `trace-diff.json` / `trajectory-review.json` / `trajectory-review.md` / `workflow-economics-report.json` / `workflow-economics-report.md` / `trend-report.json` / `viewer.html` | Diagnosis, decisions, redacted trace diffs with process-defect deltas, deterministic trajectory recovery metrics, workflow economics, era-separated trends, and static viewing |
| `reliability-report.*` / `validity-report.*` | Reliability, quarantine, and external-validity evidence |
| `adapter-conformance-report.json` | Adapter contract and runtime conformance diagnostics; never workflow PASS evidence |
| `benchmark-health-report.json` | Periodic benchmark health and version disposition |
| `runner-ranking-report.json` | Cross-runner ranking or explicit incomparability reason codes |
| `trial-metrics-report.*` | Source-bound pass@k/pass^k estimates with an explicit independent-verification ceiling |

Unsigned simulated repeats can report `DIAGNOSTIC_REPRODUCIBLE`, but only stable qualified live `workflow_trace` studies can report a strong `RELIABLE` conclusion.
Imported OTLP telemetry, production-trace curation, benchmark governance,
trajectory review, and workflow economics artifacts remain
`DIAGNOSTIC_ONLY` with trust ceiling `NONE`; successful diagnostic commands
return exit code `2`. Workflow economics uses the `0–100` `cappedScore` scale,
requires an explicit canonical UTC `--generated-at`, and permits Pareto
dominance only when both token ledgers have `high` confidence.
Run `awb <command> --help` for the complete option set.

## Security and Privacy

- Use isolated baseline and candidate roots through `--target-root`.
- Simulated fixtures do not invoke external agents.
- Persisted artifacts redact common credentials, emails, and absolute paths.
- Provenance binds results to target, Git, config, cases, runner, and artifacts.
- Signed traces must be redacted before attestation.
- The observer private key must never be available to the evaluated runner.
- Deterministic side-effect failures dominate aggregate score.
- Enterprise target packs should remain external to the public core.

Do not connect an untrusted target to production credentials or services. A
diagnostic prompt is not a sandbox by itself.

## Development

```bash
npm ci
npm run ci:local
```

The shared local/hosted gate runs diff hygiene, typecheck, all tests, plugin
build, runtime parity, source and packaged schema validation, naming and privacy
scans, and a fresh-install smoke test. The generated runtime under
`plugins/agent-workflow-bench/runtime/` is committed.

## Documentation

- [Human guide](docs/agent-workflow-bench-human-guide.md)
- [Plugin guide](docs/agent-workflow-bench-plugin-guide.md)
- [Evaluation methodology](docs/ai-workflow-evaluation-methodology.md)
- [2026 evaluation landscape and optimization roadmap](docs/agent-evaluation-landscape-2026.md)
- [Adapter SDK](docs/adapter-sdk.md)
- [Benchmark health](docs/benchmark-health.md)
- [Reporting and trends](docs/reporting-and-trends.md)
- [Workflow-trace observer contract](docs/workflow-trace-observer-contract.md)
- [Gate policy calibration](docs/gate-policy-calibration.md)
- [Artifact schema compatibility](docs/artifact-schema-compatibility.md)
- [Human-light agent execution](docs/human-light-execution.md)
- [简体中文 README](README.zh-CN.md)
- [日本語 README](README.ja.md)

## License

Agent Workflow Bench is open source software licensed under the
[MIT License](LICENSE).
