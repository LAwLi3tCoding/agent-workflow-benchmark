# Agent Evaluation Landscape and AWB Optimization Roadmap

Status: current as of 2026-07-26.

This note separates external research inference from repository evidence.
External papers and specifications say what is likely worth adding next.
Repository evidence says what this tree already implements.

## Executive Assessment

AWB is already strong where many agent benchmarks are still weak:

- workflow contracts are profiled before cases are generated;
- coverage includes roles, routes, joins, artifacts, state, budgets, and
  side-effect policy instead of only final-task correctness;
- deterministic hard failures dominate aggregate scores and model judgment;
- baseline and candidate evidence must be matched before comparison;
- simulated or runner-reported summaries cannot become release PASS evidence;
- qualified Observer evidence, provenance, artifact compatibility, reliability,
  policy calibration, and external-validity artifacts are explicit.

The research signal from 2026 is consistent: the next useful work is not a
generic leaderboard score, but stronger trajectory diagnosis, longer-horizon
safety coverage, OTLP-compatible trace ingestion, production-to-regression
curation, and repeat-run evidence that preserves AWB's trust ceiling.

## Fresh Primary Sources

These are research inputs, not repository facts.

| Source | What it establishes | AWB inference |
| --- | --- | --- |
| [AgentLAB: Benchmarking LLM Agents against Long-Horizon Attacks](https://arxiv.org/abs/2602.16901) | Submitted 2026-02-18; benchmarks long-horizon attacks across multi-turn user-agent-environment interactions and reports that single-turn defenses do not reliably mitigate them. | AWB should keep delayed triggers, objective drift, memory poisoning, and handoff abuse as separate control families, not one broad "safety" bucket. |
| [AgentSecBench: Measuring Prompt Injection, Privacy Leakage, and Tool-Use Integrity in LLM Agents](https://arxiv.org/abs/2605.26269) | Submitted 2026-05-25; models prompt injection, retrieval confidentiality, and capability integrity as noninterference games with benign controls. | AWB should separate policy projection from enforcement and treat "text that describes a boundary" as different from "evidence that enforces one". |
| [From Untrusted Input to Trusted Memory: A Systematic Study of Memory Poisoning Attacks in LLM Agents](https://arxiv.org/abs/2606.04329) | Submitted 2026-06-03, revised 2026-06-18; identifies four memory write channels, nine structural vulnerabilities, and six attack classes, and says prompt-injection defenses do not cover memory poisoning. | AWB should keep memory poisoning distinct from prompt injection and score write-channel and retrieval-channel risk separately. |
| [AgencyBench: Benchmarking the Frontiers of Autonomous Agents in 1M-Token Real-World Contexts](https://arxiv.org/abs/2601.11044) | Submitted 2026-01-16, revised 2026-04-23; evaluates 138 real-world tasks, averages about 90 tool calls and 1M tokens, and uses user simulation plus Docker sandboxing. | AWB needs repeated-run confidence, tool-cost accounting, and long-horizon telemetry before domain packs can be trusted as production-adjacent evidence. |
| [Claw-Eval: Towards Trustworthy Evaluation of Autonomous Agents](https://arxiv.org/abs/2604.06132) | Submitted 2026-04-07; its open implementation describes 300 human-verified tasks, 9 categories, completion/safety/robustness grading, and strict Pass^3 across three trials. | AWB's trajectory review should stay evidence-linked and diagnostic, but repeated-run metrics must remain separate from hard gate decisions. |
| [OpenTelemetry Gen AI semantic conventions docs](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) and [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) | The official OpenTelemetry docs now route GenAI attributes into the GenAI semantic-conventions repo; the repo covers spans, metrics, and events for GenAI clients, MCP, and provider-specific conventions. | AWB can safely accept OTLP/GenAI traces as diagnostics, but must keep its own stricter evidence and trust model instead of inheriting the external schema as attestation. |
| [agentevals-dev/agentevals](https://github.com/agentevals-dev/agentevals) | Framework-agnostic evaluation from OpenTelemetry traces; built around already-recorded traces, OTLP/Jaeger ingestion, and no-rerun scoring. | AWB's OTLP importer should stay diagnostic-only and preserve source provenance rather than trying to become a generic trace scorer. |
| [langchain-ai/agentevals](https://github.com/langchain-ai/agentevals) | Trajectory-focused evaluators for intermediate agent steps. | AWB's trajectory review artifact is aligned with the general direction of the ecosystem, but AWB should keep explicit hard-failure and provenance rules. |

## Implemented Control-Plane Work

This section is repository evidence, not research inference.

| Area | Repository evidence | Trust ceiling |
| --- | --- | --- |
| Trajectory review and process-defect analysis | `src/report/trajectoryReview.ts`, `src/report/traceDiff.ts`, `schemas/trajectory-review.schema.json`, `tests/trajectory-review.test.ts` | Diagnostic-only. A review can explain a failure, but it cannot override deterministic hard failures or provenance. |
| Six long-horizon safety families | `fixtures/mutations/*.yaml`, `src/runner/simulatedRunner.ts`, `configs/evaluation/evaluation-contract.yaml`, `tests/evaluation-contract.test.ts` | Control-family only. These are deterministic hard-failure probes, not production safety proof. |
| Linux Docker Observer path | `.github/docker/linux-observer/Dockerfile`, `.github/docker/linux-observer/seccomp-launcher.c`, `.github/workflows/observer-linux-docker.yml`, `tests/reference-observer-linux.test.ts` | Implemented qualification path only. This note does not claim the Docker workflow has passed until its hosted Linux job is green for this commit. |
| OTLP diagnostic import | `src/importers/otlp.ts`, `schemas/otlp-diagnostic-import.schema.json`, `schemas/trace-import-manifest.schema.json`, `tests/otlp-import.test.ts` | Diagnostic-only. Imported traces are not attestation and do not become release evidence by format alone. |
| Production trace curation draft | `src/curation/productionTrace.ts`, `schemas/production-trace-curation.schema.json`, `tests/production-trace-curation.test.ts` | Draft curation flow only. It turns redacted incidents into candidate regressions; it does not make raw production traces public. |
| Workflow economics | `src/report/workflowEconomics.ts`, `schemas/workflow-economics-report.schema.json`, `tests/workflow-economics.test.ts` | Decision-support only. Cost, latency, retry, and comparability data are diagnostic and must not replace the gate. |
| Benchmark governance | `src/governance/publicBenchmark.ts`, `schemas/benchmark-governance-report.schema.json`, `tests/public-benchmark-governance.test.ts` | Governance scaffold only. It defines policy and review boundaries, but it is not a validated domain benchmark. |

Earlier baseline AWB foundations remain in place:

- balanced, reference-backed generated cases;
- evidence-bounded trial metrics;
- one reproducible local and hosted CI gate;
- artifact compatibility and privacy-scanning checks.

## What the Delivered Work Means

The important shift is that AWB now has control-plane depth without relaxing
its trust model.

- trajectory review explains failures;
- long-horizon safety mutations exercise delayed, multi-stage attack classes;
- the Linux Docker path gives a portable qualification route;
- OTLP import and production curation let real traces feed diagnostics and
  candidate regressions;
- workflow economics adds cost/latency context without turning it into a gate;
- benchmark governance creates the policy shell for future domain packs.

The trust ceilings stay strict:

- a review artifact cannot clear a hard failure;
- an imported trace cannot become proof just because it is OTLP;
- a production incident does not become public benchmark evidence by default;
- a governance scaffold is not the same thing as a domain adapter;
- local Linux qualification is not the same thing as a separately verified
  remote Linux qualification path.

## Next Roadmap

1. Verified domain packs for browser, research, multimodal, and customer-support
   workflows, with explicit observability boundaries and separate adapter
   validation.
2. Production adoption and effectiveness measurements against real incidents and
   repeated-run traces, not just synthetic or lab-only cases.
3. Repeated-run confidence intervals and plan-action telemetry, so AWB can show
   consistency, not only peak success.
4. Near-duplicate curation, clustering, and owner-aware incident deduplication,
   so the regression corpus grows without becoming redundant.

## Trust Boundaries That Must Not Change

- A model judge cannot clear a deterministic hard failure.
- A self-reported runner summary is not independent observation.
- A self-hash proves internal consistency, not signer identity.
- Simulated, capability-only, imported, or unqualified traces remain
  diagnostic.
- Missing evidence is not inferred from a favorable aggregate.
- Public synthetic calibration does not establish production validity.
- Historical results with incompatible task, policy, runner, conditions,
  contract, or observation identity are not combined.
