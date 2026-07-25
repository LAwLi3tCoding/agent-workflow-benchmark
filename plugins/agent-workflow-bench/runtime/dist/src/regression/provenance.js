import { execa } from "execa";
import { PRODUCT_NAME } from "../core/product.js";
import { evidenceBoundary } from "../doctor/doctor.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
export async function buildRunProvenance(options) {
    const effectiveRunner = effectiveRunnerIdentity(options.runner, options.executionMode);
    const boundary = options.verifiedTrace
        ? { evidenceKind: "live", observationLevel: "workflow_trace" }
        : options.dryRun
            ? { evidenceKind: "unknown", observationLevel: "capability_only" }
            : options.executionMode === "simulated"
                ? { evidenceKind: "simulated", observationLevel: "synthetic_events" }
                : evidenceBoundary(options.runner);
    const environment = {
        runtime: "node",
        runtimeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        ci: Boolean(process.env.CI)
    };
    const conditionBase = {
        suite: options.suite,
        caseSetHash: semanticCaseSetHash(options.cases),
        budgetHash: sha256Text(stableJson({ contract: options.profile.contract.budgets, cases: options.cases.map((item) => item.budgets) })),
        commandPolicyHash: sha256Text(stableJson(options.profile.contract.commandPolicy)),
        runner: effectiveRunner,
        ...(options.verifiedTrace
            ? {
                observer: {
                    id: options.verifiedTrace.bundle.observer.id,
                    version: options.verifiedTrace.bundle.observer.version,
                    keyFingerprint: options.verifiedTrace.keyFingerprint,
                    qualificationStatus: options.verifiedQualification
                        ? "valid"
                        : "missing",
                    ...(options.verifiedQualification
                        ? {
                            qualificationRef: "observer-qualification.json",
                            qualificationArtifactHash: options.verifiedQualification.artifactHash,
                            qualificationAuthorityFingerprint: options.verifiedQualification.authorityFingerprint
                        }
                        : {})
                }
            }
            : {}),
        executionMode: options.executionMode,
        evidenceKind: boundary.evidenceKind,
        observationLevel: boundary.observationLevel,
        isolation: options.verifiedTrace
            ? options.verifiedTrace.bundle.subject.isolation
            : options.dryRun
                ? "unknown"
                : isolationFor(options.executionMode, options.runner.name),
        permissionMode: options.verifiedTrace
            ? options.verifiedTrace.bundle.subject.permissionMode
            : options.dryRun
                ? "unknown"
                : permissionModeFor(options.executionMode, options.runner.name),
        ...(options.verifiedTrace?.bundle.subject.model
            ? { model: options.verifiedTrace.bundle.subject.model }
            : options.model
                ? { model: options.model }
                : {}),
        environment,
        environmentHash: sha256Text(stableJson(environment))
    };
    const artifacts = await Promise.all(options.artifacts.map(async (artifact) => ({
        ref: artifact.ref,
        sha256: await hashFile(artifact.path)
    })));
    return {
        schemaVersion: "0.1.0",
        product: PRODUCT_NAME,
        generatedAt: new Date().toISOString(),
        subject: {
            targetId: options.profile.contract.targetId,
            contractHash: options.profile.contract.contractHash,
            contentHash: profileContentHash(options.profile),
            git: await collectGitIdentity(options.targetRoot),
            variant: options.mutation
                ? { kind: "mutation_overlay", id: options.mutation.id, type: options.mutation.type }
                : { kind: "baseline" }
        },
        conditions: {
            ...conditionBase,
            conditionsHash: sha256Text(stableJson(conditionBase))
        },
        integrity: {
            status: "VERIFIED_AT_WRITE",
            artifacts
        }
    };
}
export function semanticCaseSetHash(cases) {
    const semanticCases = [...cases]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((testCase) => ({
        id: testCase.id,
        targetId: testCase.targetId,
        suite: testCase.suite,
        templateId: testCase.templateId,
        title: testCase.title,
        oracleIds: testCase.oracleIds,
        expectedHardFailures: testCase.expectedHardFailures,
        prompt: testCase.prompt,
        bindings: testCase.bindings,
        budgets: testCase.budgets
    }));
    return sha256Text(stableJson(semanticCases));
}
export function publicRunnerCapability(capability) {
    const { executable: _executable, disabledReason, ...portable } = capability;
    return {
        ...portable,
        ...(capability.executable ? { executableRef: capability.name } : {}),
        ...(disabledReason ? { disabledReason: `${capability.name} executable not found or unavailable.` } : {})
    };
}
function profileContentHash(profile) {
    return sha256Text(stableJson({
        files: profile.evidence.scannedFiles.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
        missingFiles: profile.evidence.missingFiles
    }));
}
function effectiveRunnerIdentity(capability, executionMode) {
    if (executionMode === "simulated") {
        return {
            name: "simulated",
            adapterVersion: "0.1.0",
            capabilitiesHash: sha256Text(stableJson({ name: "simulated", adapterVersion: "0.1.0" }))
        };
    }
    return {
        name: capability.name,
        adapterVersion: capability.adapterVersion,
        ...(capability.version ? { version: capability.version } : {}),
        capabilitiesHash: capability.capabilitiesHash
    };
}
function isolationFor(executionMode, runner) {
    if (executionMode === "simulated") {
        return "synthetic";
    }
    if (runner === "codex") {
        return "read_only_sandbox";
    }
    if (runner === "claude") {
        return "working_directory_only";
    }
    return "unknown";
}
function permissionModeFor(executionMode, runner) {
    if (executionMode === "simulated") {
        return "none";
    }
    if (runner === "codex") {
        return "read_only_no_approval";
    }
    if (runner === "claude") {
        return "runner_default";
    }
    return "unknown";
}
async function collectGitIdentity(targetRoot) {
    try {
        const commit = await execa("git", ["-C", targetRoot, "rev-parse", "HEAD"], { reject: false, timeout: 3000 });
        if (commit.exitCode !== 0 || !commit.stdout.trim()) {
            return { status: "unavailable" };
        }
        const status = await execa("git", ["-C", targetRoot, "status", "--porcelain", "--untracked-files=normal", "--", "."], {
            reject: false,
            timeout: 3000
        });
        return {
            status: "available",
            commit: commit.stdout.trim(),
            dirty: status.exitCode !== 0 || status.stdout.trim().length > 0
        };
    }
    catch {
        return { status: "unavailable" };
    }
}
