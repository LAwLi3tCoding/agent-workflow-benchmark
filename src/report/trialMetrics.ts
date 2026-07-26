import { PRODUCT_NAME } from "../core/product.js";
import type { ReliabilityReport, ReliabilitySample } from "../reliability/reliability.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export type TrialMetricsStatus = "PASS" | "DIAGNOSTIC_ONLY" | "BLOCK";

export type TrialMetricsReasonCode =
  | "SOURCE_NOT_INDEPENDENTLY_VERIFIED"
  | "SOURCE_GATE_NOT_ELIGIBLE"
  | "SOURCE_CONCLUSION_NOT_RELIABLE"
  | "SOURCE_HAS_MISSING_TRIALS"
  | "SOURCE_HAS_DUPLICATE_EVIDENCE"
  | "SOURCE_DEBUG_HEALTH_NOT_PASS"
  | "TRIAL_EVIDENCE_NOT_ALL_LIVE_WORKFLOW_TRACE"
  | "TRIAL_EVIDENCE_NOT_ALL_QUALIFIED"
  | "TRIAL_EVIDENCE_NOT_ALL_ATTEMPT_BOUND"
  | "TRIAL_METRICS_NO_OBSERVED_TRIALS";

export type TrialMetricsSourceReport = ReliabilityReport;

export interface TrialMetricsReportInput {
  source: TrialMetricsSourceReport;
  sourceRef: string;
  sourceHash: string;
  kValues?: number[];
  generatedAt?: string;
}

export interface TrialMetric {
  k: number;
  passAtK: number;
  passK: number;
}

export interface TrialMetricsReport {
  schemaVersion: "0.1.0";
  artifactType: "trial_metrics_report";
  product: typeof PRODUCT_NAME;
  generatedAt: string;
  source: {
    ref: string;
    sha256: string;
    contentHash: string;
    studyId: string;
    studyKind: TrialMetricsSourceReport["study"]["kind"];
    gateEligibility: TrialMetricsSourceReport["gateEligibility"];
    conclusion: TrialMetricsSourceReport["conclusion"];
  };
  status: TrialMetricsStatus;
  reasonCodes: TrialMetricsReasonCode[];
  counts: {
    trials: number;
    successes: number;
    blocks: number;
    diagnosticOnly: number;
    missing: number;
  };
  evidenceEligibility: {
    eligible: boolean;
    liveWorkflowTraceCount: number;
    qualifiedObserverCount: number;
    attemptBoundCount: number;
  };
  metrics: TrialMetric[];
  methodology: {
    passAtK: "1 - C(n-c,k) / C(n,k)";
    passK: "C(c,k) / C(n,k)";
    successDefinition: "Only gateDecision PASS counts as success";
    estimator: "draw_without_replacement";
    trustCeiling: "Reliability reports are self-authenticating inputs; without independent source revalidation, trial metrics remain diagnostic-only";
    kPolicy: string;
  };
  trials: Array<{
    sampleId: string;
    candidateRunId: string;
    gateDecision: "PASS" | "BLOCK" | "DIAGNOSTIC_ONLY";
    success: boolean;
    evidenceKind: ReliabilitySample["context"]["evidenceKind"];
    observationLevel: ReliabilitySample["context"]["observationLevel"];
    observerQualificationStatus: ReliabilitySample["context"]["observerQualificationStatus"];
    attemptFingerprint: string;
  }>;
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export function buildTrialMetricsReport(
  input: TrialMetricsReportInput
): TrialMetricsReport {
  assertSourceIntegrity(input.source, input.sourceHash);
  const observed = input.source.samples.filter(
    (sample): sample is ReliabilitySample & { status: "observed" } =>
      sample.status === "observed" && sample.outcome !== undefined
  );
  const kValues = normalizeKValues(input.kValues, observed.length);
  const successes = observed.filter(
    (sample) => sample.outcome?.gateDecision === "PASS"
  ).length;
  const blocks = observed.filter(
    (sample) => sample.outcome?.gateDecision === "BLOCK"
  ).length;
  const diagnosticOnly = observed.filter(
    (sample) => sample.outcome?.gateDecision === "DIAGNOSTIC_ONLY"
  ).length;
  const liveWorkflowTraceCount = observed.filter(
    (sample) =>
      sample.context.executionMode === "live" &&
      sample.context.evidenceKind === "live" &&
      sample.context.observationLevel === "workflow_trace"
  ).length;
  const qualifiedObserverCount = observed.filter(
    (sample) => sample.context.observerQualificationStatus === "valid"
  ).length;
  const attemptBoundCount = observed.filter((sample) =>
    /^sha256:[a-f0-9]{64}$/u.test(sample.attemptFingerprint ?? "")
  ).length;
  const reasonCodes = reasonCodesForSource(input.source, {
    observedCount: observed.length,
    liveWorkflowTraceCount,
    qualifiedObserverCount,
    attemptBoundCount
  });
  const status = statusFromReasons(reasonCodes, input.source);
  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    artifactType: "trial_metrics_report" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      ref: input.sourceRef,
      sha256: input.sourceHash,
      contentHash: input.source.integrity.contentHash,
      studyId: input.source.study.studyId,
      studyKind: input.source.study.kind,
      gateEligibility: input.source.gateEligibility,
      conclusion: input.source.conclusion
    },
    status,
    reasonCodes,
    counts: {
      trials: observed.length,
      successes,
      blocks,
      diagnosticOnly,
      missing: input.source.metrics.sampleSize.missing
    },
    evidenceEligibility: {
      eligible:
        observed.length > 0 &&
        liveWorkflowTraceCount === observed.length &&
        qualifiedObserverCount === observed.length &&
        attemptBoundCount === observed.length,
      liveWorkflowTraceCount,
      qualifiedObserverCount,
      attemptBoundCount
    },
    metrics: kValues.map((k) => ({
      k,
      passAtK: roundProbability(passAtK(observed.length, successes, k)),
      passK: roundProbability(passK(observed.length, successes, k))
    })),
    methodology: {
      passAtK: "1 - C(n-c,k) / C(n,k)" as const,
      passK: "C(c,k) / C(n,k)" as const,
      successDefinition: "Only gateDecision PASS counts as success" as const,
      estimator: "draw_without_replacement" as const,
      trustCeiling:
        "Reliability reports are self-authenticating inputs; without independent source revalidation, trial metrics remain diagnostic-only" as const,
      kPolicy:
        input.kValues && input.kValues.length > 0
          ? "CLI supplied k values, validated as 1 <= k <= n."
          : "Default k values cover 1..min(n,10)."
    },
    trials: observed.map((sample) => ({
      sampleId: sample.sampleId,
      candidateRunId: sample.candidateRunId!,
      gateDecision: normalizeGateDecision(sample.outcome!.gateDecision),
      success: sample.outcome!.gateDecision === "PASS",
      evidenceKind: sample.context.evidenceKind,
      observationLevel: sample.context.observationLevel,
      observerQualificationStatus: sample.context.observerQualificationStatus,
      attemptFingerprint: sample.attemptFingerprint!
    }))
  };
  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

export function assertTrialMetricsReportIntegrity(
  report: TrialMetricsReport
): void {
  const { integrity, ...content } = report;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Trial metrics report integrity verification failed.");
  }
}

export function renderTrialMetricsMarkdown(report: TrialMetricsReport): string {
  const metricRows = report.metrics.flatMap((metric) => [
    `| pass@${metric.k} | ${metric.passAtK} |`,
    `| pass^${metric.k} | ${metric.passK} |`
  ]);
  return [
    "# Trial Metrics Report",
    "",
    `Status: ${report.status}`,
    `Source: ${report.source.ref}`,
    `Source hash: ${report.source.sha256}`,
    `Study: ${report.source.studyId}`,
    "",
    "## Counts",
    `Trials: ${report.counts.trials}`,
    `Successes: ${report.counts.successes}`,
    `BLOCK: ${report.counts.blocks}`,
    `DIAGNOSTIC_ONLY: ${report.counts.diagnosticOnly}`,
    `Missing: ${report.counts.missing}`,
    "",
    "## Metrics",
    "| metric | estimate |",
    "| --- | ---: |",
    ...metricRows,
    "",
    "## Methodology",
    `pass@k: ${report.methodology.passAtK}`,
    `pass^k: ${report.methodology.passK}`,
    `Success: ${report.methodology.successDefinition}`,
    `Estimator: ${report.methodology.estimator}`,
    `Trust ceiling: ${report.methodology.trustCeiling}`,
    "",
    "## Reasons",
    report.reasonCodes.length > 0 ? report.reasonCodes.join("\n") : "None"
  ].join("\n");
}

function assertSourceIntegrity(
  source: TrialMetricsSourceReport,
  sourceHash: string
): void {
  const { integrity, ...content } = source;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Reliability report content integrity verification failed.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceHash)) {
    throw new Error("Reliability report source hash is invalid.");
  }
  if (sourceHash !== sha256Text(stableJson(source))) {
    throw new Error("Reliability report source hash does not match content.");
  }
}

function normalizeKValues(kValues: number[] | undefined, n: number): number[] {
  if (n < 1) {
    return [];
  }
  const values = kValues && kValues.length > 0
    ? kValues
    : Array.from({ length: Math.min(n, 10) }, (_, index) => index + 1);
  if (
    values.some((value) => !Number.isInteger(value) || value < 1 || value > n)
  ) {
    throw new Error("Trial metrics k values must be integers with 1 <= k <= observed trials.");
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function reasonCodesForSource(
  source: TrialMetricsSourceReport,
  evidence: {
    observedCount: number;
    liveWorkflowTraceCount: number;
    qualifiedObserverCount: number;
    attemptBoundCount: number;
  }
): TrialMetricsReasonCode[] {
  const reasons = new Set<TrialMetricsReasonCode>();
  reasons.add("SOURCE_NOT_INDEPENDENTLY_VERIFIED");
  if (source.gateEligibility !== "ELIGIBLE") {
    reasons.add("SOURCE_GATE_NOT_ELIGIBLE");
  }
  if (source.conclusion !== "RELIABLE" || !source.strongConclusionAllowed) {
    reasons.add("SOURCE_CONCLUSION_NOT_RELIABLE");
  }
  if (source.metrics.sampleSize.missing > 0) {
    reasons.add("SOURCE_HAS_MISSING_TRIALS");
  }
  if (source.metrics.duplicateEvidenceCount > 0) {
    reasons.add("SOURCE_HAS_DUPLICATE_EVIDENCE");
  }
  if (source.debugHealth.status !== "PASS") {
    reasons.add("SOURCE_DEBUG_HEALTH_NOT_PASS");
  }
  if (evidence.observedCount === 0) {
    reasons.add("TRIAL_METRICS_NO_OBSERVED_TRIALS");
  }
  if (evidence.liveWorkflowTraceCount !== evidence.observedCount) {
    reasons.add("TRIAL_EVIDENCE_NOT_ALL_LIVE_WORKFLOW_TRACE");
  }
  if (evidence.qualifiedObserverCount !== evidence.observedCount) {
    reasons.add("TRIAL_EVIDENCE_NOT_ALL_QUALIFIED");
  }
  if (evidence.attemptBoundCount !== evidence.observedCount) {
    reasons.add("TRIAL_EVIDENCE_NOT_ALL_ATTEMPT_BOUND");
  }
  return [...reasons];
}

function statusFromReasons(
  reasons: TrialMetricsReasonCode[],
  source: TrialMetricsSourceReport
): TrialMetricsStatus {
  if (source.gateEligibility === "BLOCK" || source.conclusion === "INVALID") {
    return "BLOCK";
  }
  return "DIAGNOSTIC_ONLY";
}

function normalizeGateDecision(
  value: string | undefined
): "PASS" | "BLOCK" | "DIAGNOSTIC_ONLY" {
  if (value === "PASS" || value === "BLOCK" || value === "DIAGNOSTIC_ONLY") {
    return value;
  }
  return "DIAGNOSTIC_ONLY";
}

function passAtK(n: number, c: number, k: number): number {
  return 1 - combinationRatio(n - c, n, k);
}

function passK(n: number, c: number, k: number): number {
  return combinationRatio(c, n, k);
}

function combinationRatio(subset: number, total: number, k: number): number {
  if (subset < k) {
    return 0;
  }
  let ratio = 1;
  for (let i = 0; i < k; i += 1) {
    ratio *= (subset - i) / (total - i);
  }
  return ratio;
}

function roundProbability(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
