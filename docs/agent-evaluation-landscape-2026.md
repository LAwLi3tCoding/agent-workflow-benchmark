# Agent Evaluation Landscape and AWB Optimization Roadmap

Status: current as of 2026-07-26.

This review compares Agent Workflow Bench (AWB) with recent primary research,
official benchmark implementations, and production evaluation systems. The
goal is not to copy their product surfaces. It is to identify evidence-backed
gaps in AWB's role as a CI-grade regression and release gate for coding-agent
workflows.

## Executive Assessment

AWB is already differentiated in areas that most agent benchmarks leave
implicit:

- workflow contracts are profiled before cases are generated;
- coverage includes roles, routes, joins, artifacts, state, budgets, and
  side-effect policy rather than only final-task correctness;
- deterministic hard failures dominate aggregate scores and model judgment;
- baseline and candidate evidence must be matched before comparison;
- simulated or runner-reported summaries cannot become release PASS evidence;
- qualified Observer evidence, provenance, artifact compatibility, reliability,
  policy calibration, and external-validity artifacts are explicit.

The largest remaining gaps are therefore not another generic score or another
runner wrapper. They are:

1. richer, reviewable trajectory diagnosis;
2. broader long-horizon safety and recovery coverage;
3. standard trace ingestion and a production-trace-to-regression loop;
4. portable independent observation beyond the current Darwin boundary;
5. cost, latency, and multi-trial metrics that preserve AWB's trust ceiling.

## Evidence Reviewed

| Source | What it adds | Implication for AWB |
| --- | --- | --- |
| [Anthropic, *Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Separates capability from regression evals, recommends reference solutions, balanced positive/negative cases, transcript review, and both pass@k and pass^k | Strengthen generated-case quality, expose both trial metrics, and make trajectory review a maintained workflow |
| [UK AI Security Institute Inspect metrics](https://inspect.aisi.org.uk/metrics.html) and [scorer reference](https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html) | Defines finite-sample, draw-without-replacement estimators for pass@k and pass^k | Use the same estimators and publish the exact formula and sample counts |
| [AgentLens](https://arxiv.org/abs/2607.06624) and its [open-source benchmark](https://github.com/agent-lens/agent-lens-bench) | Combines formal checks, readable trajectory reviews, side-by-side comparison, and nightly regression | Add a first-class, evidence-linked trajectory-review artifact without allowing a judge to override hard failures |
| [ProcBench](https://arxiv.org/abs/2605.20251) | Normalizes trajectories, classifies process defects, and reports calibrated risk scorecards | Extend AWB from event presence to onset, propagation, recovery, and process-defect diagnosis |
| [Failure as a Process](https://arxiv.org/abs/2607.09510) | Finds that many coding-agent failures begin early and become unrecoverable later | Score early validation, detection latency, recovery attempts, and point-of-no-return evidence |
| [BenchAgent](https://arxiv.org/abs/2606.05670) | Compares single- and multi-agent workflows under aligned tools, logging, answer contracts, and usage accounting | Keep substrate and conditions alignment as a hard comparability requirement and expose accuracy-cost trade-offs |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench) | Uses containerized, reproducible evaluation environments and executable gold outcomes | Add a Linux/container Observer qualification path and reference-outcome checks |
| [ATBench](https://arxiv.org/abs/2604.02022) and [AgentLAB](https://arxiv.org/abs/2602.16901) | Cover delayed, multi-stage risks, heterogeneous tools, intent hijacking, tool chaining, task injection, objective drift, and memory poisoning | Expand safety cases beyond immediate forbidden commands and static side-effect denial |
| [Langfuse evaluation](https://langfuse.com/docs/evaluation/overview) | Connects production traces, human review, datasets, experiments, and CI/CD regression checks | Create an explicit trace-to-case curation path instead of leaving production failures outside the regression lifecycle |
| [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) | Provides ecosystem-level names for agent, tool, model, usage, and evaluation telemetry | Add a diagnostic OTLP/OpenTelemetry adapter while retaining AWB's stricter evidence model |

## Optimization Delivered in This Update

### 1. Balanced, reference-backed generated cases

AI case plans now carry an optional `referenceOutcome` and
`counterexampleOutcome`. The planner prompt asks for both success controls and
failure probes. Validation warns when either reference is missing and when a
plan of at least three cases is one-sided.

This is deliberately backward compatible: older plans remain readable and
materializable, but their quality gaps are visible. These fields document
expected behavior; they do not replace executable oracles.

Acceptance evidence:

- planner prompt and fixture plans contain both outcome fields;
- normalization and materialization preserve them;
- schema validation accepts them;
- missing fields and one-sided plans produce stable warnings;
- existing plan formats do not become hard failures.

### 2. Evidence-bounded trial metrics

`awb report trial-metrics` computes both:

- `pass@k = 1 - C(n-c,k) / C(n,k)`, the probability that at least one of
  `k` draws succeeds;
- `pass^k = C(c,k) / C(n,k)`, the probability that all `k` draws succeed.

Only an observed trial whose gate decision is `PASS` counts as success.
`BLOCK` and `DIAGNOSTIC_ONLY` count as failures. The report binds the source
reliability artifact and records every contributing attempt. The current
command deliberately remains `DIAGNOSTIC_ONLY` even when every source metadata
field describes qualified live evidence: a reliability report is
self-authenticating and the command does not yet reopen its original signed
traces. Invalid source reliability evidence blocks rather than being converted
into a favorable aggregate.

Acceptance evidence:

- estimator values match the Inspect finite-sample formulas;
- invalid `k`, schema-invalid input, or broken source integrity fails closed;
- no source reliability JSON, including a self-consistent forged one, can
  produce a trial-metrics PASS;
- JSON and Markdown outputs are registered and schema validated.

### 3. One reproducible local and hosted CI gate

`npm run ci:local` is now the canonical repository validation entrypoint and is
also invoked by GitHub Actions. It runs the checks in a fixed order:

1. diff hygiene;
2. type checking;
3. the full test suite;
4. plugin runtime generation;
5. generated-runtime parity;
6. source and packaged schema validation;
7. canonical naming;
8. privacy scanning;
9. a fresh-install plugin smoke test.

This removes drift between README instructions, local release checks, and the
hosted workflow.

## Prioritized Roadmap

### P0: First-class trajectory review and process-defect analysis

Add a `trajectory_review` artifact that is derived from already-redacted event
evidence and includes:

- exact event references for every finding;
- a versioned process-defect taxonomy;
- onset step, propagation steps, detection latency, recovery attempts, and
  final outcome;
- deterministic findings separated from judge findings;
- side-by-side baseline/candidate review;
- judge model, prompt, rubric, and calibration-set identity;
- optional blinded human labels and disagreement records.

Model-written findings must remain diagnostic until calibrated against a held
out human-labeled set. They must never override deterministic hard failures,
Observer validity, or provenance.

Exit criteria:

- a registered schema and compatibility policy;
- no unreferenced finding can validate;
- inter-rater agreement and judge precision/recall are reported by defect
  class;
- a review can be regenerated from the same redacted inputs;
- the decision report links review evidence without changing the gate.

### P0: Long-horizon safety and adversarial workflow cases

Extend the evaluation contract and case templates with explicit categories for:

- prompt and task injection;
- intent or objective hijacking;
- malicious tool output and tool-chain escalation;
- delayed triggers across handoffs;
- memory or state poisoning;
- unsafe recovery after a denied action;
- benign controls for every adversarial category.

Exit criteria:

- each category has positive and negative controls;
- delayed triggers require multi-stage evidence, not a single prompt label;
- side-effect denial and goal preservation are separately scored;
- mutation fixtures prove that each detector can both fire and remain silent;
- no synthetic safety fixture is described as real-world release evidence.

### P0: Portable independent observation

Add a Linux/container qualification path with the same fail-closed contract as
the Darwin reference Observer:

- deny-default network and process policy;
- signing keys outside the evaluated workspace and process environment;
- active canaries for key reads, network, nested processes, and out-of-scope
  writes;
- content-addressed Observer implementation closure;
- qualification signed by a distinct authority.

Exit criteria:

- controlled good, P0, omission, forgery, wrong-key, and blind-spot suites pass
  on the supported platform;
- unsupported isolation cannot emit qualified evidence;
- Darwin and Linux traces normalize to the same workflow-trace schema;
- platform differences are recorded in runtime provenance.

### P1: Standard trace ingestion

Add a diagnostic importer for OTLP JSON and OpenTelemetry GenAI spans:

- map agent, handoff, tool, model, token, latency, error, and evaluation events
  into AWB's normalized event model;
- preserve unknown spans and lossy-mapping warnings;
- publish an import manifest with source schema version and mapping hash;
- default imported traces to `DIAGNOSTIC_ONLY`.

Promotion beyond diagnostic evidence must require an independently qualified
collector and the existing AWB Observer contract; merely using OpenTelemetry
field names is not attestation.

### P1: Production trace to regression case loop

Add an explicit curation command that:

1. ingests an already-redacted failed trace;
2. clusters it against existing failure codes and coverage tags;
3. drafts a minimal reproducible case and counterexample;
4. records consent, source retention, and redaction metadata;
5. requires owner review before the case joins a target pack;
6. runs the new case against a reference implementation before activation.

Exit criteria:

- no raw production payload enters a public artifact by default;
- trace lineage survives anonymization and case minimization;
- duplicate and near-duplicate cases are detected;
- accepted incidents become durable regression cases with an owner and expiry
  policy.

### P1: Planning, recovery, cost, and latency dimensions

Extend scorecards with evidence-derived measures for:

- plan-to-action alignment and unnecessary replanning;
- early validation and time to first detected error;
- recovery success, repeated failed actions, and irreversible-action timing;
- tool, model, token, wall-clock, and retry cost by workflow stage;
- matched quality-cost-latency Pareto comparisons.

Costs must not be collapsed into the release score. Publish raw units,
normalization policy, confidence intervals, and missingness so a cheaper but
less trustworthy run cannot hide behind one aggregate.

### P2: Domain adapters and public benchmark governance

Add target packs and adapters for browser, research, multimodal, and
customer-support workflows only after their observability boundaries are
explicit. For any public dataset or leaderboard:

- version task, environment, runner, policy, and harness identities;
- separate development, calibration, holdout, and private challenge sets;
- publish contamination and saturation policy;
- require reproducible run manifests and artifact-level evidence;
- display incomparability instead of forcing a ranking.

## Recommended Delivery Order

1. Trajectory review and process-defect artifact.
2. Long-horizon safety taxonomy and mutation-backed case templates.
3. Linux/container Observer qualification.
4. OpenTelemetry diagnostic ingestion.
5. Production trace curation and review workflow.
6. Planning/recovery and quality-cost-latency reports.
7. Domain-specific target packs and public benchmark governance.

The ordering is intentional. Better dashboards or more task domains do not
improve confidence if process findings lack evidence links or the observation
boundary is not portable.

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
