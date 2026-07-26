# Human-Light Execution

AWB supports an agent-orchestrated workflow with exactly three human
checkpoints:

1. a workflow owner confirms each target contract;
2. two blinded human raters confirm or correct independent Agent prelabels,
   with human adjudication for disagreements;
3. an external production authority signs the final blocking authorization.

Agents may prepare, execute, prelabel, validate, package, and report every other
step. Agent output is never human truth or production authorization.

## State Machine

| State | Agent responsibility | Human checkpoint |
| --- | --- | --- |
| `STUDY_MATRIX_READY` | Build the 120-item matrix and blinding map | none |
| `CONTRACT_REVIEW_PENDING` | Prepare contract diffs, gaps, and hashes | owner confirms the contract |
| `LABELING_PACKAGE_READY` | Write the blinded package and two isolated prelabel templates | none |
| `AI_PRELABEL_READY` | Two Agent lanes independently propose labels without seeing AWB decisions or each other | none |
| `HUMAN_LABEL_CONFIRM_PENDING` | Present proposed labels and disagreements | two humans confirm/correct; a human confirms adjudications |
| `OBSERVATIONS_READY` | Run qualified live observation, ingest, compare, and gate | none |
| `CRITERION_VALIDITY_ANALYZED` | Reverify evidence and compute validity statistics | none |
| `CANARY_PASS` | Run observe-only canary and evaluate frozen thresholds | none |
| `AUTHORIZATION_PENDING` | Bind all evidence into an unsigned request | external authority signs exact payload bytes |
| `PROD_BLOCKING_AUTHORIZED` | Verify the external signature and rerun production assessment | none |

Missing any checkpoint keeps the result `PENDING_HUMAN_INPUT` or
`DIAGNOSTIC_ONLY`.

## Contract Confirmation

Agents may generate a target draft and its gaps report. The workflow owner must
confirm the entrypoints, roles, owners, joins, artifacts, states, statuses,
budgets, and command policy. The resulting `contract-validity` artifact must
bind the final `contractHash`; an Agent must not self-approve it.

## Agent Prelabels and Human Confirmation

Run:

```bash
awb criterion-validity package --study <study.yaml> --out <review-dir>
```

In addition to the blinded package and human-label template, AWB writes:

- `external-validity-agent-prelabels.agent-rater-a.template.json`
- `external-validity-agent-prelabels.agent-rater-b.template.json`

These artifacts declare `source: agent_assisted_draft`, `humanTruth: false`,
and `awbDecisionVisible: false`. They are isolated suggestions and are never
accepted by `criterion-validity analyze` as human labels.

When Agent suggestions were used, the completed human-label artifact declares
`assistanceDisclosure: agent_prelabels_reviewed`. Each rater records an opaque,
public-safe external approval reference and its content hash:

```json
{
  "raterId": "rater-a",
  "role": "workflow_owner",
  "confirmation": {
    "status": "confirmed_by_human",
    "method": "external_approval",
    "artifactRef": "external://approval/rater-a",
    "artifactHash": "sha256:..."
  }
}
```

Missing or invalid confirmation evidence produces
`HUMAN_CONFIRMATION_EVIDENCE_MISSING` and cannot establish criterion validity.

## External Production Signature

First run `awb ci assess` without an authorization. Authorization preparation is
allowed only when that assessment is exactly
`PROD-BLOCKING-NOT-AUTHORIZED`.

```bash
awb ci prepare-authorization \
  --gate-result <gate-result.json> \
  --runtime-manifest <runtime-manifest.json> \
  --provenance <provenance.json> \
  --isolation-manifest <production-isolation-manifest.json> \
  --canary-report <production-canary-report.json> \
  --authorized-by authority://workflow-owner \
  --expires-at <ISO-8601-UTC> \
  --authority-public-key <authorization-public.pem> \
  --out <authorization-request-dir>
```

The command writes an integrity-bound request and the exact stable-JSON payload
bytes. It accepts only an external Ed25519 public key; it never accepts or emits
the private key.

The authorized human or approved external signing service signs the exact bytes
in `production-blocking-authorization.signing-payload.txt` and returns only a
base64 signature. An Agent then verifies and attaches it:

```bash
awb ci finalize-authorization \
  --request <production-blocking-authorization-request.json> \
  --signature <signature.base64> \
  --trusted-authorization-key <authorization-public.pem> \
  --out <authorization-dir>
```

Finally rerun `awb ci assess` with both `--authorization` and
`--trusted-authorization-key`. Production blocking is enabled only for
`PROD-BLOCKING-AUTHORIZED`.
