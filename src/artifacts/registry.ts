import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";

export const ARTIFACT_TYPES = [
  "contract_model",
  "profile_evidence",
  "generation_manifest",
  "runtime_manifest",
  "observer-qualification",
  "reliability_report",
  "external_validity_report",
  "suite",
  "comparison_result",
  "gate_result",
  "provenance",
  "production_isolation_manifest",
  "production_canary_report",
  "production_blocking_authorization",
  "production_ci_gate_result"
] as const;

export type RegisteredArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactSchemaRegistryEntry {
  artifactType: RegisteredArtifactType;
  fileNames: string[];
  schemaFile: string;
  currentVersion: string;
  compatibilityPolicyRef: string;
  migrationSupported: boolean;
}

export interface ArtifactSchemaRegistry {
  schemaVersion: "0.1.0";
  artifactType: "artifact_schema_registry";
  registryVersion: string;
  schemaFiles: string[];
  entries: ArtifactSchemaRegistryEntry[];
}

export interface ArtifactCompatibilityPolicy {
  artifactType: RegisteredArtifactType;
  currentVersion: string;
  readableVersions: string[];
  migrationMode:
    | "identity"
    | "add_metadata"
    | "diagnostic_on_missing_trust";
  inferUnversionedAs?: string;
  requiredTrustFields: string[];
  missingTrustDisposition: "DIAGNOSTIC_ONLY";
  unsupportedCode: "ARTIFACT_SCHEMA_VERSION_UNSUPPORTED";
  action: string;
}

export interface ArtifactCompatibilityMatrix {
  schemaVersion: "0.1.0";
  artifactType: "artifact_compatibility_matrix";
  matrixVersion: string;
  semverPolicy: {
    patch: "backward-compatible fixes only";
    minor: "additive fields require migration or diagnostic downgrade";
    major: "breaking and never auto-migrated";
    zeroMajor: "0.y.z minor changes are treated as breaking";
  };
  policies: ArtifactCompatibilityPolicy[];
}

export async function loadArtifactSchemaRegistry(
  benchmarkRoot = getBenchmarkRoot()
): Promise<ArtifactSchemaRegistry> {
  const registry = await readJson<ArtifactSchemaRegistry>(
    path.join(benchmarkRoot, "configs/artifacts/schema-registry.json")
  );
  await validateCanonicalArtifactConfig(
    benchmarkRoot,
    "artifact-schema-registry.schema.json",
    registry
  );
  assertUnique(
    registry.entries.map((entry) => entry.artifactType),
    "artifact registry entry"
  );
  assertUnique(registry.schemaFiles, "registered schema file");
  for (const entry of registry.entries) {
    if (!registry.schemaFiles.includes(entry.schemaFile)) {
      throw new Error(
        `Artifact registry entry ${entry.artifactType} references unregistered schema ${entry.schemaFile}.`
      );
    }
  }
  return registry;
}

export async function loadArtifactCompatibilityMatrix(
  benchmarkRoot = getBenchmarkRoot()
): Promise<ArtifactCompatibilityMatrix> {
  const matrix = await readJson<ArtifactCompatibilityMatrix>(
    path.join(benchmarkRoot, "configs/artifacts/compatibility-matrix.json")
  );
  await validateCanonicalArtifactConfig(
    benchmarkRoot,
    "artifact-compatibility-matrix.schema.json",
    matrix
  );
  assertUnique(
    matrix.policies.map((policy) => policy.artifactType),
    "compatibility policy"
  );
  return matrix;
}

export async function assertArtifactRegistryComplete(
  benchmarkRoot = getBenchmarkRoot()
): Promise<void> {
  const [registry, matrix] = await Promise.all([
    loadArtifactSchemaRegistry(benchmarkRoot),
    loadArtifactCompatibilityMatrix(benchmarkRoot)
  ]);
  const actualSchemas = (await readdir(path.join(benchmarkRoot, "schemas")))
    .filter((file) => file.endsWith(".schema.json"))
    .sort();
  const registeredSchemas = [...registry.schemaFiles].sort();
  if (JSON.stringify(actualSchemas) !== JSON.stringify(registeredSchemas)) {
    const missing = actualSchemas.filter(
      (file) => !registeredSchemas.includes(file)
    );
    const stale = registeredSchemas.filter(
      (file) => !actualSchemas.includes(file)
    );
    throw new Error(
      `Artifact schema registry is incomplete: unregistered=[${missing.join(
        ", "
      )}] missing=[${stale.join(", ")}].`
    );
  }

  const entries = new Map(
    registry.entries.map((entry) => [entry.artifactType, entry])
  );
  const policies = new Map(
    matrix.policies.map((policy) => [policy.artifactType, policy])
  );
  for (const artifactType of ARTIFACT_TYPES) {
    const entry = entries.get(artifactType);
    const policy = policies.get(artifactType);
    if (!entry || !policy) {
      throw new Error(
        `Artifact ${artifactType} is missing a schema registry entry or compatibility policy.`
      );
    }
    if (entry.currentVersion !== policy.currentVersion) {
      throw new Error(
        `Artifact ${artifactType} registry and compatibility versions disagree.`
      );
    }
    if (
      entry.compatibilityPolicyRef !==
      `compatibility-matrix.json#${artifactType}`
    ) {
      throw new Error(
        `Artifact ${artifactType} has an invalid compatibility policy reference.`
      );
    }
  }
}

export function registryEntry(
  registry: ArtifactSchemaRegistry,
  artifactType: string
): ArtifactSchemaRegistryEntry | undefined {
  return registry.entries.find(
    (entry) => entry.artifactType === artifactType
  );
}

export function compatibilityPolicy(
  matrix: ArtifactCompatibilityMatrix,
  artifactType: string
): ArtifactCompatibilityPolicy | undefined {
  return matrix.policies.find(
    (policy) => policy.artifactType === artifactType
  );
}

async function validateCanonicalArtifactConfig(
  benchmarkRoot: string,
  schemaFile: string,
  value: unknown
): Promise<void> {
  const schema = await readJson<object>(
    path.join(benchmarkRoot, "schemas", schemaFile)
  );
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(
      `${schemaFile} validation failed: ${ajv.errorsText(validate.errors)}`
    );
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Artifact registry contains a duplicate ${label}.`);
  }
}
