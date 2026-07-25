import { execa } from "execa";
import type { BenchmarkCase, MutationInput, ProfileResult, RunnerCapability } from "../core/types.js";
import { PRODUCT_NAME } from "../core/product.js";
import { evidenceBoundary, type EvidenceKind, type ObservationLevel } from "../doctor/doctor.js";
import type { VerifiedWorkflowTrace } from "../observer/workflowTrace.js";
import type { VerifiedObserverQualification } from "../observer/qualification.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";

export interface RunProvenance {
  schemaVersion: "0.1.0";
  product: typeof PRODUCT_NAME;
  generatedAt: string;
  subject: {
    targetId: string;
    contractHash: string;
    contentHash: string;
    git: {
      status: "available" | "unavailable";
      commit?: string;
      dirty?: boolean;
    };
    variant: {
      kind: "baseline" | "mutation_overlay";
      id?: string;
      type?: string;
    };
  };
  conditions: {
    suite: string;
    caseSetHash: string;
    budgetHash: string;
    commandPolicyHash: string;
    runner: {
      name: RunnerCapability["name"];
      adapterVersion: string;
      version?: string;
      capabilitiesHash: string;
    };
    observer?: {
      id: string;
      version: string;
      keyFingerprint: string;
      qualificationStatus: ObserverQualificationStatus;
      qualificationRef?: "observer-qualification.json";
      qualificationArtifactHash?: string;
      qualificationAuthorityFingerprint?: string;
    };
    executionMode: "live" | "simulated";
    evidenceKind: EvidenceKind;
    observationLevel: ObservationLevel;
    isolation: "read_only_sandbox" | "working_directory_only" | "synthetic" | "unknown";
    permissionMode: "read_only_no_approval" | "runner_default" | "none" | "unknown";
    model?: string;
    environment: {
      runtime: "node";
      runtimeVersion: string;
      platform: NodeJS.Platform;
      arch: string;
      ci: boolean;
    };
    environmentHash: string;
    conditionsHash: string;
  };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    artifacts: Array<{ ref: string; sha256: string }>;
  };
}

export type ObserverQualificationStatus = "missing" | "valid" | "invalid";

export async function buildRunProvenance(options: {
  profile: ProfileResult;
  cases: BenchmarkCase[];
  suite: string;
  runner: RunnerCapability;
  executionMode: "live" | "simulated";
  model?: string;
  mutation?: MutationInput;
  artifacts: Array<{ ref: string; path: string }>;
  targetRoot: string;
  dryRun?: boolean;
  verifiedTrace?: VerifiedWorkflowTrace;
  verifiedQualification?: VerifiedObserverQualification;
}): Promise<RunProvenance> {
  const effectiveRunner = effectiveRunnerIdentity(options.runner, options.executionMode);
  const boundary = options.verifiedTrace
    ? { evidenceKind: "live" as const, observationLevel: "workflow_trace" as const }
    : options.dryRun
      ? { evidenceKind: "unknown" as const, observationLevel: "capability_only" as const }
      : options.executionMode === "simulated"
        ? { evidenceKind: "simulated" as const, observationLevel: "synthetic_events" as const }
        : evidenceBoundary(options.runner);
  const environment = {
    runtime: "node" as const,
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
              ? ("valid" as const)
              : ("missing" as const),
            ...(options.verifiedQualification
              ? {
                  qualificationRef:
                    "observer-qualification.json" as const,
                  qualificationArtifactHash:
                    options.verifiedQualification.artifactHash,
                  qualificationAuthorityFingerprint:
                    options.verifiedQualification.authorityFingerprint
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
  const artifacts = await Promise.all(
    options.artifacts.map(async (artifact) => ({
      ref: artifact.ref,
      sha256: await hashFile(artifact.path)
    }))
  );

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

export function semanticCaseSetHash(cases: BenchmarkCase[]): string {
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

export function publicRunnerCapability(capability: RunnerCapability): Omit<RunnerCapability, "executable"> & { executableRef?: string } {
  const { executable: _executable, disabledReason, ...portable } = capability;
  return {
    ...portable,
    ...(capability.executable ? { executableRef: capability.name } : {}),
    ...(disabledReason ? { disabledReason: `${capability.name} executable not found or unavailable.` } : {})
  };
}

function profileContentHash(profile: ProfileResult): string {
  return sha256Text(
    stableJson({
      files: profile.evidence.scannedFiles.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
      missingFiles: profile.evidence.missingFiles
    })
  );
}

function effectiveRunnerIdentity(
  capability: RunnerCapability,
  executionMode: "live" | "simulated"
): RunProvenance["conditions"]["runner"] {
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

function isolationFor(
  executionMode: "live" | "simulated",
  runner: RunnerCapability["name"]
): RunProvenance["conditions"]["isolation"] {
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

function permissionModeFor(
  executionMode: "live" | "simulated",
  runner: RunnerCapability["name"]
): RunProvenance["conditions"]["permissionMode"] {
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

async function collectGitIdentity(targetRoot: string): Promise<RunProvenance["subject"]["git"]> {
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
  } catch {
    return { status: "unavailable" };
  }
}
