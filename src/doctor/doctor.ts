import type { ProfileResult, RunnerCapability } from "../core/types.js";
import { PRODUCT_NAME } from "../core/product.js";

export type EvidenceKind = "live" | "simulated" | "unknown";
export type ObservationLevel = "workflow_trace" | "contract_summary" | "synthetic_events" | "capability_only";

export interface DoctorCheck {
  id: "target-files" | "contract-profile" | "runner-capability" | "evidence-boundary";
  status: "PASS" | "WARN" | "FAIL";
  why: string;
}

export interface DoctorResult {
  schemaVersion: "0.1.0";
  product: typeof PRODUCT_NAME;
  target: {
    id: string;
    status: "PASS" | "FAIL";
    contractHash: string;
    roleCount: number;
    entrypointCount: number;
    missingFiles: string[];
    warnings: string[];
  };
  runner: {
    name: RunnerCapability["name"];
    supported: boolean;
    version?: string;
    adapterVersion: string;
    capabilitiesHash: string;
    evidenceKind: EvidenceKind;
    observationLevel: ObservationLevel;
  };
  readiness: "PASS" | "DIAGNOSTIC_ONLY" | "BLOCK";
  checks: DoctorCheck[];
}

export function diagnoseWorkflow(profile: ProfileResult, capability: RunnerCapability): DoctorResult {
  const boundary = evidenceBoundary(capability);
  const targetStatus = profile.evidence.missingFiles.length === 0 ? "PASS" : "FAIL";
  const contractReady = profile.contract.roles.length > 0 && profile.contract.entrypoints.length > 0;
  const checks: DoctorCheck[] = [
    {
      id: "target-files",
      status: targetStatus,
      why:
        targetStatus === "PASS"
          ? "Every declared role and file entrypoint was found."
          : `${profile.evidence.missingFiles.length} declared target file(s) are missing.`
    },
    {
      id: "contract-profile",
      status: contractReady ? "PASS" : "FAIL",
      why: contractReady
        ? "The target produced a ContractModel with roles and entrypoints."
        : "The ContractModel must include at least one role and one entrypoint."
    },
    {
      id: "runner-capability",
      status: capability.supported ? "PASS" : "FAIL",
      why: capability.supported ? `${capability.name} capability detection succeeded.` : capability.disabledReason ?? "Runner is unavailable."
    },
    {
      id: "evidence-boundary",
      status: boundary.observationLevel === "workflow_trace" ? "PASS" : "WARN",
      why:
        boundary.observationLevel === "workflow_trace"
          ? "The adapter emits live workflow trace evidence."
          : `${capability.name} currently provides ${boundary.observationLevel} evidence, which cannot authorize a real-effect PASS.`
    }
  ];
  const readiness =
    targetStatus === "FAIL" || !contractReady || !capability.supported
      ? "BLOCK"
      : boundary.observationLevel === "workflow_trace"
        ? "PASS"
        : "DIAGNOSTIC_ONLY";

  return {
    schemaVersion: "0.1.0",
    product: PRODUCT_NAME,
    target: {
      id: profile.contract.targetId,
      status: targetStatus,
      contractHash: profile.contract.contractHash,
      roleCount: profile.contract.roles.length,
      entrypointCount: profile.contract.entrypoints.length,
      missingFiles: profile.evidence.missingFiles,
      warnings: profile.evidence.warnings
    },
    runner: {
      name: capability.name,
      supported: capability.supported,
      ...(capability.version ? { version: capability.version } : {}),
      adapterVersion: capability.adapterVersion,
      capabilitiesHash: capability.capabilitiesHash,
      ...boundary
    },
    readiness,
    checks
  };
}

export function evidenceBoundary(capability: RunnerCapability): {
  evidenceKind: EvidenceKind;
  observationLevel: ObservationLevel;
} {
  if (capability.name === "simulated") {
    return { evidenceKind: "simulated", observationLevel: "synthetic_events" };
  }
  if (!capability.supported || capability.name === "opencode") {
    return { evidenceKind: "unknown", observationLevel: "capability_only" };
  }
  return { evidenceKind: "live", observationLevel: "contract_summary" };
}

export function renderDoctorReport(result: DoctorResult): string {
  return [
    `# ${PRODUCT_NAME} Doctor`,
    "",
    `Target: ${result.target.id}`,
    `Runner: ${result.runner.name}`,
    `Readiness: ${result.readiness}`,
    `Evidence: ${result.runner.evidenceKind} / ${result.runner.observationLevel}`,
    "",
    "## Checks",
    ...result.checks.map((check) => `- ${check.id}: ${check.status} - ${check.why}`),
    "",
    "## Boundary",
    result.readiness === "PASS"
      ? "The selected adapter can provide release-grade workflow trace evidence."
      : "This diagnosis is useful for discovery, but its evidence boundary does not authorize a real-effect PASS."
  ].join("\n");
}
