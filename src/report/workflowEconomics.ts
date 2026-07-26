import type { SuiteResult } from "../core/types.js";
import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import {
  assertTraceDiffIntegrity,
  type TraceDiff,
  type TraceEventDelta
} from "./traceDiff.js";
import {
  assertTrajectoryReviewIntegrity,
  type TrajectoryFinding,
  type TrajectoryReviewReport
} from "./trajectoryReview.js";

export type WorkflowEconomicsStatus = "DIAGNOSTIC_ONLY";
export type WorkflowEconomicsGateAuthority = "NONE";
export type MetricStatus = "AVAILABLE" | "UNAVAILABLE";
export type ComparabilityStatus = "COMPARABLE" | "INCOMPARABLE";
export type ParetoClassification =
  | "CANDIDATE_DOMINATES"
  | "BASELINE_DOMINATES"
  | "TRADEOFF"
  | "INCOMPARABLE";

export interface BuildWorkflowEconomicsInput {
  traceDiff: TraceDiff;
  traceDiffRef: string;
  traceDiffHash: string;
  trajectoryReview: TrajectoryReviewReport;
  trajectoryReviewRef: string;
  trajectoryReviewHash: string;
  baselineSuite: SuiteResult;
  baselineSuiteRef: string;
  baselineSuiteHash: string;
  candidateSuite: SuiteResult;
  candidateSuiteRef: string;
  candidateSuiteHash: string;
  generatedAt: string;
}

export interface WorkflowEconomicsReport {
  schemaVersion: "0.1.0";
  artifactType: "workflow_economics_report";
  product: typeof PRODUCT_NAME;
  status: WorkflowEconomicsStatus;
  gateAuthority: WorkflowEconomicsGateAuthority;
  reasonCodes: [
    "DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY",
    "SOURCE_ARTIFACTS_REVALIDATED"
  ];
  generatedAt: string;
  sources: {
    traceDiff: WorkflowEconomicsSourceRef & {
      contentHash: string;
      evidenceLevel: TraceDiff["evidenceLevel"];
      comparability: TraceDiff["comparability"];
      sourceTraceHashes: string[];
    };
    trajectoryReview: WorkflowEconomicsSourceRef & {
      contentHash: string;
      traceDiffRef: string;
      traceDiffContentHash: string;
    };
    baselineSuite: WorkflowEconomicsSuiteSourceRef;
    candidateSuite: WorkflowEconomicsSuiteSourceRef;
  };
  comparability: {
    status: ComparabilityStatus;
    reasons: string[];
  };
  summary: {
    caseCount: number;
    comparableCases: number;
    unavailableMetricCount: number;
    candidateDominates: number;
    baselineDominates: number;
    tradeoff: number;
    incomparable: number;
  };
  metricAvailability: {
    planToAction: UnavailableMetric;
    replanning: UnavailableMetric;
    confidenceIntervals: UnavailableMetric;
  };
  cases: WorkflowEconomicsCase[];
  methodology: {
    classification: string;
    qualityMetric: "cappedScore";
    qualityScale: "0_to_100";
    costMetric: "tokens.total";
    latencyMetric: "efficiency.wallClockSeconds";
    missingnessRule: string;
  };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export interface WorkflowEconomicsCase {
  caseId: string;
  comparability: {
    status: ComparabilityStatus;
    reasons: string[];
  };
  baseline: WorkflowEconomicsLaneMetrics;
  candidate: WorkflowEconomicsLaneMetrics;
  deltas: {
    qualityScoreDelta: number;
    tokenTotalDelta?: number;
    wastedTokenDelta?: number;
    wallClockSecondsDelta?: number;
  };
  missingness: MissingMetric[];
  pareto: ParetoClassification;
  retryEvidence:
    | {
        status: "AVAILABLE";
        repeatedActionRefs: string[];
      }
    | {
        status: "UNAVAILABLE";
        repeatedActionRefs: [];
        reason: string;
      };
  validationLatency:
    | {
        status: "AVAILABLE";
        detectionLatencySteps: number;
        detectionRef: string;
        onsetRef: string;
      }
    | {
        status: "UNAVAILABLE";
        reason: string;
      };
  recovery:
    | {
        status: "AVAILABLE";
        attempts: number;
        outcome: TrajectoryFinding["recovery"]["outcome"];
      }
    | {
        status: "UNAVAILABLE";
        reason: string;
      };
  irreversibleSideEffectTiming:
    | {
        status: "AVAILABLE";
        refs: string[];
        firstPosition: number;
      }
    | {
        status: "UNAVAILABLE";
        refs: [];
        reason: string;
      };
}

export interface WorkflowEconomicsLaneMetrics {
  verdict: SuiteResult["caseResults"][number]["verdict"];
  qualityScore: number;
  tokens:
    | {
        status: "AVAILABLE";
        input: number;
        output: number;
        total: number;
        wasted: number;
        confidence: "high" | "medium" | "low";
      }
    | {
        status: "UNAVAILABLE";
        reason: string;
      };
  wallClock:
    | {
        status: "AVAILABLE";
        seconds: number;
      }
    | {
        status: "UNAVAILABLE";
        reason: string;
      };
}

export interface MissingMetric {
  lane: "baseline" | "candidate";
  metric: "tokens" | "tokenConfidence" | "wallClock";
  reason: string;
}

interface WorkflowEconomicsSourceRef {
  ref: string;
  sha256: string;
}

interface WorkflowEconomicsSuiteSourceRef extends WorkflowEconomicsSourceRef {
  runId: string;
  targetId: string;
  suite: string;
  caseCount: number;
  gatePolicy: {
    policyVersion: string;
    policyHash: string;
    rulesHash: string;
  };
}

interface UnavailableMetric {
  status: "UNAVAILABLE";
  reason: string;
}

type CaseResultWithOptionalMetrics = SuiteResult["caseResults"][number] & {
  tokens?: {
    input?: unknown;
    output?: unknown;
    total?: unknown;
    wasted?: unknown;
    costEstimateConfidence?: unknown;
  };
  efficiency?: {
    wallClockSeconds?: unknown;
  };
};

export function buildWorkflowEconomicsReport(
  input: BuildWorkflowEconomicsInput
): WorkflowEconomicsReport {
  validateSources(input);
  const baselineCases = caseMap(input.baselineSuite, "baseline");
  const candidateCases = caseMap(input.candidateSuite, "candidate");
  const traceCases = new Set(input.traceDiff.caseDiffs.map((caseDiff) => caseDiff.caseId));
  assertSameCaseSet(
    [...baselineCases.keys()],
    [...candidateCases.keys()],
    "baseline and candidate suite case set mismatch"
  );
  assertSameCaseSet(
    [...baselineCases.keys()],
    [...traceCases],
    "suite and trace-diff case set mismatch"
  );

  const reviewFindings = findingsByCase(input.trajectoryReview);
  const sourceComparabilityReasons = [
    ...input.traceDiff.comparability.reasons,
    ...gatePolicyComparabilityReasons(
      input.baselineSuite,
      input.candidateSuite
    )
  ];
  if (
    input.traceDiff.comparability.status === "INCOMPARABLE" &&
    sourceComparabilityReasons.length === 0
  ) {
    sourceComparabilityReasons.push(
      "trace diff is incomparable without a recorded reason"
    );
  }
  const caseReports = [...baselineCases.keys()].sort().map((caseId) => {
    const baseline = laneMetrics(baselineCases.get(caseId)!, "baseline");
    const candidate = laneMetrics(candidateCases.get(caseId)!, "candidate");
    const traceCase = input.traceDiff.caseDiffs.find((entry) => entry.caseId === caseId)!;
    const missingness = [
      ...missingMetrics(baseline, "baseline"),
      ...missingMetrics(candidate, "candidate")
    ];
    const reasons = comparabilityReasons(
      sourceComparabilityReasons,
      missingness
    );
    const comparability = {
      status: reasons.length === 0 ? "COMPARABLE" as const : "INCOMPARABLE" as const,
      reasons
    };
    return {
      caseId,
      comparability,
      baseline,
      candidate,
      deltas: metricDeltas(baseline, candidate),
      missingness,
      pareto: classifyPareto(comparability.status, baseline, candidate),
      retryEvidence: retryEvidence(traceCase.eventDeltas),
      validationLatency: validationLatency(reviewFindings.get(caseId)),
      recovery: recovery(reviewFindings.get(caseId)),
      irreversibleSideEffectTiming: irreversibleSideEffectTiming(traceCase.eventDeltas)
    };
  });

  const unavailableMetricCount = caseReports.reduce(
    (sum, caseReport) => sum + caseReport.missingness.length,
    0
  );
  const aggregateComparabilityReasons = [
    ...new Set(
      caseReports.flatMap((caseReport) => caseReport.comparability.reasons)
    )
  ].sort();
  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    artifactType: "workflow_economics_report" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    status: "DIAGNOSTIC_ONLY" as const,
    gateAuthority: "NONE" as const,
    reasonCodes: [
      "DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY",
      "SOURCE_ARTIFACTS_REVALIDATED"
    ] as [
      "DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY",
      "SOURCE_ARTIFACTS_REVALIDATED"
    ],
    generatedAt: input.generatedAt,
    sources: {
      traceDiff: {
        ref: input.traceDiffRef,
        sha256: input.traceDiffHash,
        contentHash: input.traceDiff.integrity.contentHash,
        evidenceLevel: input.traceDiff.evidenceLevel,
        comparability: input.traceDiff.comparability,
        sourceTraceHashes: [...input.traceDiff.integrity.sourceTraceHashes].sort()
      },
      trajectoryReview: {
        ref: input.trajectoryReviewRef,
        sha256: input.trajectoryReviewHash,
        contentHash: input.trajectoryReview.integrity.contentHash,
        traceDiffRef: input.trajectoryReview.source.ref,
        traceDiffContentHash: input.trajectoryReview.source.traceDiffContentHash
      },
      baselineSuite: suiteSource(input.baselineSuite, input.baselineSuiteRef, input.baselineSuiteHash),
      candidateSuite: suiteSource(input.candidateSuite, input.candidateSuiteRef, input.candidateSuiteHash)
    },
    comparability: {
      status:
        aggregateComparabilityReasons.length === 0
          ? ("COMPARABLE" as const)
          : ("INCOMPARABLE" as const),
      reasons: aggregateComparabilityReasons
    },
    summary: {
      caseCount: caseReports.length,
      comparableCases: caseReports.filter((entry) => entry.comparability.status === "COMPARABLE").length,
      unavailableMetricCount,
      candidateDominates: countPareto(caseReports, "CANDIDATE_DOMINATES"),
      baselineDominates: countPareto(caseReports, "BASELINE_DOMINATES"),
      tradeoff: countPareto(caseReports, "TRADEOFF"),
      incomparable: countPareto(caseReports, "INCOMPARABLE")
    },
    metricAvailability: {
      planToAction: {
        status: "UNAVAILABLE" as const,
        reason: "EVENT_MODEL_LACKS_PLAN_ACTION_EVIDENCE"
      },
      replanning: {
        status: "UNAVAILABLE" as const,
        reason: "EVENT_MODEL_LACKS_REPLANNING_EVIDENCE"
      },
      confidenceIntervals: {
        status: "UNAVAILABLE" as const,
        reason: "INSUFFICIENT_MATCHED_SAMPLE_SHAPE"
      }
    },
    cases: caseReports,
    methodology: {
      classification:
        "Candidate dominates only when 0-100 capped quality is no worse and high-confidence token total plus wall-clock are no worse, with at least one strict improvement.",
      qualityMetric: "cappedScore" as const,
      qualityScale: "0_to_100" as const,
      costMetric: "tokens.total" as const,
      latencyMetric: "efficiency.wallClockSeconds" as const,
      missingnessRule:
        "Any missing quality, token, latency, high-confidence token provenance, or trace comparability evidence makes the affected case incomparable; missing or lower-confidence candidate evidence never improves candidate classification."
    }
  };
  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

export function assertWorkflowEconomicsReportIntegrity(
  report: WorkflowEconomicsReport
): void {
  const { integrity, ...content } = report;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Workflow economics report integrity verification failed.");
  }
}

export function renderWorkflowEconomicsMarkdown(
  report: WorkflowEconomicsReport
): string {
  const rows = report.cases.map((caseReport) =>
    [
      caseReport.caseId,
      caseReport.pareto,
      caseReport.deltas.qualityScoreDelta,
      caseReport.deltas.tokenTotalDelta ?? "unavailable",
      caseReport.deltas.wallClockSecondsDelta ?? "unavailable",
      caseReport.validationLatency.status === "AVAILABLE"
        ? caseReport.validationLatency.detectionLatencySteps
        : "unavailable",
      caseReport.recovery.status === "AVAILABLE"
        ? caseReport.recovery.outcome
        : "unavailable"
    ].join(" | ")
  );
  return [
    "# Workflow Economics",
    "",
    `Status: ${report.status}`,
    `Gate authority: ${report.gateAuthority}`,
    `Trace diff: ${report.sources.traceDiff.ref}`,
    `Trajectory review: ${report.sources.trajectoryReview.ref}`,
    `Baseline suite: ${report.sources.baselineSuite.ref}`,
    `Candidate suite: ${report.sources.candidateSuite.ref}`,
    "",
    "## Summary",
    `Cases: ${report.summary.caseCount}`,
    `Comparable cases: ${report.summary.comparableCases}`,
    `Candidate dominates: ${report.summary.candidateDominates}`,
    `Baseline dominates: ${report.summary.baselineDominates}`,
    `Tradeoffs: ${report.summary.tradeoff}`,
    `Incomparable: ${report.summary.incomparable}`,
    "",
    "## Case Pareto",
    "case | pareto | quality delta | token delta | wall-clock delta | detection latency | recovery",
    "--- | --- | ---: | ---: | ---: | ---: | ---",
    ...(rows.length > 0 ? rows : ["none | none | 0 | unavailable | unavailable | unavailable | unavailable"]),
    "",
    "## Unavailable Metrics",
    `Plan-to-action: ${report.metricAvailability.planToAction.reason}`,
    `Replanning: ${report.metricAvailability.replanning.reason}`,
    `Confidence intervals: ${report.metricAvailability.confidenceIntervals.reason}`
  ].join("\n");
}

function validateSources(input: BuildWorkflowEconomicsInput): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      input.generatedAt
    ) ||
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new Error(
      "Workflow economics requires an explicit canonical generatedAt timestamp."
    );
  }
  assertTraceDiffIntegrity(input.traceDiff);
  assertTrajectoryReviewIntegrity(input.trajectoryReview);
  assertHash("trace diff", input.traceDiffHash, input.traceDiff);
  assertHash("trajectory review", input.trajectoryReviewHash, input.trajectoryReview);
  assertHash("baseline suite", input.baselineSuiteHash, input.baselineSuite);
  assertHash("candidate suite", input.candidateSuiteHash, input.candidateSuite);
  if (input.traceDiff.mode !== "baseline_candidate" || !input.traceDiff.sources.candidate) {
    throw new Error("Workflow economics requires a baseline_candidate trace diff.");
  }
  if (
    input.trajectoryReview.source.traceDiffContentHash !==
      input.traceDiff.integrity.contentHash ||
    stableJson([...input.trajectoryReview.source.sourceTraceHashes].sort()) !==
      stableJson([...input.traceDiff.integrity.sourceTraceHashes].sort())
  ) {
    throw new Error("Trajectory review source does not bind to the supplied trace diff.");
  }
  assertSuiteBinding(input.traceDiff, input.baselineSuite, "baseline");
  assertSuiteBinding(input.traceDiff, input.candidateSuite, "candidate");
  validateSuiteMetrics(input.baselineSuite, "baseline");
  validateSuiteMetrics(input.candidateSuite, "candidate");
}

function assertHash(label: string, hash: string, value: unknown): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} source hash is invalid.`);
  }
  if (hash !== sha256Text(stableJson(value))) {
    throw new Error(`${label} source hash does not match content.`);
  }
}

function assertSuiteBinding(
  traceDiff: TraceDiff,
  suite: SuiteResult,
  lane: "baseline" | "candidate"
): void {
  if (
    suite.resultType !== "suite" ||
    suite.targetId !== traceDiff.targetId ||
    suite.suite !== traceDiff.suite
  ) {
    throw new Error(`${lane} suite targetId and suite must match trace diff.`);
  }
}

function caseMap(
  suite: SuiteResult,
  lane: "baseline" | "candidate"
): Map<string, CaseResultWithOptionalMetrics> {
  const entries = new Map<string, CaseResultWithOptionalMetrics>();
  for (const result of suite.caseResults as CaseResultWithOptionalMetrics[]) {
    if (entries.has(result.caseId)) {
      throw new Error(`${lane} suite has duplicate case result ${result.caseId}.`);
    }
    entries.set(result.caseId, result);
  }
  return entries;
}

function assertSameCaseSet(left: string[], right: string[], message: string): void {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  if (stableJson(leftSorted) !== stableJson(rightSorted)) {
    throw new Error(`${message}: case set differs.`);
  }
}

function laneMetrics(
  result: CaseResultWithOptionalMetrics,
  lane: "baseline" | "candidate"
): WorkflowEconomicsLaneMetrics {
  return {
    verdict: result.verdict,
    qualityScore: result.cappedScore,
    tokens: tokenMetrics(result, lane),
    wallClock: wallClockMetric(result, lane)
  };
}

function tokenMetrics(
  result: CaseResultWithOptionalMetrics,
  lane: "baseline" | "candidate"
): WorkflowEconomicsLaneMetrics["tokens"] {
  const tokens = result.tokens;
  if (
    !tokens ||
    typeof tokens.input !== "number" ||
    typeof tokens.output !== "number" ||
    typeof tokens.total !== "number" ||
    typeof tokens.wasted !== "number" ||
    !["high", "medium", "low"].includes(
      String(tokens.costEstimateConfidence)
    )
  ) {
    return {
      status: "UNAVAILABLE",
      reason: `Token ledger is absent from ${lane} suite case result.`
    };
  }
  return {
    status: "AVAILABLE",
    input: tokens.input,
    output: tokens.output,
    total: tokens.total,
    wasted: tokens.wasted,
    confidence: tokens.costEstimateConfidence as "high" | "medium" | "low"
  };
}

function wallClockMetric(
  result: CaseResultWithOptionalMetrics,
  lane: "baseline" | "candidate"
): WorkflowEconomicsLaneMetrics["wallClock"] {
  if (
    !result.efficiency ||
    typeof result.efficiency.wallClockSeconds !== "number"
  ) {
    return {
      status: "UNAVAILABLE",
      reason: `Wall-clock evidence is absent from ${lane} suite case result.`
    };
  }
  return {
    status: "AVAILABLE",
    seconds: result.efficiency.wallClockSeconds
  };
}

function missingMetrics(
  laneMetricsValue: WorkflowEconomicsLaneMetrics,
  lane: "baseline" | "candidate"
): MissingMetric[] {
  const missing: MissingMetric[] = [];
  if (laneMetricsValue.tokens.status === "UNAVAILABLE") {
    missing.push({
      lane,
      metric: "tokens",
      reason: laneMetricsValue.tokens.reason
    });
  } else if (laneMetricsValue.tokens.confidence !== "high") {
    missing.push({
      lane,
      metric: "tokenConfidence",
      reason:
        `Token evidence is ${laneMetricsValue.tokens.confidence}-confidence; ` +
        "Pareto dominance requires high-confidence token evidence."
    });
  }
  if (laneMetricsValue.wallClock.status === "UNAVAILABLE") {
    missing.push({
      lane,
      metric: "wallClock",
      reason: laneMetricsValue.wallClock.reason
    });
  }
  return missing;
}

function comparabilityReasons(
  sourceReasons: string[],
  missingness: MissingMetric[]
): string[] {
  return [
    ...sourceReasons,
    ...missingness.map((entry) => `${entry.lane}.${entry.metric}: ${entry.reason}`)
  ];
}

function metricDeltas(
  baseline: WorkflowEconomicsLaneMetrics,
  candidate: WorkflowEconomicsLaneMetrics
): WorkflowEconomicsCase["deltas"] {
  return {
    qualityScoreDelta: round(candidate.qualityScore - baseline.qualityScore),
    ...(baseline.tokens.status === "AVAILABLE" && candidate.tokens.status === "AVAILABLE"
      ? {
          tokenTotalDelta: candidate.tokens.total - baseline.tokens.total,
          wastedTokenDelta: candidate.tokens.wasted - baseline.tokens.wasted
        }
      : {}),
    ...(baseline.wallClock.status === "AVAILABLE" && candidate.wallClock.status === "AVAILABLE"
      ? {
          wallClockSecondsDelta: round(candidate.wallClock.seconds - baseline.wallClock.seconds)
        }
      : {})
  };
}

function classifyPareto(
  comparability: ComparabilityStatus,
  baseline: WorkflowEconomicsLaneMetrics,
  candidate: WorkflowEconomicsLaneMetrics
): ParetoClassification {
  if (
    comparability === "INCOMPARABLE" ||
    baseline.tokens.status === "UNAVAILABLE" ||
    candidate.tokens.status === "UNAVAILABLE" ||
    baseline.wallClock.status === "UNAVAILABLE" ||
    candidate.wallClock.status === "UNAVAILABLE"
  ) {
    return "INCOMPARABLE";
  }
  const qualityDelta = candidate.qualityScore - baseline.qualityScore;
  const tokenDelta = candidate.tokens.total - baseline.tokens.total;
  const wallDelta = candidate.wallClock.seconds - baseline.wallClock.seconds;
  const candidateNoWorse = qualityDelta >= 0 && tokenDelta <= 0 && wallDelta <= 0;
  const candidateStrict = qualityDelta > 0 || tokenDelta < 0 || wallDelta < 0;
  if (candidateNoWorse && candidateStrict) {
    return "CANDIDATE_DOMINATES";
  }
  const baselineNoWorse = qualityDelta <= 0 && tokenDelta >= 0 && wallDelta >= 0;
  const baselineStrict = qualityDelta < 0 || tokenDelta > 0 || wallDelta > 0;
  if (baselineNoWorse && baselineStrict) {
    return "BASELINE_DOMINATES";
  }
  return "TRADEOFF";
}

function retryEvidence(eventDeltas: TraceEventDelta[]): WorkflowEconomicsCase["retryEvidence"] {
  const byAction = new Map<string, string[]>();
  for (const delta of eventDeltas) {
    if (
      delta.candidateRef &&
      delta.candidatePayloadHash &&
      (delta.type === "tool_call" ||
        delta.type === "process_spawn" ||
        delta.type === "runner_transcript")
    ) {
      const key = `${delta.type}:${delta.candidatePayloadHash}`;
      byAction.set(key, [
        ...(byAction.get(key) ?? []),
        delta.candidateRef
      ]);
    }
  }
  const repeatedActionRefs = [...byAction.values()]
    .filter((refs) => refs.length > 1)
    .flat()
    .sort();
  if (repeatedActionRefs.length === 0) {
    return {
      status: "UNAVAILABLE",
      repeatedActionRefs: [],
      reason: "No repeated tool/process/transcript action evidence was present in candidate trace deltas."
    };
  }
  return {
    status: "AVAILABLE",
    repeatedActionRefs
  };
}

function validationLatency(
  finding: TrajectoryFinding | undefined
): WorkflowEconomicsCase["validationLatency"] {
  if (!finding) {
    return {
      status: "UNAVAILABLE",
      reason: "No trajectory-review deterministic finding is bound to this case."
    };
  }
  return {
    status: "AVAILABLE",
    detectionLatencySteps: finding.detection.latencySteps,
    detectionRef: finding.detection.ref,
    onsetRef: finding.onset.ref
  };
}

function recovery(finding: TrajectoryFinding | undefined): WorkflowEconomicsCase["recovery"] {
  if (!finding) {
    return {
      status: "UNAVAILABLE",
      reason: "No trajectory-review recovery finding is bound to this case."
    };
  }
  return {
    status: "AVAILABLE",
    attempts: finding.recovery.attempts,
    outcome: finding.recovery.outcome
  };
}

function irreversibleSideEffectTiming(
  eventDeltas: TraceEventDelta[]
): WorkflowEconomicsCase["irreversibleSideEffectTiming"] {
  const refs = eventDeltas
    .filter(
      (delta) =>
        delta.type === "side_effect_attempt" &&
        delta.candidateRef &&
        delta.candidateIrreversibleSideEffect === true
    )
    .map((delta) => ({
      ref: delta.candidateRef!,
      position: delta.candidatePosition ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => left.position - right.position);
  if (refs.length === 0) {
    return {
      status: "UNAVAILABLE",
      refs: [],
      reason:
        "No explicitly allowed irreversible side-effect attempt evidence was present for this case."
    };
  }
  return {
    status: "AVAILABLE",
    refs: refs.map((entry) => entry.ref),
    firstPosition: refs[0].position
  };
}

function findingsByCase(review: TrajectoryReviewReport): Map<string, TrajectoryFinding> {
  const findings = new Map<string, TrajectoryFinding>();
  for (const finding of review.deterministicFindings) {
    const current = findings.get(finding.caseId);
    if (!current || finding.detection.latencySteps < current.detection.latencySteps) {
      findings.set(finding.caseId, finding);
    }
  }
  return findings;
}

function suiteSource(
  suite: SuiteResult,
  ref: string,
  sha256: string
): WorkflowEconomicsSuiteSourceRef {
  return {
    ref,
    sha256,
    runId: suite.runId,
    targetId: suite.targetId,
    suite: suite.suite,
    caseCount: suite.caseResults.length,
    gatePolicy: {
      policyVersion: suite.gatePolicy.policyVersion,
      policyHash: suite.gatePolicy.policyHash,
      rulesHash: suite.gatePolicy.rulesHash
    }
  };
}

function countPareto(
  cases: WorkflowEconomicsCase[],
  classification: ParetoClassification
): number {
  return cases.filter((caseReport) => caseReport.pareto === classification).length;
}

function round(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function gatePolicyComparabilityReasons(
  baseline: SuiteResult,
  candidate: SuiteResult
): string[] {
  const left = baseline.gatePolicy;
  const right = candidate.gatePolicy;
  return left.policyVersion === right.policyVersion &&
    left.policyHash === right.policyHash &&
    left.rulesHash === right.rulesHash
    ? []
    : ["baseline and candidate gate-policy bindings differ"];
}

function validateSuiteMetrics(
  suite: SuiteResult,
  lane: "baseline" | "candidate"
): void {
  for (const result of suite.caseResults as CaseResultWithOptionalMetrics[]) {
    if (
      !Number.isFinite(result.cappedScore) ||
      result.cappedScore < 0 ||
      result.cappedScore > 100
    ) {
      throw new Error(
        `${lane} suite case ${result.caseId} has an invalid capped quality score.`
      );
    }
    if (result.tokens) {
      const { input, output, total, wasted, costEstimateConfidence } =
        result.tokens;
      if (
        ![input, output, total, wasted].every(
          (value) =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0
        ) ||
        total !== (input as number) + (output as number) ||
        (wasted as number) > (total as number) ||
        !["high", "medium", "low", "unavailable"].includes(
          String(costEstimateConfidence)
        )
      ) {
        throw new Error(
          `${lane} suite case ${result.caseId} has an invalid token ledger.`
        );
      }
    }
    const wallClock = result.efficiency?.wallClockSeconds;
    if (
      wallClock !== undefined &&
      (typeof wallClock !== "number" ||
        !Number.isFinite(wallClock) ||
        wallClock < 0)
    ) {
      throw new Error(
        `${lane} suite case ${result.caseId} has invalid wall-clock evidence.`
      );
    }
  }
}
