import { sha256Text, stableJson } from "../utils/hash.js";

export type ReliabilityStudyKind =
  | "deterministic_repeat"
  | "live_aa"
  | "live_paired";

export type ReliabilityConclusion =
  | "RELIABLE"
  | "DIAGNOSTIC_REPRODUCIBLE"
  | "QUARANTINED"
  | "INSUFFICIENT_SAMPLE"
  | "INVALID";

export type ReliabilityGateEligibility =
  | "ELIGIBLE"
  | "DIAGNOSTIC_ONLY"
  | "BLOCK";

export interface ReliabilityPolicy {
  deterministicMinimumSamples: number;
  liveMinimumSamples: number;
  gateConsistencyMinimum: number;
  caseConsistencyMinimum: number;
  maximumMissingRate: number;
  minimumTelemetryCompleteness: number;
  confidenceLevel: number;
  bootstrapIterations: number;
  defaultSeed: string;
}

export interface ReliabilityStudy {
  studyId: string;
  kind: ReliabilityStudyKind;
  seed: string;
}

export interface ReliabilitySample {
  status: "observed" | "missing";
  sampleId: string;
  missingReason?: ReliabilityMissingReason;
  evidenceHash?: string;
  attemptFingerprint?: string;
  baselineRunId?: string;
  candidateRunId?: string;
  context: ReliabilitySampleContext;
  outcome?: ReliabilitySampleOutcome;
}

export type ReliabilityMissingReason =
  | "RUN_MISSING"
  | "RUN_INVALID"
  | "INCOMPARABLE"
  | "SEED_MISMATCH"
  | "CONTEXT_MISMATCH";

export interface ReliabilitySampleContext {
  targetId: string;
  suite: string;
  contractHash: string;
  caseSetHash: string;
  conditionsHash: string;
  runnerFingerprint: string;
  environmentFingerprint: string;
  observerVersion: string;
  model: string;
  permissionMode: string;
  budgetHash: string;
  seed: string;
  executionMode: "simulated" | "live" | "unknown";
  evidenceKind: "simulated" | "live" | "unknown";
  observationLevel:
    | "synthetic_events"
    | "workflow_trace"
    | "contract_summary"
    | "capability_only"
    | "unknown";
  observerQualificationStatus: "not_applicable" | "missing" | "valid" | "invalid";
}

export interface ReliabilitySampleOutcome {
  classification?: string;
  gateDecision?: "PASS" | "BLOCK" | "DIAGNOSTIC_ONLY" | string;
  baselineScore?: number;
  candidateScore?: number;
  scoreDelta?: number;
  telemetryCompleteness?: number;
  dimensions?: ReliabilityDimensionSample[];
  cases?: ReliabilityCaseSample[];
}

export interface ReliabilityDimensionSample {
  dimension: string;
  baseline: number;
  candidate: number;
}

export interface ReliabilityCaseSample {
  caseId: string;
  candidateVerdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "DIAGNOSTIC_ONLY" | string;
  candidateHardFailures: Array<{ code: string; severity: "P0" | "P1" | string }>;
}

export interface ReliabilityInterval {
  kind: "wilson" | "bootstrap";
  confidenceLevel: number;
  lower: number;
  upper: number;
}

export interface ReliabilityRatioMetric {
  pointEstimate: number;
  interval: ReliabilityInterval;
}

export interface ReliabilityNumericMetric {
  mean: number;
  variance: number;
  interval: ReliabilityInterval;
}

export interface ReliabilityReport {
  schemaVersion: "0.1.0";
  resultType: "reliability_report";
  study: ReliabilityStudy;
  policy: ReliabilityPolicy;
  conclusion: ReliabilityConclusion;
  strongConclusionAllowed: boolean;
  gateEligibility: ReliabilityGateEligibility;
  metrics: {
    sampleSize: {
      requested: number;
      observed: number;
      missing: number;
      minimum: number;
    };
    missingRate: number;
    telemetryCompleteness: ReliabilityNumericMetric;
    deterministicAgreement: number;
    gateConsistency: ReliabilityRatioMetric;
    caseConsistency: ReliabilityRatioMetric;
    pairedDelta: ReliabilityNumericMetric;
    p0FalsePassCount: number;
    p0ObservedCount: number;
    p0DetectionRate: number | null;
    duplicateEvidenceCount: number;
    aa: {
      applicable: boolean;
      unchangedRate: number;
      passed: boolean;
    };
    dimensionVariance: Array<{
      dimension: string;
      meanDelta: number;
      variance: number;
    }>;
    fixedContextDrift: Array<{
      contextHash: string;
      sampleCount: number;
      gateConsistency: number;
      status: "PASS" | "DRIFT";
    }>;
  };
  quarantinedCases: Array<{
    caseId: string;
    consistency: number;
    status: "QUARANTINED";
  }>;
  debugHealth: {
    status: "PASS" | "FAIL";
    environmentReproducibility: number;
    doesNotAffectTargetScore: true;
  };
  samples: ReliabilitySample[];
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export function analyzeReliabilitySamples(
  study: ReliabilityStudy,
  samples: ReliabilitySample[],
  policy: ReliabilityPolicy
): ReliabilityReport {
  const observed = samples.filter((sample) => sample.status === "observed" && sample.outcome);
  const requested = samples.length;
  const missing = requested - observed.length;
  const minimum = isLiveStudy(study.kind)
    ? policy.liveMinimumSamples
    : policy.deterministicMinimumSamples;
  const missingRate = requested === 0 ? 1 : missing / requested;
  const gateConsistency = modalConsistency(
    observed.map((sample) => sample.outcome!.gateDecision ?? "missing")
  );
  const caseStats = caseConsistencyStats(observed, policy);
  const p0FalsePassCount = observed.reduce(
    (count, sample) => count + p0FalsePasses(sample),
    0
  );
  const p0Stats = p0DetectionStats(observed);
  const duplicateEvidenceCount = duplicateEvidenceSamples(observed);
  const aa = aaStats(study.kind, observed);
  const telemetryValues = observed.map(
    (sample) => sample.outcome!.telemetryCompleteness ?? 0
  );
  const pairedDeltas = observed.map((sample) => sample.outcome!.scoreDelta ?? 0);
  const fixedContextDrift = fixedContextDriftStats(observed, policy);
  const environmentReproducibility = modalConsistency(
    observed.map((sample) => sample.context.environmentFingerprint)
  );
  const deterministicAgreement = isLiveStudy(study.kind)
    ? gateConsistency
    : modalConsistency(observed.map(deterministicOutcomeSignature));
  const evidenceEligible = observed.every((sample) =>
    evidenceEligibleForStudy(study.kind, study.seed, sample)
  );
  const sampleSufficient = observed.length >= minimum;
  const telemetryMean = mean(telemetryValues);
  const hasContextDrift = fixedContextDrift.some((entry) => entry.status === "DRIFT");
  const hasQuarantine = caseStats.quarantinedCases.length > 0;
  const hasUnsafeP0 = p0Stats.observed > 0 && p0Stats.detected !== p0Stats.observed;
  const aaSatisfied = !aa.applicable || aa.passed;
  const policySatisfied =
    sampleSufficient &&
    missingRate <= policy.maximumMissingRate &&
    telemetryMean >= policy.minimumTelemetryCompleteness &&
    gateConsistency >= policy.gateConsistencyMinimum &&
    caseStats.minimumConsistency >= policy.caseConsistencyMinimum &&
    (!isLiveStudy(study.kind) ? deterministicAgreement === 1 : true) &&
    duplicateEvidenceCount === 0 &&
    aaSatisfied &&
    !hasUnsafeP0 &&
    !hasContextDrift &&
    evidenceEligible;

  const conclusion: ReliabilityConclusion =
    p0FalsePassCount > 0 || hasUnsafeP0
      ? "INVALID"
      : !sampleSufficient ||
          missingRate > policy.maximumMissingRate ||
          telemetryMean < policy.minimumTelemetryCompleteness ||
          !evidenceEligible
        ? "INSUFFICIENT_SAMPLE"
        : hasQuarantine ||
            hasContextDrift ||
            duplicateEvidenceCount > 0 ||
            !aaSatisfied ||
            gateConsistency < policy.gateConsistencyMinimum
          ? "QUARANTINED"
          : policySatisfied
            ? isLiveStudy(study.kind)
              ? "RELIABLE"
              : "DIAGNOSTIC_REPRODUCIBLE"
            : "INVALID";
  const strongConclusionAllowed = conclusion === "RELIABLE";
  const gateEligibility: ReliabilityGateEligibility =
    p0FalsePassCount > 0 || hasUnsafeP0
      ? "BLOCK"
      : strongConclusionAllowed && isLiveStudy(study.kind)
        ? "ELIGIBLE"
        : "DIAGNOSTIC_ONLY";

  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    resultType: "reliability_report" as const,
    study,
    policy,
    conclusion,
    strongConclusionAllowed,
    gateEligibility,
    metrics: {
      sampleSize: {
        requested,
        observed: observed.length,
        missing,
        minimum
      },
      missingRate: roundMetric(missingRate),
      telemetryCompleteness: numericMetric(
        telemetryValues,
        policy,
        study.seed,
        "telemetry"
      ),
      deterministicAgreement: roundMetric(deterministicAgreement),
      gateConsistency: ratioMetric(
        Math.round(gateConsistency * observed.length),
        observed.length,
        policy
      ),
      caseConsistency: ratioMetric(
        Math.round(caseStats.minimumConsistency * observed.length),
        observed.length,
        policy
      ),
      pairedDelta: numericMetric(pairedDeltas, policy, study.seed, "paired-delta"),
      p0FalsePassCount,
      p0ObservedCount: p0Stats.observed,
      p0DetectionRate:
        p0Stats.observed === 0
          ? null
          : roundMetric(p0Stats.detected / p0Stats.observed),
      duplicateEvidenceCount,
      aa,
      dimensionVariance: dimensionVariance(observed),
      fixedContextDrift
    },
    quarantinedCases: caseStats.quarantinedCases,
    debugHealth: {
    status: (
        environmentReproducibility === 1 && telemetryMean >= policy.minimumTelemetryCompleteness
          ? "PASS"
          : "FAIL"
      ) as "PASS" | "FAIL",
      environmentReproducibility: roundMetric(environmentReproducibility),
      doesNotAffectTargetScore: true as const
    },
    samples
  };

  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

export function renderReliabilityMarkdown(report: ReliabilityReport): string {
  return [
    `# Reliability Report`,
    ``,
    `Study: ${report.study.studyId}`,
    `Conclusion: ${report.conclusion}`,
    `Strong conclusion allowed: ${report.strongConclusionAllowed}`,
    `Gate eligibility: ${report.gateEligibility}`,
    ``,
    `## Metrics`,
    `Samples: ${report.metrics.sampleSize.observed}/${report.metrics.sampleSize.requested}`,
    `Gate consistency: ${report.metrics.gateConsistency.pointEstimate}`,
    `Case consistency: ${report.metrics.caseConsistency.pointEstimate}`,
    `Deterministic agreement: ${report.metrics.deterministicAgreement}`,
    `P0 false PASS count: ${report.metrics.p0FalsePassCount}`,
    `P0 detection rate: ${report.metrics.p0DetectionRate ?? "n/a"}`,
    `Duplicate evidence count: ${report.metrics.duplicateEvidenceCount}`,
    `A/A unchanged rate: ${report.metrics.aa.applicable ? report.metrics.aa.unchangedRate : "n/a"}`,
    ``,
    `## Debug Health`,
    `Status: ${report.debugHealth.status}`,
    `Environment reproducibility: ${report.debugHealth.environmentReproducibility}`
  ].join("\n");
}

function isLiveStudy(kind: ReliabilityStudyKind): boolean {
  return kind === "live_aa" || kind === "live_paired";
}

function evidenceEligibleForStudy(
  kind: ReliabilityStudyKind,
  studySeed: string,
  sample: ReliabilitySample
): boolean {
  if (
    sample.context.seed !== studySeed ||
    !sample.attemptFingerprint ||
    !/^sha256:[a-f0-9]{64}$/u.test(sample.attemptFingerprint)
  ) {
    return false;
  }
  if (kind === "deterministic_repeat") {
    return (
      sample.context.executionMode === "simulated" &&
      sample.context.evidenceKind === "simulated" &&
      sample.context.observationLevel === "synthetic_events" &&
      sample.context.observerQualificationStatus === "not_applicable"
    );
  }
  return (
    sample.context.executionMode === "live" &&
    sample.context.evidenceKind === "live" &&
    sample.context.observationLevel === "workflow_trace" &&
    sample.context.observerQualificationStatus === "valid"
  );
}

function p0FalsePasses(sample: ReliabilitySample): number {
  if (sample.outcome?.gateDecision !== "PASS") {
    return 0;
  }
  return p0CaseCount(sample);
}

function p0CaseCount(sample: ReliabilitySample): number {
  return (sample.outcome?.cases ?? []).filter((testCase) =>
    testCase.candidateHardFailures.some((failure) => failure.severity === "P0")
  ).length;
}

function p0DetectionStats(samples: ReliabilitySample[]): {
  observed: number;
  detected: number;
} {
  return samples.reduce(
    (stats, sample) => {
      const observed = p0CaseCount(sample);
      return {
        observed: stats.observed + observed,
        detected:
          stats.detected +
          (sample.outcome?.gateDecision === "BLOCK" ? observed : 0)
      };
    },
    { observed: 0, detected: 0 }
  );
}

function duplicateEvidenceSamples(samples: ReliabilitySample[]): number {
  const evidenceHashes = new Set<string>();
  const attemptFingerprints = new Set<string>();
  const candidateRunIds = new Set<string>();
  let duplicates = 0;
  for (const sample of samples) {
    const selfComparison =
      sample.baselineRunId !== undefined &&
      sample.candidateRunId !== undefined &&
      sample.baselineRunId === sample.candidateRunId;
    const duplicateEvidence =
      sample.evidenceHash !== undefined && evidenceHashes.has(sample.evidenceHash);
    const duplicateAttempt =
      sample.attemptFingerprint !== undefined &&
      attemptFingerprints.has(sample.attemptFingerprint);
    const duplicateCandidate =
      sample.candidateRunId !== undefined &&
      candidateRunIds.has(sample.candidateRunId);
    if (
      selfComparison ||
      duplicateEvidence ||
      duplicateAttempt ||
      duplicateCandidate
    ) {
      duplicates += 1;
    }
    if (sample.evidenceHash !== undefined) {
      evidenceHashes.add(sample.evidenceHash);
    }
    if (sample.attemptFingerprint !== undefined) {
      attemptFingerprints.add(sample.attemptFingerprint);
    }
    if (sample.candidateRunId !== undefined) {
      candidateRunIds.add(sample.candidateRunId);
    }
  }
  return duplicates;
}

function aaStats(
  kind: ReliabilityStudyKind,
  samples: ReliabilitySample[]
): ReliabilityReport["metrics"]["aa"] {
  if (kind !== "live_aa") {
    return {
      applicable: false,
      unchangedRate: 0,
      passed: true
    };
  }
  const unchanged = samples.filter(
    (sample) => sample.outcome?.classification === "UNCHANGED"
  ).length;
  const unchangedRate = samples.length === 0 ? 0 : unchanged / samples.length;
  return {
    applicable: true,
    unchangedRate: roundMetric(unchangedRate),
    passed: samples.length > 0 && unchanged === samples.length
  };
}

function deterministicOutcomeSignature(sample: ReliabilitySample): string {
  return stableJson({
    context: {
      targetId: sample.context.targetId,
      suite: sample.context.suite,
      contractHash: sample.context.contractHash,
      caseSetHash: sample.context.caseSetHash,
      conditionsHash: sample.context.conditionsHash,
      runnerFingerprint: sample.context.runnerFingerprint,
      environmentFingerprint: sample.context.environmentFingerprint,
      observerVersion: sample.context.observerVersion,
      model: sample.context.model,
      permissionMode: sample.context.permissionMode,
      budgetHash: sample.context.budgetHash,
      seed: sample.context.seed
    },
    outcome: sample.outcome
  });
}

function caseConsistencyStats(
  samples: ReliabilitySample[],
  policy: ReliabilityPolicy
): {
  minimumConsistency: number;
  quarantinedCases: ReliabilityReport["quarantinedCases"];
} {
  const caseIds = new Set(
    samples.flatMap((sample) =>
      (sample.outcome?.cases ?? []).map((testCase) => testCase.caseId)
    )
  );
  const byCase = new Map<string, string[]>(
    [...caseIds].map((caseId) => [caseId, []])
  );
  for (const sample of samples) {
    const sampleCases = new Map(
      (sample.outcome?.cases ?? []).map((testCase) => [
        testCase.caseId,
        testCase
      ])
    );
    for (const caseId of caseIds) {
      byCase
        .get(caseId)!
        .push(
          sampleCases.has(caseId)
            ? caseOutcomeSignature(sampleCases.get(caseId)!)
            : "missing"
        );
    }
  }
  if (byCase.size === 0) {
    return { minimumConsistency: samples.length === 0 ? 0 : 1, quarantinedCases: [] };
  }
  const consistencies = [...byCase.entries()].map(([caseId, verdicts]) => ({
    caseId,
    consistency: modalConsistency(verdicts)
  }));
  return {
    minimumConsistency: Math.min(...consistencies.map((entry) => entry.consistency)),
    quarantinedCases: consistencies
      .filter((entry) => entry.consistency < policy.caseConsistencyMinimum)
      .map((entry) => ({
        caseId: entry.caseId,
        consistency: roundMetric(entry.consistency),
        status: "QUARANTINED" as const
      }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId))
  };
}

function caseOutcomeSignature(testCase: ReliabilityCaseSample): string {
  return stableJson({
    verdict: testCase.candidateVerdict,
    hardFailures: testCase.candidateHardFailures
      .map((failure) => `${failure.severity}:${failure.code}`)
      .sort()
  });
}

function fixedContextDriftStats(
  samples: ReliabilitySample[],
  policy: ReliabilityPolicy
): ReliabilityReport["metrics"]["fixedContextDrift"] {
  const byContext = new Map<string, ReliabilitySample[]>();
  for (const sample of samples) {
    const contextHash = sha256Text(
      stableJson({
        targetId: sample.context.targetId,
        suite: sample.context.suite,
        contractHash: sample.context.contractHash,
        caseSetHash: sample.context.caseSetHash,
        conditionsHash: sample.context.conditionsHash,
        runnerFingerprint: sample.context.runnerFingerprint,
        environmentFingerprint: sample.context.environmentFingerprint,
        observerVersion: sample.context.observerVersion,
        model: sample.context.model,
        permissionMode: sample.context.permissionMode,
        budgetHash: sample.context.budgetHash,
        seed: sample.context.seed
      })
    );
    const group = byContext.get(contextHash) ?? [];
    group.push(sample);
    byContext.set(contextHash, group);
  }
  return [...byContext.entries()]
    .map(([contextHash, group]) => {
      const consistency = modalConsistency(
        group.map((sample) => sample.outcome!.gateDecision ?? "missing")
      );
      return {
        contextHash,
        sampleCount: group.length,
        gateConsistency: roundMetric(consistency),
        status:
          byContext.size === 1 && consistency >= policy.gateConsistencyMinimum
            ? ("PASS" as const)
            : ("DRIFT" as const)
      };
    })
    .sort((left, right) => left.contextHash.localeCompare(right.contextHash));
}

function dimensionVariance(
  samples: ReliabilitySample[]
): ReliabilityReport["metrics"]["dimensionVariance"] {
  const byDimension = new Map<string, number[]>();
  for (const sample of samples) {
    for (const dimension of sample.outcome?.dimensions ?? []) {
      const values = byDimension.get(dimension.dimension) ?? [];
      values.push(dimension.candidate - dimension.baseline);
      byDimension.set(dimension.dimension, values);
    }
  }
  return [...byDimension.entries()]
    .map(([dimension, values]) => ({
      dimension,
      meanDelta: roundMetric(mean(values)),
      variance: roundMetric(variance(values))
    }))
    .sort((left, right) => left.dimension.localeCompare(right.dimension));
}

function ratioMetric(
  successes: number,
  total: number,
  policy: ReliabilityPolicy
): ReliabilityRatioMetric {
  const pointEstimate = total === 0 ? 0 : successes / total;
  return {
    pointEstimate: roundMetric(pointEstimate),
    interval: wilsonInterval(successes, total, policy.confidenceLevel)
  };
}

function numericMetric(
  values: number[],
  policy: ReliabilityPolicy,
  seed: string,
  label: string
): ReliabilityNumericMetric {
  return {
    mean: roundMetric(mean(values)),
    variance: roundMetric(variance(values)),
    interval: bootstrapMeanInterval(values, policy, `${seed}:${label}`)
  };
}

function modalConsistency(values: string[]): number {
  if (values.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / values.length;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const average = mean(values);
  return (
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
    (values.length - 1)
  );
}

function wilsonInterval(
  successes: number,
  total: number,
  confidenceLevel: number
): ReliabilityInterval {
  if (total === 0) {
    return {
      kind: "wilson",
      confidenceLevel,
      lower: 0,
      upper: 0
    };
  }
  const z = zScore(confidenceLevel);
  const p = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = p + (z ** 2) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * total)) / total);
  return {
    kind: "wilson",
    confidenceLevel,
    lower: roundMetric(Math.max(0, (center - margin) / denominator)),
    upper: roundMetric(Math.min(1, (center + margin) / denominator))
  };
}

function bootstrapMeanInterval(
  values: number[],
  policy: ReliabilityPolicy,
  seed: string
): ReliabilityInterval {
  if (values.length === 0) {
    return {
      kind: "bootstrap",
      confidenceLevel: policy.confidenceLevel,
      lower: 0,
      upper: 0
    };
  }
  if (values.every((value) => value === values[0])) {
    return {
      kind: "bootstrap",
      confidenceLevel: policy.confidenceLevel,
      lower: roundMetric(values[0]),
      upper: roundMetric(values[0])
    };
  }
  const random = seededRandom(seed);
  const iterations = Math.max(1, policy.bootstrapIterations);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      resample.push(values[Math.floor(random() * values.length)]!);
    }
    means.push(mean(resample));
  }
  means.sort((left, right) => left - right);
  const alpha = (1 - policy.confidenceLevel) / 2;
  return {
    kind: "bootstrap",
    confidenceLevel: policy.confidenceLevel,
    lower: roundMetric(quantile(means, alpha)),
    upper: roundMetric(quantile(means, 1 - alpha))
  };
}

function quantile(sortedValues: number[], probability: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const position = Math.min(
    sortedValues.length - 1,
    Math.max(0, probability * (sortedValues.length - 1))
  );
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]!;
  }
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex]! * (1 - weight) + sortedValues[upperIndex]! * weight;
}

function seededRandom(seed: string): () => number {
  let state = fnv1a(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function zScore(confidenceLevel: number): number {
  if (confidenceLevel >= 0.999) {
    return 3.291;
  }
  if (confidenceLevel >= 0.99) {
    return 2.576;
  }
  if (confidenceLevel >= 0.95) {
    return 1.96;
  }
  if (confidenceLevel >= 0.9) {
    return 1.645;
  }
  return 1.96;
}

function roundMetric(value: number): number {
  return Object.is(value, -0) ? 0 : Number(value.toFixed(12));
}
