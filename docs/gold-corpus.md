# Gold Corpus

Agent Workflow Bench ships a versioned, synthetic Gold Corpus under
`fixtures/gold-corpus/v1/`. It validates the benchmark harness and deterministic oracles; it is
not live target evidence and can never make a release decision eligible for PASS.

## Contract

`manifest.yaml` binds the corpus to:

- corpus and fixture versions;
- the reviewed target `contractHash`;
- the semantic smoke `caseSetHash`;
- content hashes for the base trajectory, every split trajectory document, and every label
  document;
- the required P0/P1 failure registry; and
- explicit typed coverage exemptions (empty in v1).

Every generated report also records the manifest content hash so a result can be tied to the
exact root document used for evaluation.

Paths are repository-relative and may not escape the fixture directory. Any hash, target,
contract, case-set, split, label, or control mismatch fails closed.

## Splits and leakage boundary

Development, calibration, and holdout trajectories are stored separately. Their labels are in
separate files. The planner API reads only the development trajectory document and never opens
any label document; calibration and holdout trajectories are also excluded from planner
context. Opaque trajectory ids avoid encoding expected outcomes in the planner-facing view.

Labels record the independent label source, expected verdict, expected failure code, failure
severity, control (`known_good`, `known_bad`, or `boundary`), and ContractModel coverage targets.
The detector consumes only materialized events and run telemetry. Expected labels are joined
after detection, so editing a label cannot manufacture detector evidence.

## Required coverage

Each of these families has one known-good, one known-bad, and one boundary trajectory:

- required event missing or reordered;
- forged Observer evidence;
- owner bypass and forbidden route;
- false PASS and missing join;
- artifact-path drift and production side effect;
- missing telemetry and token ledger; and
- sensitive leakage.

The corpus uses only generic synthetic fixture values. Real target traces, private paths,
credentials, host identities, personal data, and company data are prohibited.

## Commands

Validate schema, integrity, provenance, coverage, and acceptance:

```bash
awb gold-corpus validate \
  --corpus fixtures/gold-corpus/v1/manifest.yaml
```

Write the full reverse-validation report:

```bash
awb debug reverse-validate \
  --corpus fixtures/gold-corpus/v1/manifest.yaml \
  --runner simulated \
  --out reports/gold-corpus
```

`gold-corpus-report.json` is explicitly `harness_diagnostic` with
`releaseEligible: false`. Stage 2 acceptance requires mutation kill rate 100%, P0 mutation kill
rate 100%, false PASS 0, false positive 0, false negative 0, no known-good block, and no missing
failure or ContractModel coverage target.
