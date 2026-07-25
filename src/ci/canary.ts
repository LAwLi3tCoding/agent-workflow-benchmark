import {
  PRODUCTION_CANARY_POLICY,
  PRODUCTION_CANARY_POLICY_HASH
} from "./productionGate.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export interface ProductionCanarySample {
  sampleId: string;
  expectedDecision: "PASS" | "BLOCK";
  observedDecision: "PASS" | "DIAGNOSTIC_ONLY" | "BLOCK";
  repeatedDecisions: ReadonlyArray<
    "PASS" | "DIAGNOSTIC_ONLY" | "BLOCK"
  >;
  runtimeSeconds: number;
  costUsd: number;
}

export interface ProductionCanaryReport {
  schemaVersion: "0.1.0";
  artifactType: "production_canary_report";
  mode: "observe_only";
  status: "PASS" | "FAIL" | "INSUFFICIENT";
  policyVersion: typeof PRODUCTION_CANARY_POLICY.policyVersion;
  policyHash: string;
  generatedAt: string;
  sampleSetHash: string;
  sampleCount: number;
  expectedPassCount: number;
  expectedBlockCount: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
  falseNegativeCount: number;
  falseNegativeRate: number;
  flakyCaseCount: number;
  flakyRate: number;
  runtimeSecondsP95: number;
  costUsdP95: number;
  isolationManifestHash: string;
  gatePolicyHash: string;
  retentionDecision: "retain_redacted";
}

export function buildProductionCanaryReport(input: {
  samples: ProductionCanarySample[];
  isolationManifestHash: string;
  gatePolicyHash: string;
  generatedAt?: string;
}): ProductionCanaryReport {
  assertHash(input.isolationManifestHash, "isolation manifest");
  assertHash(input.gatePolicyHash, "gate policy");
  assertSamples(input.samples);
  const sampleCount = input.samples.length;
  const expectedPassCount = input.samples.filter(
    (sample) => sample.expectedDecision === "PASS"
  ).length;
  const expectedBlockCount = input.samples.filter(
    (sample) => sample.expectedDecision === "BLOCK"
  ).length;
  const falsePositiveCount = input.samples.filter(
    (sample) =>
      sample.expectedDecision === "PASS" &&
      sample.observedDecision !== "PASS"
  ).length;
  const falseNegativeCount = input.samples.filter(
    (sample) =>
      sample.expectedDecision === "BLOCK" &&
      sample.observedDecision === "PASS"
  ).length;
  const flakyCaseCount = input.samples.filter(
    (sample) => new Set(sample.repeatedDecisions).size > 1
  ).length;
  const falsePositiveRate = rate(falsePositiveCount, expectedPassCount);
  const falseNegativeRate = rate(falseNegativeCount, expectedBlockCount);
  const flakyRate = rate(flakyCaseCount, sampleCount);
  const runtimeSecondsP95 = percentile95(
    input.samples.map((sample) => sample.runtimeSeconds)
  );
  const costUsdP95 = percentile95(
    input.samples.map((sample) => sample.costUsd)
  );
  const enoughSamples =
    sampleCount >= PRODUCTION_CANARY_POLICY.minSampleCount &&
    expectedPassCount > 0 &&
    expectedBlockCount > 0;
  const thresholdsPass =
    falsePositiveRate <=
      PRODUCTION_CANARY_POLICY.maxFalsePositiveRate &&
    falseNegativeRate <=
      PRODUCTION_CANARY_POLICY.maxFalseNegativeRate &&
    flakyRate <= PRODUCTION_CANARY_POLICY.maxFlakyRate &&
    runtimeSecondsP95 <=
      PRODUCTION_CANARY_POLICY.maxRuntimeSecondsP95 &&
    costUsdP95 <= PRODUCTION_CANARY_POLICY.maxCostUsdP95;

  return {
    schemaVersion: "0.1.0",
    artifactType: "production_canary_report",
    mode: "observe_only",
    status: !enoughSamples
      ? "INSUFFICIENT"
      : thresholdsPass
        ? "PASS"
        : "FAIL",
    policyVersion: PRODUCTION_CANARY_POLICY.policyVersion,
    policyHash: PRODUCTION_CANARY_POLICY_HASH,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sampleSetHash: sha256Text(stableJson(input.samples)),
    sampleCount,
    expectedPassCount,
    expectedBlockCount,
    falsePositiveCount,
    falsePositiveRate,
    falseNegativeCount,
    falseNegativeRate,
    flakyCaseCount,
    flakyRate,
    runtimeSecondsP95,
    costUsdP95,
    isolationManifestHash: input.isolationManifestHash,
    gatePolicyHash: input.gatePolicyHash,
    retentionDecision: "retain_redacted"
  };
}

function assertSamples(samples: ProductionCanarySample[]): void {
  if (!Array.isArray(samples)) {
    throw new Error("Production canary samples must be an array.");
  }
  const sampleIds = new Set<string>();
  for (const sample of samples) {
    if (
      !sample ||
      typeof sample.sampleId !== "string" ||
      sample.sampleId.length === 0 ||
      sampleIds.has(sample.sampleId) ||
      !["PASS", "BLOCK"].includes(sample.expectedDecision) ||
      !["PASS", "DIAGNOSTIC_ONLY", "BLOCK"].includes(
        sample.observedDecision
      ) ||
      !Array.isArray(sample.repeatedDecisions) ||
      sample.repeatedDecisions.length < 2 ||
      sample.repeatedDecisions.some(
        (decision) =>
          !["PASS", "DIAGNOSTIC_ONLY", "BLOCK"].includes(decision)
      ) ||
      !sample.repeatedDecisions.includes(sample.observedDecision) ||
      !Number.isFinite(sample.runtimeSeconds) ||
      sample.runtimeSeconds < 0 ||
      !Number.isFinite(sample.costUsd) ||
      sample.costUsd < 0
    ) {
      throw new Error(
        "Production canary samples must be unique, complete, and non-negative."
      );
    }
    sampleIds.add(sample.sampleId);
  }
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!);
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : rounded(count / total);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function assertHash(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Production canary ${label} hash is invalid.`);
  }
}
