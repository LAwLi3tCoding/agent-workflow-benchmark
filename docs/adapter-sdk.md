# Adapter SDK

Agent Workflow Bench (AWB) Adapter contracts describe how a live Runner or
Observer is allowed to emit evidence into AWB. Adapter conformance is a
diagnostic compatibility check; it does not grant workflow gate PASS.

## Contract Surface

Adapter contracts are JSON artifacts with:

- `schemaVersion: "0.1.0"`
- `artifactType: "adapter_contract"`
- `protocolVersion: "1.0.0"`
- `kind: "runner"` or `"observer"`
- `implementation.runtime: "node"`
- portable relative `implementation.entrypoint`
- compatibility with AWB `^0.1.x`, `CaseRun` schema `0.1.0`, and
  `workflowTrace` schema `0.1.0`

Runner adapters must declare:

- `capabilities.runnerName`: `codex`, `claude`, or `opencode`
- supported entrypoint kinds: `file`, `cli`, or both
- all required runner lifecycle events:
  `case_start`, `runner_start`, `runner_transcript`, `runner_result`,
  `runner_exit`, `token_usage`, `case_end`
- runner comparability for `workflowScore`, `efficiency`, and `tokenCost`
- token evidence source: `native`, `estimated`, or `unavailable`

Observer adapters must not declare a runner identity. They must declare Ed25519
signing with redaction before signing and an independent process requirement.

## Safety Controls

Every Adapter contract must keep these controls disabled:

| Control | Required value |
| --- | --- |
| `automaticTrustEnrollment` | `false` |
| `automaticWorkflowModification` | `false` |
| `automaticFixPullRequest` | `false` |
| `observerPrivateKeyAccessibleToRunner` | `false` |

Conformance reports include the same safety object. AWB does not auto-enroll
trust roots, modify a target workflow, open a fix PR, or expose Observer private
keys to a Runner.

## Evidence Limits

Adapter contracts must declare positive deterministic bounds:

| Field | Purpose |
| --- | --- |
| `maxEventsPerCase` | maximum normalized events per case |
| `maxPayloadBytes` | maximum serialized payload bytes per event |
| `maxTranscriptBytes` | maximum runner transcript bytes |
| `maxTotalEvidenceBytes` | maximum serialized evidence bytes per case |
| `maxErrorMessageBytes` | maximum stable error-message bytes |

The OpenCode and reference Observer contracts currently use:
`maxEventsPerCase: 10000`, `maxPayloadBytes: 1048576`,
`maxTranscriptBytes: 10485760`, `maxTotalEvidenceBytes: 20971520`, and
`maxErrorMessageBytes: 4096`.

## Stable Errors

Adapters use this stable error vocabulary:

| Code | Meaning |
| --- | --- |
| `ADAPTER_CONTRACT_INVALID` | Contract identity, schema, capability, compatibility, evidence-limit, or safety fields are invalid |
| `ADAPTER_CAPABILITY_UNSUPPORTED` | Adapter was asked to execute an unsupported runner/capability |
| `ADAPTER_EXECUTABLE_UNAVAILABLE` | Required executable was missing or could not start |
| `ADAPTER_EXECUTION_FAILED` | Adapter process failed before producing usable evidence |
| `ADAPTER_TIMEOUT` | Adapter execution exceeded the configured timeout |
| `ADAPTER_OUTPUT_INVALID` | Adapter output could not be parsed or normalized |
| `ADAPTER_EVENT_INVALID` | Event shape, timestamp, uniqueness, declaration, or payload shape was invalid |
| `ADAPTER_EVENT_ORDER_INVALID` | Required lifecycle events were missing or out of order |
| `ADAPTER_EVIDENCE_LIMIT_EXCEEDED` | Transcript, event, payload, or total evidence exceeded declared limits |
| `ADAPTER_TOKEN_EVIDENCE_INVALID` | Token totals or token source did not match the canonical `token_usage` event |
| `ADAPTER_PRIVATE_DATA_REJECTED` | Portable evidence crossed the public redaction boundary |

## OpenCode Runner Adapter

The built-in OpenCode Runner Adapter is implemented by
`src/adapters/openCodeAdapter.ts` and configured by
`configs/adapters/opencode.json`.

It invokes OpenCode as:

```bash
opencode run --format json --dir <sandbox-root>
```

When a model is supplied, it appends `--model <provider/model>`. It does not
append `--auto`, `--yolo`, `--dangerously-skip-permissions`, or an equivalent
automatic approval flag.

The adapter requires OpenCode JSONL output with native per-step token evidence.
It deduplicates and sums `step_finish` records, preserves the native input,
output, reasoning, cache-read, cache-write, and optional reported-total
breakdown, then emits one canonical `token_usage` event with `source: "native"`
and `aggregation: "step_sum"`. AWB folds cache tokens into input and reasoning
tokens into output so its `input + output = total` invariant remains explicit.
Missing or malformed native step evidence fails conformance with
`ADAPTER_TOKEN_EVIDENCE_INVALID`. Token-cost comparison remains directional
until a shared cross-provider pricing contract is bound.

## Conformance

Run conformance with an explicit executable:

```bash
awb adapter conformance \
  --adapter opencode \
  --target minimal-directory-agent \
  --adapter-executable "$(command -v opencode)" \
  --out reports/adapters/opencode
```

The command writes `adapter-conformance-report.json`. It validates:

- Adapter contract schema and semantic rules;
- disabled automatic trust/workflow/fix actions;
- required runner lifecycle event declaration;
- case and runner identity binding;
- event uniqueness, ordering, and terminal semantics;
- token totals and token source against the canonical `token_usage` event;
- transcript, payload, event, and total evidence bounds;
- public redaction boundary;
- compatibility with the existing core scorer.

A report with `decision: "PASS"` proves Adapter compatibility only. The report
always has `releaseDisposition: "DIAGNOSTIC_ONLY"`, so it cannot produce a
workflow gate PASS without qualified independent `workflow_trace` evidence.

## Verification

Current source-backed checks:

```bash
npm test -- tests/stage10-adapter-sdk.test.ts tests/stage10-cli-schema.test.ts
```

Those tests cover canonical runner and Observer contracts, disabled automation,
the OpenCode command arguments, native token extraction, stable failure codes,
schema-valid conformance reports, and the diagnostic-only release disposition.
