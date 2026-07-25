# Agent Workflow Bench Methodology

Agent Workflow Bench (AWB) evaluates agent workflows, not isolated prompts. The benchmark therefore requires the AI planner to externalize a structured interpretation of the target workflow goal, stages, ownership boundaries, evidence surfaces, and failure modes before it creates cases or contributes to scoring. Harness validation checks that this interpretation is present and that coverage tags and executable bindings line up with the ContractModel; it is not an independent proof that the model semantically understood the workflow.

## Research Inputs

This method follows current practice from agent and LLM evaluation systems:

- OpenAI Evals and grader guidance: use explicit rubrics, structured evidence, and reusable eval artifacts.
- Anthropic agent evaluation guidance: evaluate real task trajectories and failure modes, not only final answers.
- General trace/eval tooling practice: combine broad case coverage, negative tests, repeatable scoring artifacts, and transcript inspection when routing, tools, and intermediate decisions matter.

Reference URLs:

- https://developers.openai.com/api/docs/guides/evals
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

## Method

1. **Profile the target into a ContractModel.**
   Target packs declare entrypoints, roles, required owners, forbidden routes, joins, artifacts, states, statuses, budgets, and command policy. The profiler scans declared role files, hashes evidence, and builds a stable `contractHash`.

2. **Run doctor before gateable evidence collection.**
   `awb doctor` must confirm schema validity, runner availability, target-pack consistency, and gate readiness before a run is used for CI. Doctor success does not make evidence trusted; it only proves the harness is ready to collect it.

3. **Force an explicit workflow understanding.**
   The AI planner must return both `targetUnderstanding` and `workflowUnderstanding`. The latter must name the workflow goal, ordered stages, critical invariants, and scoring signals. This makes the model show its interpretation before it proposes cases.

4. **Derive coverage targets from the contract.**
   AWB derives coverage tags such as `dimension:owner-routing`, `role:<id>`, `join:<id>`, `route:<id>`, `artifact:<id>`, `state:<id>`, `status:<value>`, and `policy:command`. These tags are embedded in the planner prompt and validated after planning.

5. **Generate enough cases for workflow coverage.**
   Case count is no longer treated as a small fixed number. `smoke` mode keeps a small single-pass budget for fast diagnosis, while `full` and `adaptive` modes derive larger budgets from the ContractModel coverage targets. Large workflow target packs should use `full` or `adaptive` when the goal is full stage-graph and multi-dimensional coverage.

6. **Validate generated cases before materialization.**
   `ai-case-plan-validation.json` records recommended count, covered targets, missing targets, unknown tags, and invalid bindings. AWB normalizes deterministic AI drift such as owner-scope bindings, prefixed `join:<id>` bindings, artifact ids, and common coverage tag aliases before validation. Materialization still rejects unresolved invalid role, join, and artifact bindings instead of producing misleading YAML.

7. **Materialize only executable benchmark cases.**
   Materialized YAML cases must use canonical ContractModel bindings, stable case hashes, explicit oracle ids, expected hard failures, operation sequence evidence, coverage tags, and scoring rubrics. This is the harness boundary between free-form AI understanding and repeatable execution.

8. **Use deterministic scoring for structured objective-failure events.**
   Implemented hard failures—currently forbidden routing, owner bypass, false PASS, missing joins, artifact-path drift, unsafe side effects, invalid provenance, and unregistered hard-failure codes—must be scored before aggregate scores or AI judgment. Runner failure and telemetry insufficiency are separate deterministic BLOCK/diagnostic conditions. Current built-in Codex/Claude live adapters consume runner-reported structured results such as `hardFailureCodes`; by themselves they remain `contract_summary` evidence and cannot produce CI gate PASS. The exact current/backlog vocabulary lives in `configs/evaluation/evaluation-contract.yaml`.

9. **Use AI judgment only for semantic workflow quality.**
   Scoring should combine AI only where semantics matter: whether the structured trajectory satisfies the workflow goal, whether the evidence is sufficient, whether the case probes the intended risk, and whether reasoning aligns with the target contract. AI judgment must not override deterministically scored hard-failure events or unavailable runner evidence.

10. **Report both benchmarked run results and harness quality.**
   `report.md`, `suite-result.json`, `harness-validation.json`, and `evaluation-summary.json` separate runner/simulated outcomes from harness health. A target can have no observed P0 failures in the collected benchmark evidence while the harness still reports planning warnings; conversely, a run can be BLOCKed while the harness remains PASS if it produced valid cases, scores, and repair suggestions.

11. **Compare matched baseline and candidate runs before gate.**
   Baseline and candidate evidence is gateable only when target id, suite, runner mode, adapter trust level, `contractHash`, and gate-policy binding are matched. `awb compare` must surface score regressions, new hard failures, telemetry gaps, policy mismatches, and comparability caveats before `awb gate` evaluates the result.

12. **Gate with explicit terminal decisions.**
   `awb gate` uses three terminal decisions: `PASS`, `DIAGNOSTIC_ONLY`, and `BLOCK`. Exit codes are `0` for PASS, `2` for DIAGNOSTIC_ONLY, and `1` for BLOCK or tool/runtime failure. PASS requires a qualified independent live `workflow_trace`; simulated evidence, built-in live `contract-summary` adapters, and signed traces without a valid Observer qualification artifact are diagnostic-only.

13. **Calibrate score and gate policy without changing evidence truth.**
   `awb gate-policy calibrate` evaluates bounded dimension-weight, telemetry-threshold, budget-threshold, and classification-delta candidates from development/calibration data, then `awb gate-policy validate-holdout` validates the frozen policy on holdout. No policy is emitted unless a candidate preserves P0 recall `1` and false PASS `0`. Public synthetic support is descriptive and does not by itself prove superior telemetry or budget settings. Calibration never changes whether Observer evidence is valid, and it cannot let aggregate scores or AI judgment override deterministic hard failures.

14. **Persist P0 cases as local reusable regression evidence.**
   Every P0 hard failure must be recorded as structured local evidence, not only rendered in a report. AWB writes `p0-cases.json`, `p0-cases.md`, and can append durable JSONL records with `--p0-case-log`. These records identify the target, run, case, contract hash, failure code, evidence events, and recommended action so previously evaluated agent workflows can be retested against their most important failures.

15. **Use reverse validation to test the benchmark itself.**
   Overlay-only mutation reverse validation checks configured simulated mutations against the benchmark scorer and oracle fixtures without mutating the real target source. If a mutation survives, repair the benchmark oracle, fixture, observer, target pack, or scorer before trusting the suite. Live Codex/Claude runner behavior must be validated separately through live execution artifacts.

## Gate Policy Calibration

Use the Stage 6 calibration workflow to produce a versioned policy and holdout report:

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

`calibrate` exits `2` with `PENDING_HOLDOUT`; `validate-holdout` exits `0` for PASS and
`1` for FAIL. The committed public synthetic reports are:

- `fixtures/calibration/v1/fit/gate-policy.json`
- `fixtures/calibration/v1/fit/calibration-report.json`
- `fixtures/calibration/v1/fit/calibration-report.md`
- `fixtures/calibration/v1/holdout/calibration-report.json`
- `fixtures/calibration/v1/holdout/calibration-report.md`

These artifacts are harness-diagnostic and `releaseEligible: false`. They demonstrate that
the policy machinery, split boundary, schemas, and holdout checks work on public synthetic
data; they do not establish production criterion validity.

Holdout stability is labeled `deterministic_harness_replay`: every repeat reruns the full
synthetic trajectory materialization, detector, and scoring path. It is not a substitute
for live reliability evidence.

For historical recomputation, pass the same policy to comparison and gate:

```bash
awb compare --baseline <baseline-run> --candidate <candidate-run> --gate-policy <gate-policy.json> --out <comparison-dir>
awb gate --comparison <comparison-dir>/comparison-result.json --gate-policy <gate-policy.json> --out <gate-dir>
```

Missing or mismatched `policyVersion`, `rulesHash`, or `policyHash` makes the result
incomparable. A policy version can change scoring thresholds and classification deltas, but
hard failures, invalid provenance, evidence absence, Observer qualification failure, and
safety violations still dominate all scores and AI judgments.

## Trusted Workflow-Trace Admission

`awb ingest-trace` is the positive admission path for an independently observed live run. The
observer emits normalized per-case events and signs the complete trace payload with Ed25519.
AWB verifies the bundle against an external public-key trust anchor before it scores any event.
The exact bundle, canonicalization, and observer-qualification contract is documented in
[`workflow-trace-observer-contract.md`](workflow-trace-observer-contract.md).

```bash
awb ingest-trace \
  --cases-dir cases/generated/<target-id>/ai-smoke \
  --suite smoke \
  --trace observer-output/workflow-trace.json \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --observer-qualification observer-output/observer-qualification.json \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/runs/<target-id>-observed

awb compare \
  --baseline reports/runs/<target-id>-baseline \
  --candidate reports/runs/<target-id>-candidate \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/comparisons/<target-id>

awb gate \
  --comparison reports/comparisons/<target-id>/comparison-result.json \
  --trusted-observer-key ci/trusted-observer-public.pem \
  --trusted-qualification-key ci/qualification-authority-public.pem \
  --out reports/gates/<target-id>
```

Admission is fail-closed:

- the signing private key is rejected as a CLI trust anchor and must never be available to the
  evaluated runner;
- `targetId`, `contractHash`, suite, semantic case-set hash, case ids, and case templates must
  match the materialized benchmark cases;
- required lifecycle events, token evidence, and template-specific evidence must be present;
- side-effect denial cases require an observed `side_effect_attempt` with
  `policyDecision=deny` and `allowed=false`;
- trace evidence must be redacted before signing;
- the trace, runtime manifest, provenance, comparison snapshot, and gate recomputation are all
  integrity-bound;
- `compare` and `gate` must receive the same external public-key trust anchor and compatible
  gate-policy binding. Recomputing editable JSON hashes cannot repair an invalid observer
  signature or a policy mismatch.

This attestation proves who signed the collected trace and that the evidence was not changed
after signing. It does not by itself prove that the observer implementation saw every relevant
runtime action or that OS/network isolation was effective. A production observer must therefore
be validated independently with controlled good/bad trajectories, mutation tests, and CI
isolation evidence before its public key is admitted as a release trust root.

`awb observer qualify` runs the frozen known-good, P0, omission, ordering,
forgery, wrong-key, key-leak, tool/network blind-spot, and repeat checks. The
bundled Darwin reference implementation applies a deny-default Seatbelt
boundary and actively proves signing-key reads, direct network, and nested
processes are denied with `EPERM`; static capability markers are rejected. Its
integrity-bound artifact is signed by a distinct qualification authority.
The artifact also binds the canonical evaluation-contract content hash.
Possession of an Observer public key alone never implies qualification; signed
traces without a valid artifact remain diagnostic-only. AWB does not mutate any
trust store.

## Scoring Answer

Yes, scoring should include AI, but only as a bounded semantic judge. The benchmark release/diagnostic decision must still be dominated by deterministic scoring of structured hard-failure events, runner availability, and telemetry completeness. AI judge output should be treated as directional unless it is tied to a versioned rubric and concrete event evidence.

## Case Coverage Answer

For workflow-level evaluation, a handful of cases is insufficient. The case set must cover:

- entrypoint/admission and final completion
- every major owner role and handoff boundary
- reviewer/gate status semantics
- required joins and callback ordering
- required artifacts and state recovery
- forbidden routes and side-effect policy
- budget, token, and telemetry behavior
- negative cases for the most important hard failures

The plan is acceptable only when coverage validation shows high coverage and any remaining gaps are explicit.

Use `--coverage-mode smoke` for fast feedback, `--coverage-mode full` for broad planned coverage, and `--coverage-mode adaptive` when follow-up generation should focus on missing coverage targets. `--max-cases` is a per-pass budget override, not a statement that fewer cases are sufficient.
