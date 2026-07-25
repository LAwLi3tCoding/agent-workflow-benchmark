# Workflow-Trace Observer Contract

This document defines how an external observer can produce release-grade
`workflow_trace` evidence for Agent Workflow Bench.

## Trust Model

The evaluated runner and the observer are separate principals:

- the runner executes the workflow;
- the observer records normalized runtime events;
- the observer signs the complete trace with an Ed25519 private key;
- AWB receives only the trace and a separately configured public key.

The private key must not be present in the runner workspace, environment, mounted secrets, tool
configuration, or generated artifacts. `awb ingest-trace`, `awb compare`, and `awb gate` accept a
public key only. They reject a private key passed as the trust anchor.

The signature establishes observer identity and post-signing integrity. It does not prove that
the observer implementation captured every relevant action. CI owners decide which observer
public keys are trusted after validating each observer implementation.

## Bundle

The canonical schema is
[`schemas/workflow-trace.schema.json`](../schemas/workflow-trace.schema.json).

Top-level fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `0.1.0`. |
| `observer` | Stable observer id, version, and public-key fingerprint. |
| `subject` | Target, contract, suite, semantic case-set, runner, isolation, and permission identity. |
| `cases` | One normalized observed run for every materialized case. |
| `attestation` | Ed25519 signature over every other top-level field. |

The public-key fingerprint is:

```text
sha256:<lowercase SHA-256 hex of the DER-encoded SubjectPublicKeyInfo public key>
```

`subject.caseSetHash` must use the same semantic case projection as AWB provenance. The safest
integration is to obtain the materialized cases and their manifest from AWB, then make the
observer bind its execution to those exact case files.

Each observed case must include:

- `case_start`;
- `contract_observed` containing the exact `contractHash`;
- `runner_start`;
- `runner_result`;
- `runner_exit`;
- `token_usage`;
- `case_end`.

The trace also carries the case `templateId`. Template-specific evidence is fail-closed. For
example, `side-effect-deny` requires a signed `side_effect_attempt` with:

```json
{
  "policyDecision": "deny",
  "allowed": false
}
```

Observers should emit normalized `handoff`, `gate_decision`, `artifact_write`, `state_read`,
`side_effect_attempt`, and `hard_failure` events whenever those actions are visible. A missing
negative observation must not be converted into a synthetic PASS.

## Signing

Remove the top-level `attestation` field, recursively sort every object key, preserve array
order, serialize as compact JSON, and sign those UTF-8 bytes with Ed25519. Then attach:

```json
{
  "attestation": {
    "algorithm": "ed25519",
    "signature": "<base64 signature>"
  }
}
```

The canonicalization is equivalent to AWB's `stableJson` helper:

```text
canonical(value):
  array  -> "[" + canonical(each item in original order) + "]"
  object -> "{" + canonical entries sorted by key + "}"
  scalar -> JSON.stringify(value)
```

All evidence must be redacted before signing. AWB rejects signed payloads containing common
credentials, email addresses, or absolute local paths because modifying a signed trace during
ingestion would destroy its attestation.

## Admission and Gate

```bash
awb ingest-trace \
  --cases-dir <materialized-cases> \
  --suite <suite> \
  --trace <workflow-trace.json> \
  --trusted-observer-key <observer-public.pem> \
  --out <observed-run>

awb compare \
  --baseline <baseline-observed-run> \
  --candidate <candidate-observed-run> \
  --trusted-observer-key <observer-public.pem> \
  --out <comparison>

awb gate \
  --comparison <comparison>/comparison-result.json \
  --trusted-observer-key <observer-public.pem> \
  --out <gate>
```

AWB binds the signed trace to `workflow-trace.json`, `runtime-manifest.json`,
`provenance.json`, the comparison evidence snapshot, and gate-time recomputation. A changed trace,
wrong key, missing case, changed case template, missing required evidence, or absent trust anchor
cannot produce PASS.

## Observer Qualification

Before adding a public key to a release trust policy, validate the observer with:

1. known-good trajectories;
2. one mutation for every P0 hard-failure class;
3. trace omission and reordering tests;
4. runner attempts to forge observer events;
5. key-isolation checks;
6. filesystem, tool, process, network, and token-ledger coverage checks;
7. repeated-run reproducibility measurements.

An observer that has not passed this qualification can still produce diagnostic evidence, but
its key should not be configured as a CI release trust anchor.
