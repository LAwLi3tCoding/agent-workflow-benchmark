import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { ensureDir } from "../utils/io.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { compatibilityPolicy, loadArtifactCompatibilityMatrix, loadArtifactSchemaRegistry, registryEntry } from "./registry.js";
export async function migrateArtifact(inputPath, options = {}) {
    const benchmarkRoot = options.benchmarkRoot ?? getBenchmarkRoot();
    const [registry, matrix, raw] = await Promise.all([
        loadArtifactSchemaRegistry(benchmarkRoot),
        loadArtifactCompatibilityMatrix(benchmarkRoot),
        readFile(inputPath, "utf8")
    ]);
    const sourceHash = sha256Text(raw);
    const sourceRef = portableArtifactRef(inputPath);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        const inferredType = options.artifactType ??
            inferArtifactType(registry, inputPath, undefined) ??
            "unknown";
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType: inferredType,
            sourceVersion: null,
            targetEntry: registryEntry(registry, inferredType),
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_JSON_INVALID"],
            actions: [
                "Provide a valid JSON artifact or regenerate it with a compatible AWB command."
            ]
        }));
    }
    const artifactType = options.artifactType ?? inferArtifactType(registry, inputPath, parsed);
    const entry = artifactType
        ? registryEntry(registry, artifactType)
        : undefined;
    const policy = artifactType
        ? compatibilityPolicy(matrix, artifactType)
        : undefined;
    if (!artifactType || !entry || !policy) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType: artifactType ?? "unknown",
            sourceVersion: readSchemaVersion(parsed),
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_TYPE_UNKNOWN"],
            actions: [
                "Pass --artifact-type with a registered type or use a canonical AWB artifact filename."
            ]
        }));
    }
    if (isRecord(parsed) &&
        Object.hasOwn(parsed, "schemaVersion") &&
        typeof parsed.schemaVersion !== "string") {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion: null,
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_SCHEMA_VERSION_INVALID"],
            actions: [
                "Use a semantic schema version in major.minor.patch form or regenerate the artifact."
            ]
        }));
    }
    const declaredVersion = readSchemaVersion(parsed);
    const versionInferred = declaredVersion === null && policy.inferUnversionedAs !== undefined;
    const sourceVersion = declaredVersion ?? policy.inferUnversionedAs ?? null;
    if (sourceVersion === null) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion,
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_SCHEMA_VERSION_MISSING"],
            actions: [
                "Regenerate the artifact with a compatible AWB version that records schemaVersion."
            ]
        }));
    }
    if (!isSemver(sourceVersion)) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion: null,
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_SCHEMA_VERSION_INVALID"],
            actions: [
                "Use a semantic schema version in major.minor.patch form or regenerate the artifact."
            ]
        }));
    }
    if (!isReadableVersion(sourceVersion, policy.readableVersions)) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion,
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: [policy.unsupportedCode],
            actions: [policy.action]
        }));
    }
    const missingTrustFields = requiredTrustFieldsMissing(parsed, policy, entry.artifactType);
    if (missingTrustFields.length > 0) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion,
            versionInferred,
            targetEntry: entry,
            status: "DIAGNOSTIC_ONLY",
            trustDisposition: "DIAGNOSTIC_ONLY",
            reasonCodes: ["ARTIFACT_TRUST_FIELDS_MISSING"],
            actions: [
                `${policy.action} Missing trusted evidence cannot be reconstructed; keep this artifact diagnostic-only.`
            ]
        }));
    }
    const migrated = applyCompatibleMigration(parsed, entry.artifactType, entry.currentVersion);
    const valid = await validateAgainstArtifactSchema(benchmarkRoot, entry, migrated);
    if (!valid) {
        return finalizeMigration(benchmarkRoot, migrationBase({
            sourceRef,
            sourceHash,
            artifactType,
            sourceVersion,
            versionInferred,
            targetEntry: entry,
            status: "INCOMPATIBLE",
            trustDisposition: "REJECTED",
            reasonCodes: ["ARTIFACT_SCHEMA_INVALID"],
            actions: [policy.action]
        }));
    }
    const changed = stableJson(migrated) !== stableJson(parsed);
    const reasonCodes = changed
        ? ["ARTIFACT_METADATA_ADDED"]
        : [];
    return finalizeMigration(benchmarkRoot, migrationBase({
        sourceRef,
        sourceHash,
        artifactType,
        sourceVersion,
        versionInferred,
        targetEntry: entry,
        status: changed ? "MIGRATED" : "CURRENT",
        trustDisposition: "PRESERVED",
        reasonCodes,
        actions: []
    }), migrated);
}
export async function writeArtifactMigration(outputDir, migration) {
    await ensureDir(outputDir);
    if (migration.artifact !== undefined) {
        await writeFile(path.join(outputDir, "migrated-artifact.json"), artifactText(migration.artifact));
    }
    await writeFile(path.join(outputDir, "migration-result.json"), `${JSON.stringify(migration.result, null, 2)}\n`);
}
export function artifactMigrationExitCode(result) {
    if (result.status === "DIAGNOSTIC_ONLY") {
        return 2;
    }
    return result.status === "INCOMPATIBLE" ? 1 : 0;
}
function inferArtifactType(registry, inputPath, value) {
    const fileName = path.basename(inputPath);
    const byFileName = registry.entries.find((entry) => entry.fileNames.includes(fileName));
    if (byFileName) {
        return byFileName.artifactType;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const discriminator = value.artifactType ?? value.resultType;
    if (typeof discriminator === "string" &&
        registry.entries.some((entry) => entry.artifactType === discriminator)) {
        return discriminator;
    }
    if (value.product === "Agent Workflow Bench" &&
        isRecord(value.subject) &&
        isRecord(value.conditions)) {
        return "provenance";
    }
    if (isRecord(value.baseline) &&
        isRecord(value.candidate) &&
        typeof value.classification === "string") {
        return "comparison_result";
    }
    if (typeof value.decision === "string" &&
        typeof value.ruleId === "string" &&
        isRecord(value.gatePolicy)) {
        return "gate_result";
    }
    if (typeof value.contractHash === "string" &&
        Array.isArray(value.entrypoints) &&
        Array.isArray(value.roles)) {
        return "contract_model";
    }
    if (typeof value.targetId === "string" &&
        Array.isArray(value.scannedFiles) &&
        Array.isArray(value.missingFiles)) {
        return "profile_evidence";
    }
    if (typeof value.contractHash === "string" &&
        typeof value.suite === "string" &&
        Array.isArray(value.caseIds)) {
        return "generation_manifest";
    }
    return undefined;
}
function applyCompatibleMigration(value, artifactType, currentVersion) {
    if (!isRecord(value)) {
        return value;
    }
    const migrated = structuredClone(value);
    migrated.schemaVersion = currentVersion;
    if (artifactType === "profile_evidence" ||
        artifactType === "generation_manifest" ||
        artifactType === "runtime_manifest") {
        migrated.artifactType = artifactType;
    }
    return migrated;
}
function requiredTrustFieldsMissing(value, policy, artifactType) {
    const missing = policy.requiredTrustFields.filter((field) => !hasValueAtPath(value, field));
    if (artifactType === "provenance" &&
        hasValueAtPath(value, "conditions.observationLevel") &&
        valueAtPath(value, "conditions.observationLevel") === "workflow_trace") {
        for (const field of [
            "conditions.observer.keyFingerprint",
            "conditions.observer.qualificationStatus",
            "conditions.observer.qualificationArtifactHash",
            "conditions.observer.qualificationAuthorityFingerprint"
        ]) {
            if (!hasValueAtPath(value, field)) {
                missing.push(field);
            }
        }
    }
    return [...new Set(missing)].sort();
}
function hasValueAtPath(value, dottedPath) {
    const found = valueAtPath(value, dottedPath);
    return found !== undefined && found !== null && found !== "";
}
function valueAtPath(value, dottedPath) {
    let current = value;
    for (const segment of dottedPath.split(".")) {
        if (!isRecord(current) || !(segment in current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}
async function validateAgainstArtifactSchema(benchmarkRoot, entry, value) {
    const schema = JSON.parse(await readFile(path.join(benchmarkRoot, "schemas", entry.schemaFile), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    return validate(value) === true;
}
function isReadableVersion(version, readableVersions) {
    const parsed = parseSemver(version);
    if (!parsed) {
        return false;
    }
    return readableVersions.some((range) => {
        const match = /^(\d+)\.(\d+)\.x$/u.exec(range);
        return (match !== null &&
            parsed.major === Number(match[1]) &&
            parsed.minor === Number(match[2]));
    });
}
function isSemver(version) {
    return parseSemver(version) !== undefined;
}
function parseSemver(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3])
    };
}
function readSchemaVersion(value) {
    if (!isRecord(value) || typeof value.schemaVersion !== "string") {
        return null;
    }
    return value.schemaVersion;
}
function migrationBase(options) {
    return {
        schemaVersion: "0.1.0",
        artifactType: "artifact_migration_result",
        status: options.status,
        trustDisposition: options.trustDisposition,
        source: {
            ref: options.sourceRef,
            contentHash: options.sourceHash,
            artifactType: options.artifactType,
            schemaVersion: options.sourceVersion,
            versionInferred: options.versionInferred ?? false
        },
        target: {
            schemaVersion: options.targetEntry?.currentVersion ?? null,
            schemaFile: options.targetEntry?.schemaFile ?? null
        },
        reasonCodes: options.reasonCodes,
        actions: options.actions
    };
}
async function finalizeMigration(benchmarkRoot, base, artifact) {
    const output = artifact === undefined
        ? undefined
        : {
            artifactRef: "migrated-artifact.json",
            contentHash: sha256Text(artifactText(artifact))
        };
    const content = {
        ...base,
        migrationId: sha256Text(stableJson({
            source: base.source,
            target: base.target,
            status: base.status,
            reasonCodes: base.reasonCodes
        })),
        ...(output ? { output } : {})
    };
    const result = {
        ...content,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(content))
        }
    };
    const schema = JSON.parse(await readFile(path.join(benchmarkRoot, "schemas/artifact-migration-result.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    if (!validate(result)) {
        throw new Error(`Artifact migration result failed schema validation: ${ajv.errorsText(validate.errors)}`);
    }
    return artifact === undefined ? { result } : { result, artifact };
}
function artifactText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function portableArtifactRef(inputPath) {
    const fileName = path
        .basename(inputPath)
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/^[^A-Za-z0-9]+/u, "");
    return `artifact://${fileName || "input.json"}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
