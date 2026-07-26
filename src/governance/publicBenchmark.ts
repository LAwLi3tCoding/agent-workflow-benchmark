import path from "node:path";
import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export type BenchmarkSplitId =
  | "development"
  | "calibration"
  | "holdout"
  | "private_challenge";
export type GovernedDomain =
  | "browser"
  | "research"
  | "multimodal"
  | "customer_support";

export interface GovernedRunIdentities {
  taskHash: string;
  environmentHash: string;
  runnerHash: string;
  policyHash: string;
  harnessHash: string;
}

interface EvidenceBinding {
  ref: string;
  hash: string;
}

export interface BenchmarkGovernanceInput {
  benchmarkId: string;
  benchmarkVersion: string;
  generatedAt: string;
  identities: GovernedRunIdentities;
  splits: Array<{
    id: BenchmarkSplitId;
    taskSetHash: string;
    access: "public" | "restricted";
  }>;
  splitIsolation: {
    policyVersion: string;
    evidenceRef: string;
    evidenceHash: string;
    overlapCount: number;
    holdoutLabelsExcludedFromFit: boolean;
    privateChallengeHidden: boolean;
  };
  contamination: {
    policyVersion: string;
    evidenceRef: string;
    evidenceHash: string;
    suspectedAction: "quarantine";
    confirmedAction: "retire";
  };
  saturation: {
    policyVersion: string;
    metric: "pass_rate";
    threshold: number;
    minimumSamples: number;
    action: "refresh_private_challenge";
  };
  reproducibility: {
    runManifestRequired: boolean;
    artifactEvidenceRequired: boolean;
    immutableEnvironmentRequired: boolean;
  };
  leaderboard: {
    forceRanking: boolean;
    incomparableDisplay: "INCOMPARABLE";
  };
  domainAdapters: Array<{
    domain: GovernedDomain;
    adapterId: string;
    adapterVersion: string;
    status: "candidate" | "active";
    observabilityBoundary?: EvidenceBinding;
    targetPack?: EvidenceBinding;
    conformance?: EvidenceBinding;
  }>;
}

export type BenchmarkGovernanceReasonCode =
  | "GOVERNANCE_SPLIT_MISSING"
  | "GOVERNANCE_SPLIT_OVERLAP"
  | "GOVERNANCE_SPLIT_ISOLATION_FAILED"
  | "GOVERNANCE_PRIVATE_CHALLENGE_EXPOSED"
  | "GOVERNANCE_HOLDOUT_EXPOSED"
  | "GOVERNANCE_DOMAIN_MISSING"
  | "GOVERNANCE_CONTAMINATION_POLICY_INCOMPLETE"
  | "GOVERNANCE_SATURATION_POLICY_INCOMPLETE"
  | "GOVERNANCE_REPRODUCIBILITY_INCOMPLETE"
  | "GOVERNANCE_FORCED_RANKING_FORBIDDEN";

export interface BenchmarkGovernanceReport {
  schemaVersion: "0.1.0";
  artifactType: "benchmark_governance_report";
  product: typeof PRODUCT_NAME;
  benchmarkId: string;
  benchmarkVersion: string;
  generatedAt: string;
  status: "DIAGNOSTIC_ONLY";
  gateAuthority: "NONE";
  governanceStatus: "POLICY_COMPLETE" | "BLOCKED";
  policyReviewDisposition: "REVIEW_READY" | "BLOCKED";
  reasonCodes: BenchmarkGovernanceReasonCode[];
  source: {
    inputHash: string;
  };
  identities: GovernedRunIdentities;
  splitSummary: {
    required: BenchmarkSplitId[];
    present: BenchmarkSplitId[];
    uniqueTaskSetCount: number;
  };
  policyChecks: {
    contamination: "PASS" | "FAIL";
    splitIsolation: "PASS" | "FAIL";
    saturation: "PASS" | "FAIL";
    reproducibility: "PASS" | "FAIL";
    incomparableRuns: "DISPLAY_INCOMPARABLE";
  };
  domainReadiness: Array<{
    domain: GovernedDomain;
    adapterId: string;
    adapterVersion: string;
    requestedStatus: "candidate" | "active";
    disposition:
      | "EVIDENCE_BOUND_DIAGNOSTIC"
      | "BLOCKED_OBSERVABILITY";
    missingBindings: Array<
      "observability_boundary" | "target_pack" | "conformance"
    >;
  }>;
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

const REQUIRED_SPLITS: BenchmarkSplitId[] = [
  "development",
  "calibration",
  "holdout",
  "private_challenge"
];
const REQUIRED_DOMAINS: GovernedDomain[] = [
  "browser",
  "research",
  "multimodal",
  "customer_support"
];

const IDENTITY_AXES = [
  ["task", "taskHash"],
  ["environment", "environmentHash"],
  ["runner", "runnerHash"],
  ["policy", "policyHash"],
  ["harness", "harnessHash"]
] as const;

export function buildBenchmarkGovernanceReport(
  input: BenchmarkGovernanceInput
): BenchmarkGovernanceReport {
  validateInputShape(input);
  const reasons = new Set<BenchmarkGovernanceReasonCode>();
  const presentSplits = [...new Set(input.splits.map((split) => split.id))].sort();
  if (REQUIRED_SPLITS.some((split) => !presentSplits.includes(split))) {
    reasons.add("GOVERNANCE_SPLIT_MISSING");
  }
  if (
    new Set(input.splits.map((split) => split.taskSetHash)).size !==
    input.splits.length
  ) {
    reasons.add("GOVERNANCE_SPLIT_OVERLAP");
  }
  if (
    input.splits.find((split) => split.id === "private_challenge")?.access ===
    "public"
  ) {
    reasons.add("GOVERNANCE_PRIVATE_CHALLENGE_EXPOSED");
  }
  if (
    input.splits.find((split) => split.id === "holdout")?.access === "public"
  ) {
    reasons.add("GOVERNANCE_HOLDOUT_EXPOSED");
  }
  if (
    REQUIRED_DOMAINS.some(
      (domain) =>
        !input.domainAdapters.some((adapter) => adapter.domain === domain)
    )
  ) {
    reasons.add("GOVERNANCE_DOMAIN_MISSING");
  }
  const splitIsolationPass =
    isVersion(input.splitIsolation.policyVersion) &&
    isPortableRef(input.splitIsolation.evidenceRef) &&
    isHash(input.splitIsolation.evidenceHash) &&
    input.splitIsolation.overlapCount === 0 &&
    input.splitIsolation.holdoutLabelsExcludedFromFit === true &&
    input.splitIsolation.privateChallengeHidden === true;
  if (!splitIsolationPass) {
    reasons.add("GOVERNANCE_SPLIT_ISOLATION_FAILED");
  }
  const contaminationPass =
    isVersion(input.contamination.policyVersion) &&
    isPortableRef(input.contamination.evidenceRef) &&
    isHash(input.contamination.evidenceHash) &&
    input.contamination.suspectedAction === "quarantine" &&
    input.contamination.confirmedAction === "retire";
  if (!contaminationPass) {
    reasons.add("GOVERNANCE_CONTAMINATION_POLICY_INCOMPLETE");
  }
  const saturationPass =
    isVersion(input.saturation.policyVersion) &&
    input.saturation.metric === "pass_rate" &&
    Number.isFinite(input.saturation.threshold) &&
    input.saturation.threshold > 0 &&
    input.saturation.threshold < 1 &&
    Number.isSafeInteger(input.saturation.minimumSamples) &&
    input.saturation.minimumSamples > 0 &&
    input.saturation.action === "refresh_private_challenge";
  if (!saturationPass) {
    reasons.add("GOVERNANCE_SATURATION_POLICY_INCOMPLETE");
  }
  const reproducibilityPass =
    input.reproducibility.runManifestRequired === true &&
    input.reproducibility.artifactEvidenceRequired === true &&
    input.reproducibility.immutableEnvironmentRequired === true;
  if (!reproducibilityPass) {
    reasons.add("GOVERNANCE_REPRODUCIBILITY_INCOMPLETE");
  }
  if (
    input.leaderboard.forceRanking !== false ||
    input.leaderboard.incomparableDisplay !== "INCOMPARABLE"
  ) {
    reasons.add("GOVERNANCE_FORCED_RANKING_FORBIDDEN");
  }

  const domainReadiness = input.domainAdapters
    .map((adapter) => domainReadinessFor(adapter))
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const reasonCodes = [...reasons].sort();
  const governanceStatus =
    reasonCodes.length === 0
      ? ("POLICY_COMPLETE" as const)
      : ("BLOCKED" as const);
  const content = {
    schemaVersion: "0.1.0" as const,
    artifactType: "benchmark_governance_report" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    benchmarkId: input.benchmarkId,
    benchmarkVersion: input.benchmarkVersion,
    generatedAt: input.generatedAt,
    status: "DIAGNOSTIC_ONLY" as const,
    gateAuthority: "NONE" as const,
    governanceStatus,
    policyReviewDisposition:
      governanceStatus === "POLICY_COMPLETE"
        ? ("REVIEW_READY" as const)
        : ("BLOCKED" as const),
    reasonCodes,
    source: {
      inputHash: sha256Text(stableJson(input))
    },
    identities: { ...input.identities },
    splitSummary: {
      required: [...REQUIRED_SPLITS],
      present: presentSplits,
      uniqueTaskSetCount: new Set(
        input.splits.map((split) => split.taskSetHash)
      ).size
    },
    policyChecks: {
      splitIsolation: splitIsolationPass
        ? ("PASS" as const)
        : ("FAIL" as const),
      contamination: contaminationPass ? ("PASS" as const) : ("FAIL" as const),
      saturation: saturationPass ? ("PASS" as const) : ("FAIL" as const),
      reproducibility: reproducibilityPass
        ? ("PASS" as const)
        : ("FAIL" as const),
      incomparableRuns: "DISPLAY_INCOMPARABLE" as const
    },
    domainReadiness
  };
  return {
    ...content,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(content))
    }
  };
}

export function compareGovernedRunIdentities(
  left: GovernedRunIdentities,
  right: GovernedRunIdentities
): {
  status: "COMPARABLE" | "INCOMPARABLE";
  mismatchedAxes: Array<
    "task" | "environment" | "runner" | "policy" | "harness"
  >;
} {
  validateIdentities(left);
  validateIdentities(right);
  const mismatchedAxes = IDENTITY_AXES.filter(
    ([, key]) => left[key] !== right[key]
  ).map(([axis]) => axis);
  return {
    status: mismatchedAxes.length === 0 ? "COMPARABLE" : "INCOMPARABLE",
    mismatchedAxes
  };
}

export function assertBenchmarkGovernanceReportIntegrity(
  report: BenchmarkGovernanceReport
): void {
  const { integrity, ...content } = report;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content)) ||
    report.status !== "DIAGNOSTIC_ONLY" ||
    report.gateAuthority !== "NONE" ||
    report.policyReviewDisposition !==
      (report.reasonCodes.length === 0 ? "REVIEW_READY" : "BLOCKED") ||
    report.governanceStatus !==
      (report.reasonCodes.length === 0 ? "POLICY_COMPLETE" : "BLOCKED")
  ) {
    throw new Error("Benchmark governance report integrity is invalid.");
  }
}

export function renderBenchmarkGovernanceMarkdown(
  report: BenchmarkGovernanceReport
): string {
  const domains = report.domainReadiness.map(
    (entry) =>
      `| ${entry.domain} | ${entry.requestedStatus} | ${entry.disposition} | ${
        entry.missingBindings.join(", ") || "none"
      } |`
  );
  return [
    "# Benchmark Governance",
    "",
    `Status: ${report.status}`,
    `Gate authority: ${report.gateAuthority}`,
    `Policy status: ${report.governanceStatus}`,
    `Policy review: ${report.policyReviewDisposition}`,
    "",
    "## Policy checks",
    "",
    `- Split isolation: ${report.policyChecks.splitIsolation}`,
    `- Contamination: ${report.policyChecks.contamination}`,
    `- Saturation: ${report.policyChecks.saturation}`,
    `- Reproducibility: ${report.policyChecks.reproducibility}`,
    `- Incomparable runs: ${report.policyChecks.incomparableRuns}`,
    "",
    "## Domain observability",
    "",
    "| domain | requested | disposition | missing bindings |",
    "| --- | --- | --- | --- |",
    ...(domains.length > 0
      ? domains
      : ["| none | none | BLOCKED_OBSERVABILITY | all |"]),
    "",
    "This report is diagnostic policy evidence only. It does not publish a benchmark, activate an adapter, rank incomparable runs, or create gate authority."
  ].join("\n");
}

function domainReadinessFor(
  adapter: BenchmarkGovernanceInput["domainAdapters"][number]
): BenchmarkGovernanceReport["domainReadiness"][number] {
  const missingBindings: BenchmarkGovernanceReport["domainReadiness"][number]["missingBindings"] =
    [];
  if (!adapter.observabilityBoundary) {
    missingBindings.push("observability_boundary");
  }
  if (!adapter.targetPack) {
    missingBindings.push("target_pack");
  }
  if (!adapter.conformance) {
    missingBindings.push("conformance");
  }
  if (adapter.status === "active" && missingBindings.length > 0) {
    throw new Error(
      `Active domain adapter ${adapter.adapterId} requires observability boundary, target-pack, and conformance bindings.`
    );
  }
  for (const binding of [
    adapter.observabilityBoundary,
    adapter.targetPack,
    adapter.conformance
  ]) {
    if (
      binding &&
      (!isPortableRef(binding.ref) || !isHash(binding.hash))
    ) {
      throw new Error("Domain adapter evidence binding is invalid.");
    }
  }
  return {
    domain: adapter.domain,
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    requestedStatus: adapter.status,
    disposition:
      missingBindings.length > 0
        ? "BLOCKED_OBSERVABILITY"
        : "EVIDENCE_BOUND_DIAGNOSTIC",
    missingBindings
  };
}

function validateInputShape(input: BenchmarkGovernanceInput): void {
  if (
    !input ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.benchmarkId ?? "") ||
    !isVersion(input.benchmarkVersion) ||
    !isIsoTimestamp(input.generatedAt) ||
    !Array.isArray(input.splits) ||
    !input.splitIsolation ||
    !input.contamination ||
    !input.saturation ||
    !input.reproducibility ||
    !input.leaderboard ||
    !Array.isArray(input.domainAdapters)
  ) {
    throw new Error("Benchmark governance input is missing required fields.");
  }
  validateIdentities(input.identities);
  const splitIds = new Set<BenchmarkSplitId>();
  for (const split of input.splits) {
    if (
      !REQUIRED_SPLITS.includes(split.id) ||
      splitIds.has(split.id) ||
      !isHash(split.taskSetHash) ||
      !["public", "restricted"].includes(split.access)
    ) {
      throw new Error("Benchmark governance split is invalid or duplicated.");
    }
    splitIds.add(split.id);
  }
  const domains = new Set<GovernedDomain>();
  for (const adapter of input.domainAdapters) {
    if (
      domains.has(adapter.domain) ||
      !REQUIRED_DOMAINS.includes(adapter.domain) ||
      !adapter.adapterId.trim() ||
      !isVersion(adapter.adapterVersion) ||
      !["candidate", "active"].includes(adapter.status)
    ) {
      throw new Error("Benchmark governance domain adapter is invalid.");
    }
    domains.add(adapter.domain);
  }
}

function validateIdentities(identities: GovernedRunIdentities): void {
  if (
    !identities ||
    IDENTITY_AXES.some(([, key]) => !isHash(identities[key]))
  ) {
    throw new Error(
      "Governed runs require task, environment, runner, policy, and harness hashes."
    );
  }
}

function isHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value);
}

function isPortableRef(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..") &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !/[\u0000-\u001f]/u.test(value)
  );
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
