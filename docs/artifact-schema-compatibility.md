# Artifact Schema Compatibility

Agent Workflow Bench (AWB) treats machine-readable artifacts as versioned
contracts. The registry, schemas, and migration tool are release infrastructure:
they make old artifacts readable when that is safe, and they downgrade or reject
artifacts when trust cannot be proven.

## Registry

The canonical registry lives in `configs/artifacts/schema-registry.json`. It is
validated by `schemas/artifact-schema-registry.schema.json` and must enumerate
every committed `schemas/*.schema.json` file. Registry entries bind:

- artifact type
- canonical file names
- current schema file
- current schema version
- compatibility policy reference
- migration support flag

The current registered artifact types are:

```text
contract_model
profile_evidence
generation_manifest
runtime_manifest
observer-qualification
reliability_report
external_validity_report
suite
comparison_result
gate_result
decision_report
trace_diff
trend_report
html_viewer_manifest
provenance
```

Formal schemas now cover `ContractModel`, public profile evidence, generation
manifest, runtime manifest, Observer qualification, reliability report, validity
report, run/comparison/gate/provenance artifacts, decision reports, trace
diffs, trend reports, and static viewer manifests.

## Semver Policy

Compatibility rules live in `configs/artifacts/compatibility-matrix.json` and
are validated by `schemas/artifact-compatibility-matrix.schema.json`.

| Version change | Policy |
| --- | --- |
| Patch | Backward-compatible fixes only |
| Minor | Additive fields require migration or diagnostic downgrade |
| Major | Breaking and never auto-migrated |
| `0.y.z` minor | Treated as breaking |

The current matrix reads `0.1.x` artifacts. Unsupported versions return
`ARTIFACT_SCHEMA_VERSION_UNSUPPORTED` with an artifact-specific action hint.

## Migration CLI

Use the CLI before reusing older or externally supplied AWB artifacts:

```bash
awb artifact migrate --input <artifact.json> --out reports/artifact-migration
```

If the filename is not canonical, provide the registered artifact type:

```bash
awb artifact migrate \
  --input legacy-result.json \
  --artifact-type runtime_manifest \
  --out reports/artifact-migration
```

The command writes `migration-result.json` for every parseable outcome. When the
artifact is current or safely migrated, it also writes `migrated-artifact.json`
and records that file's content hash in the result.

| Status | Exit | Meaning |
| --- | ---: | --- |
| `CURRENT` | 0 | Artifact already matches the current registered schema |
| `MIGRATED` | 0 | Artifact was safely rewritten to the current schema |
| `DIAGNOSTIC_ONLY` | 2 | Artifact is readable but lacks trust fields needed for gate use |
| `INCOMPATIBLE` | 1 | Artifact is invalid, unknown, unsupported, or schema-invalid |

Stable reason codes:

```text
ARTIFACT_JSON_INVALID
ARTIFACT_TYPE_UNKNOWN
ARTIFACT_SCHEMA_VERSION_MISSING
ARTIFACT_SCHEMA_VERSION_INVALID
ARTIFACT_SCHEMA_VERSION_UNSUPPORTED
ARTIFACT_TRUST_FIELDS_MISSING
ARTIFACT_SCHEMA_INVALID
ARTIFACT_METADATA_ADDED
```

## Trust Boundary

Migration never invents trust. If an artifact lacks trust-critical fields, AWB
can preserve it only as diagnostic evidence. Missing Observer attestation,
policy hashes, integrity hashes, provenance bindings, runtime identity, or
conditions identity must be regenerated from original evidence; they cannot be
reconstructed from a legacy JSON file.

Examples:

- an unversioned `runtime-manifest.json` with runner capability hash,
  `attemptId`, `contractHash`, and seed can be migrated by adding metadata;
- a `suite-result.json` without gate-policy hashes is `DIAGNOSTIC_ONLY`;
- an `observer-qualification.json` without authority attestation is
  `DIAGNOSTIC_ONLY`;
- a `decision-report.json` cannot be reused as gate evidence unless its source
  comparison and gate can still be revalidated;
- a `trace-diff.json` with no qualified Observer binding remains diagnostic;
- a `trend-report.json` separates incompatible eras instead of migrating them
  into one chart series;
- an `html-viewer-manifest.json` is read-only display metadata, not a gate
  decision artifact;
- a `provenance.json` without integrity bindings is `DIAGNOSTIC_ONLY`;
- unknown artifact types or unsupported schema versions are `INCOMPATIBLE`.

Diagnostic-only artifacts may help explain history or debug a harness. They
must not produce CI PASS, certify Observer qualification, or authorize
production blocking gates.

## Validation

Run:

```bash
awb validate-schema
```

This validates schemas, runner config, target packs, the artifact registry, and
the compatibility matrix. For source development, rebuild the plugin runtime
after schema, config, fixture, or source changes:

```bash
npm run plugin:build
plugins/agent-workflow-bench/bin/awb validate-schema
```
