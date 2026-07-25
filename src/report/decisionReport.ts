import { PRODUCT_NAME } from "../core/product.js";
import type { ComparisonResult } from "../regression/compare.js";
import type { GateResult } from "../regression/gate.js";
import { sha256Text, stableJson } from "../utils/hash.js";

type HardFailureLike = ComparisonResult["hardFailures"][number] & {
  owner?: string;
  evidenceEventIds?: string[];
};

export interface DecisionReportInput {
  comparison: ComparisonResult;
  gate: GateResult;
  generatedAt?: string;
  candidateComparabilityFingerprint?: string;
  ownerSource?: string;
  sourceFileHashes?: {
    comparison: string;
    gate: string;
    reliability?: string;
    validity?: string;
  };
  caseEvidence?: Array<{
    caseId: string;
    failureCode: string;
    evidenceEventIds: string[];
  }>;
  reliability?: {
    resultType?: string;
    conclusion?: string;
    gateEligibility?: string;
    quarantinedCases?: Array<
      string | { caseId: string; consistency: number; status: string }
    >;
    metrics?: {
      sampleSize?: { observed?: number; minimum?: number; requested?: number; missing?: number };
      missingRate?: number;
      dimensionVariance?: Array<{ dimension: string; variance: number }>;
      pairedDelta?: {
        score?: number;
        mean?: number;
        variance?: number;
        interval?: { lower: number; upper: number };
      };
    };
  };
  validity?: {
    resultType?: string;
    status?: string;
    metrics?: {
      sampleSize?: {
        planned?: number;
        observed?: number;
        labeled?: number;
        adjudicated?: number;
        required?: number;
        minimum?: number;
      };
      p0Recall?: number | null;
      falsePassCount?: number | null;
      overallAgreement?: number | null;
      cohenKappa?: number | null;
    };
  };
}

export interface DecisionReport {
  schemaVersion: "0.1.0";
  artifactType: "decision_report";
  product: typeof PRODUCT_NAME;
  targetId: string;
  suite: string;
  generatedAt: string;
  gateDecision: GateResult["decision"];
  gateRuleId: GateResult["ruleId"];
  classification: ComparisonResult["classification"];
  releaseAuthority: "source_gate_only";
  gatePolicy: GateResult["gatePolicy"];
  gatePolicyHash: string;
  policyVersion: string;
  candidateComparabilityFingerprint?: string;
  ownerSource?: string;
  executiveSummary: {
    releaseAction: GateResult["decision"];
    topRisks: DecisionRisk[];
    reasons: string[];
  };
  caseImpacts: DecisionCaseImpact[];
  recommendations: DecisionRecommendation[];
  retest: {
    required: boolean;
    conditions: string[];
  };
  statistics?: DecisionStatistics;
  evidenceRefs: string[];
  provenance: {
    comparisonHash: string;
    gateResultHash: string;
    gatePolicyHash: string;
    sourceArtifacts: Array<{
      role: "comparison" | "gate" | "reliability" | "validity";
      ref: string;
      sha256: string;
      hashKind: "file_bytes" | "canonical_json";
    }>;
  };
  diagnostics: string[];
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export interface DecisionRisk {
  severity: "P0" | "P1";
  code: string;
  owner: string;
  affectedCaseIds: string[];
  why: string;
  evidenceRefs: string[];
}

export interface DecisionCaseImpact {
  caseId: string;
  classification: ComparisonResult["caseDeltas"][number]["classification"];
  baselineVerdict?: string;
  candidateVerdict?: string;
  scoreDelta: number | null;
  newHardFailures: string[];
  resolvedHardFailures: string[];
  evidenceRefs: string[];
  retestCondition: string;
}

export interface DecisionRecommendation {
  failureCode: string;
  owner: string;
  affectedCaseIds: string[];
  action: string;
  evidenceRefs: string[];
}

export interface DecisionStatistics {
  sampleSize?: { observed?: number; minimum?: number; requested?: number; required?: number; missing?: number };
  missingRate?: number;
  variance?: Array<{ dimension: string; variance: number }>;
  pairedDelta?: { score?: number; mean?: number; variance?: number };
  confidenceIntervals?: Array<{ metric: string; lower: number; upper: number }>;
  validity?: {
    sampleSize?: {
      planned?: number;
      observed?: number;
      labeled?: number;
      adjudicated?: number;
      required?: number;
      minimum?: number;
    };
    p0Recall?: number | null;
    falsePassCount?: number | null;
    overallAgreement?: number | null;
    cohenKappa?: number | null;
  };
}

export function buildDecisionReport(input: DecisionReportInput): DecisionReport {
  assertDecisionInputs(input);
  const evidenceRefs = unique([
    "comparison:comparison-result.json",
    "gate:gate-result.json",
    ...input.gate.evidenceRefs,
    ...input.comparison.evidenceRefs.baseline,
    ...input.comparison.evidenceRefs.candidate
  ]);
  const failures = input.comparison.hardFailures.map((failure) =>
    withCaseEvidence(failure as HardFailureLike, input.caseEvidence)
  );
  const risks = failures.map((failure) =>
    riskFromFailure(failure)
  );
  const caseImpacts = input.comparison.caseDeltas.map((delta) =>
    caseImpact(delta, failures)
  );
  const gateResultHash = sha256Text(stableJson(input.gate));
  const sourceArtifacts: DecisionReport["provenance"]["sourceArtifacts"] = [
    {
      role: "comparison",
      ref: "comparison-result.json",
      sha256:
        input.sourceFileHashes?.comparison ??
        sha256Text(stableJson(input.comparison)),
      hashKind: input.sourceFileHashes?.comparison
        ? "file_bytes"
        : "canonical_json"
    },
    {
      role: "gate",
      ref: "gate-result.json",
      sha256: input.sourceFileHashes?.gate ?? gateResultHash,
      hashKind: input.sourceFileHashes?.gate
        ? "file_bytes"
        : "canonical_json"
    }
  ];
  if (input.reliability) {
    sourceArtifacts.push({
      role: "reliability",
      ref: "reliability-report.json",
      sha256:
        input.sourceFileHashes?.reliability ??
        sha256Text(stableJson(input.reliability)),
      hashKind: input.sourceFileHashes?.reliability
        ? "file_bytes"
        : "canonical_json"
    });
  }
  if (input.validity) {
    sourceArtifacts.push({
      role: "validity",
      ref: "validity-report.json",
      sha256:
        input.sourceFileHashes?.validity ??
        sha256Text(stableJson(input.validity)),
      hashKind: input.sourceFileHashes?.validity
        ? "file_bytes"
        : "canonical_json"
    });
  }
  const recommendations = risks.map((risk) => recommendationFromRisk(risk));
  const diagnostics = decisionDiagnostics(input);
  const content = {
    schemaVersion: "0.1.0" as const,
    artifactType: "decision_report" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    targetId: input.gate.targetId,
    suite: input.gate.suite,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    gateDecision: input.gate.decision,
    gateRuleId: input.gate.ruleId,
    classification: input.comparison.classification,
    releaseAuthority: "source_gate_only" as const,
    gatePolicy: input.gate.gatePolicy,
    gatePolicyHash: input.gate.gatePolicy.policyHash,
    policyVersion: input.gate.gatePolicy.policyVersion,
    ...(input.candidateComparabilityFingerprint
      ? { candidateComparabilityFingerprint: input.candidateComparabilityFingerprint }
      : {}),
    ...(input.ownerSource ? { ownerSource: input.ownerSource } : {}),
    executiveSummary: {
      releaseAction: input.gate.decision,
      topRisks: risks,
      reasons: input.gate.reasons
    },
    caseImpacts,
    recommendations,
    retest: {
      required:
        input.gate.decision !== "PASS" ||
        risks.length > 0 ||
        caseImpacts.some((impact) => impact.classification !== "UNCHANGED"),
      conditions: unique(caseImpacts.map((impact) => impact.retestCondition))
    },
    ...statistics(input),
    evidenceRefs,
    provenance: {
      comparisonHash: input.comparison.integrity.comparisonHash,
      gateResultHash,
      gatePolicyHash: input.gate.gatePolicy.policyHash,
      sourceArtifacts
    },
    diagnostics
  };
  return {
    ...content,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(content))
    }
  };
}

export function renderDecisionReportMarkdown(report: DecisionReport): string {
  const lines = [
    "# Agent Workflow Bench Decision Report",
    "",
    `Target: ${report.targetId}`,
    `Suite: ${report.suite}`,
    `Gate Decision: ${report.gateDecision}`,
    `Gate Rule: ${report.gateRuleId}`,
    `Classification: ${report.classification}`,
    `Policy Version: ${report.policyVersion}`,
    `Release Authority: ${report.releaseAuthority}`,
    "",
    "## Top Risks",
    report.executiveSummary.topRisks.length === 0
      ? "No blocking hard failures were observed."
      : report.executiveSummary.topRisks
          .map(
            (risk) =>
              `- ${risk.severity}:${risk.code}; owner=${risk.owner}; cases=${risk.affectedCaseIds.join(", ") || "none"}; evidence=${risk.evidenceRefs.join(", ") || "none"}`
          )
          .join("\n"),
    "",
    "## Case Impacts",
    report.caseImpacts.length === 0
      ? "No case deltas were recorded."
      : report.caseImpacts
          .map(
            (impact) =>
              `- ${impact.caseId}: ${impact.classification}; scoreDelta=${impact.scoreDelta ?? "not-comparable"}; Retest condition: ${impact.retestCondition}; evidence=${impact.evidenceRefs.join(", ") || "none"}`
          )
          .join("\n"),
    "",
    "## Recommendations",
    report.recommendations.length === 0
      ? "No workflow repair recommendation is required by this comparison."
      : report.recommendations
          .map(
            (recommendation) =>
              `- ${recommendation.failureCode}; owner=${recommendation.owner}; action=${recommendation.action}; evidence=${recommendation.evidenceRefs.join(", ") || "none"}`
          )
          .join("\n"),
    "",
    "## Evidence",
    ...report.evidenceRefs.map((ref) => `- ${ref}`)
  ];
  if (report.statistics) {
    lines.splice(
      lines.length - report.evidenceRefs.length - 1,
      0,
      "## Statistics",
      renderStatistics(report.statistics),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function riskFromFailure(failure: HardFailureLike): DecisionRisk {
  const owner = failure.owner ?? "workflow-owner";
  return {
    severity: failure.severity,
    code: failure.code,
    owner,
    affectedCaseIds: failure.caseId ? [failure.caseId] : [],
    why: failure.why,
    evidenceRefs: evidenceRefsForFailure(failure)
  };
}

function withCaseEvidence(
  failure: HardFailureLike,
  caseEvidence: DecisionReportInput["caseEvidence"]
): HardFailureLike {
  const matching = caseEvidence?.find(
    (item) =>
      item.caseId === failure.caseId && item.failureCode === failure.code
  );
  return {
    ...failure,
    owner: failure.owner ?? "workflow-owner",
    evidenceEventIds:
      matching?.evidenceEventIds ?? failure.evidenceEventIds ?? []
  };
}

function recommendationFromRisk(risk: DecisionRisk): DecisionRecommendation {
  return {
    failureCode: risk.code,
    owner: risk.owner,
    affectedCaseIds: risk.affectedCaseIds,
    action: `Resolve ${risk.code}: ${risk.why} Then rerun the affected cases with fresh qualified workflow-trace evidence.`,
    evidenceRefs: risk.evidenceRefs
  };
}

function caseImpact(
  delta: ComparisonResult["caseDeltas"][number],
  failures: HardFailureLike[]
): DecisionCaseImpact {
  const relatedFailures = failures.filter((failure) => failure.caseId === delta.caseId);
  const owner =
    relatedFailures.map((failure) => failure.owner).find(Boolean) ??
    "workflow-owner";
  return {
    caseId: delta.caseId,
    classification: delta.classification,
    baselineVerdict: delta.baselineVerdict,
    candidateVerdict: delta.candidateVerdict,
    scoreDelta: delta.scoreDelta,
    newHardFailures: delta.newHardFailures,
    resolvedHardFailures: delta.resolvedHardFailures,
    evidenceRefs: unique(relatedFailures.flatMap(evidenceRefsForFailure)),
    retestCondition: `Retest ${delta.caseId} after ${owner} resolves observed hard failures and fresh candidate workflow-trace evidence is collected.`
  };
}

function evidenceRefsForFailure(failure: HardFailureLike): string[] {
  return (failure.evidenceEventIds ?? []).map(
    (eventId) => `${failure.source}:workflow-trace.json#event=${eventId}`
  );
}

function statistics(input: DecisionReportInput): { statistics?: DecisionStatistics } {
  const output: DecisionStatistics = {};
  const reliabilityMetrics = input.reliability?.metrics;
  if (reliabilityMetrics?.sampleSize) {
    output.sampleSize = reliabilityMetrics.sampleSize;
  }
  if (reliabilityMetrics?.missingRate !== undefined) {
    output.missingRate = reliabilityMetrics.missingRate;
  }
  if (reliabilityMetrics?.dimensionVariance) {
    output.variance = reliabilityMetrics.dimensionVariance.map(
      ({ dimension, variance }) => ({ dimension, variance })
    );
  }
  const interval = reliabilityMetrics?.pairedDelta?.interval;
  if (reliabilityMetrics?.pairedDelta) {
    const { interval: _interval, ...pairedDelta } = reliabilityMetrics.pairedDelta;
    if (Object.keys(pairedDelta).length > 0) {
      output.pairedDelta = pairedDelta;
    }
  }
  if (interval) {
    output.confidenceIntervals = [
      {
        metric: "pairedScoreDelta",
        lower: interval.lower,
        upper: interval.upper
      }
    ];
  }
  const validityMetrics = input.validity?.metrics;
  if (validityMetrics) {
    const validity: NonNullable<DecisionStatistics["validity"]> = {};
    if (validityMetrics.sampleSize) {
      const {
        planned,
        observed,
        labeled,
        adjudicated,
        required,
        minimum
      } = validityMetrics.sampleSize;
      validity.sampleSize = {
        ...(planned !== undefined ? { planned } : {}),
        ...(observed !== undefined ? { observed } : {}),
        ...(labeled !== undefined ? { labeled } : {}),
        ...(adjudicated !== undefined ? { adjudicated } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(minimum !== undefined ? { minimum } : {})
      };
    }
    for (const key of [
      "p0Recall",
      "falsePassCount",
      "overallAgreement",
      "cohenKappa"
    ] as const) {
      const value = validityMetrics[key];
      if (value !== undefined) {
        validity[key] = value;
      }
    }
    output.validity = validity;
  }
  return Object.keys(output).length === 0 ? {} : { statistics: output };
}

function decisionDiagnostics(input: DecisionReportInput): string[] {
  const diagnostics: string[] = [];
  if (
    input.reliability &&
    (input.reliability.gateEligibility === "DIAGNOSTIC_ONLY" ||
      input.reliability.gateEligibility === "BLOCK")
  ) {
    diagnostics.push(
      `Reliability evidence is ${input.reliability.gateEligibility}; no strong statistical conclusion is implied.`
    );
  }
  if (
    input.validity &&
    input.validity.status !== undefined &&
    input.validity.status !== "PASS"
  ) {
    diagnostics.push(
      `External validity status is ${input.validity.status}; the report does not replace required human truth.`
    );
  }
  return diagnostics;
}

function assertDecisionInputs(input: DecisionReportInput): void {
  const comparison = input.comparison;
  const gate = input.gate;
  if (
    gate.targetId !== comparison.candidate.targetId ||
    gate.suite !== comparison.candidate.suite ||
    gate.comparisonClassification !== comparison.classification
  ) {
    throw new Error(
      "Decision report gate identity does not match the comparison artifact."
    );
  }
  if (
    !comparison.gatePolicy ||
    stableJson(gate.gatePolicy) !== stableJson(comparison.gatePolicy)
  ) {
    throw new Error(
      "Decision report gate policy does not match the comparison policy binding."
    );
  }
  if (
    input.generatedAt !== undefined &&
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new Error("Decision report generatedAt must be an ISO timestamp.");
  }
  for (const hash of Object.values(input.sourceFileHashes ?? {})) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
      throw new Error("Decision report source file hashes must be SHA-256 values.");
    }
  }
}

function renderStatistics(statistics: DecisionStatistics): string {
  const lines: string[] = [];
  if (statistics.sampleSize) {
    lines.push(
      `- Sample size: observed=${statistics.sampleSize.observed ?? "unknown"}; minimum=${statistics.sampleSize.minimum ?? "unknown"}`
    );
  }
  if (statistics.missingRate !== undefined) {
    lines.push(`- Missing rate: ${statistics.missingRate}`);
  }
  for (const item of statistics.variance ?? []) {
    lines.push(`- Variance ${item.dimension}: ${item.variance}`);
  }
  for (const item of statistics.confidenceIntervals ?? []) {
    lines.push(`- Confidence interval ${item.metric}: [${item.lower}, ${item.upper}]`);
  }
  return lines.length === 0 ? "No statistical evidence was supplied." : lines.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
