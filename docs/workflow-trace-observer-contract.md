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

The bundled reference implementation additionally places the Runner behind a
deny-default macOS Seatbelt profile. Only the observed workspace is writable;
the exact Runner executable and its declared runtime inputs are readable; the
Observer key, network, and undeclared nested executables are denied. An
Observer-controlled preflight actively attempts all three forbidden operations
and requires `EPERM` before the Runner starts. The qualification Runner also
attempts direct network and nested process execution. Static policy markers do
not satisfy qualification. The Runner receives scrubbed HOME and TMPDIR
directories inside its workspace; writes in both scopes are included in the
filesystem evidence. The final signed trace must be outside every Runner
workspace; existing symlinks and hard links to the signing key are rejected,
both lexical and canonical paths are checked before Runner execution, and the
canonical output directory is frozen before the trace is installed by atomic
rename. A Runner-controlled parent link therefore cannot retarget the Observer
write into a key or file overwrite primitive.

This reference backend is currently Darwin-only and requires
`/usr/bin/sandbox-exec`. Unsupported platforms, an unavailable backend, a
failed profile application, or any successful boundary canary fail closed and
cannot produce a valid qualification artifact.

The signature establishes observer identity and post-signing integrity. It does not prove that
the observer implementation captured every relevant action. CI owners decide which observer
public keys are trusted after validating each observer implementation.

The reference `implementationHash` is content-addressed over the Observer,
trace verifier, qualification logic, evaluation-contract loader, stable
canonicalization, and redaction modules. A behavior-changing build therefore
cannot reuse an older qualification identity merely by retaining a version
string.

## Bundle

The canonical schema is
[`schemas/workflow-trace.schema.json`](../schemas/workflow-trace.schema.json).

Top-level fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `0.1.0`. |
| `observer` | Stable observer id/version, public-key fingerprint, implementation hash, and evidence capabilities. |
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

A qualified reference trace additionally requires Observer-owned
`filesystem_access`, `tool_call`, `process_spawn`, and `network_access` events,
plus artifact, state, side-effect, and token evidence for every case. Lifecycle
and collector events that claim to be Observer-owned are rejected when their
actor is the Runner. Network and tool capability evidence must include an
Observer boundary canary with `attempted=true`, `allowed=false`,
`policyDecision=deny`, and `outcomeCode=EPERM`; mere event-type presence is
insufficient. Event timestamps and lifecycle ordering are fail-closed.

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
  --observer-qualification <observer-qualification.json> \
  --trusted-qualification-key <qualification-authority-public.pem> \
  --out <observed-run>

awb compare \
  --baseline <baseline-observed-run> \
  --candidate <candidate-observed-run> \
  --trusted-observer-key <observer-public.pem> \
  --trusted-qualification-key <qualification-authority-public.pem> \
  --out <comparison>

awb gate \
  --comparison <comparison>/comparison-result.json \
  --trusted-observer-key <observer-public.pem> \
  --trusted-qualification-key <qualification-authority-public.pem> \
  --out <gate>
```

AWB binds the signed trace to `workflow-trace.json`, `runtime-manifest.json`,
`provenance.json`, the comparison evidence snapshot, and gate-time recomputation. A changed trace,
wrong key, missing case, changed case template, missing required evidence, or absent trust anchor
cannot produce PASS.

Signature admission is necessary but not sufficient. Without an
authority-signed qualification artifact, provenance carries
`qualificationStatus: missing` and the suite/gate remain `DIAGNOSTIC_ONLY`.
With an explicitly trusted qualification-authority public key, AWB revalidates
the artifact's signature and bindings to Observer id, version, public-key
fingerprint, implementation hash, evidence capabilities, Contract, case set,
evaluation-contract content hash, workflow-trace Schema, and qualification
suite. The qualification-authority key must be distinct from the Observer
signing key. Comparison ignores
self-asserted `valid` values in editable provenance or runtime metadata.

## Observer Qualification

The reference workflow is:

```bash
awb observer observe \
  --request <observer-request.json> \
  --observer-private-key </secure/observer-private.pem> \
  --out <workflow-trace.json>

awb observer qualify \
  --target <target-id> \
  --suite <suite> \
  --observer-id <observer-id> \
  --observer-version <version> \
  --observer-private-key </secure/observer-private.pem> \
  --qualification-authority-private-key </secure/qualification-authority-private.pem> \
  --out <qualification-dir>
```

Qualification executes:

1. known-good trajectories;
2. one mutation for every P0 hard-failure class;
3. trace omission and reordering tests;
4. runner attempts to forge observer events;
5. direct, copied, symlinked, and hard-linked key-isolation checks;
6. active network and nested-tool bypass attempts plus filesystem, tool,
   process, network, artifact, state, side-effect, and token-ledger coverage
   checks;
7. repeated-run reproducibility measurements.

The result is an Ed25519 authority-signed
`observer-qualification.json` conforming to
`schemas/observer-qualification.schema.json`. A valid artifact requires P0
detection rate 100%, false PASS 0, known-good PASS, three agreeing repeats, and
no Runner-visible signing key. An Observer without that artifact can still
produce diagnostic evidence.

`observer qualify` writes evidence and a qualification artifact only. AWB never
enrolls the Observer or qualification-authority public key into a trust root
automatically.
