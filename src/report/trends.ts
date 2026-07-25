import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export type TrendDriftReason =
  | "SCHEMA_VERSION_DRIFT"
  | "GATE_POLICY_DRIFT"
  | "RUNNER_DRIFT"
  | "CONDITIONS_DRIFT"
  | "CONTRACT_DRIFT"
  | "TARGET_DRIFT"
  | "SUITE_DRIFT"
  | "OBSERVATION_LEVEL_DRIFT";

export interface TrendPoint {
  pointId: string;
  generatedAt: string;
  schemaVersion: string;
  policyVersion: string;
  policyHash: string;
  rulesHash: string;
  runnerName: string;
  runnerCapabilitiesHash: string;
  conditionsHash: string;
  contractHash: string;
  suite: string;
  targetId: string;
  observationLevel: string;
  gateDecision?: string;
  score: number;
}

export interface TrendSegment {
  segmentId: string;
  status: "COMPARABLE" | "INCOMPARABLE";
  reasonCodes: TrendDriftReason[];
  pointIds: string[];
  comparabilityKeyHash: string;
}

export interface TrendChartSeries {
  segmentId: string;
  points: Array<{
    pointId: string;
    generatedAt: string;
    score: number;
    gateDecision?: string;
  }>;
}

export interface TrendReport {
  schemaVersion: "0.1.0";
  artifactType: "trend_report";
  product: typeof PRODUCT_NAME;
  seriesId: string;
  inputHash: string;
  points: TrendPoint[];
  segments: TrendSegment[];
  chartSeries: TrendChartSeries[];
  manifest: {
    artifactType: "trend_report";
    seriesId: string;
    inputHash: string;
    pointCount: number;
    segmentCount: number;
  };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export interface TrendReportInput {
  seriesId: string;
  points: TrendPoint[];
}

interface ComparabilityKey {
  schemaVersion: string;
  policyVersion: string;
  policyHash: string;
  rulesHash: string;
  runnerName: string;
  runnerCapabilitiesHash: string;
  conditionsHash: string;
  contractHash: string;
  suite: string;
  targetId: string;
  observationLevel: string;
}

export function buildTrendReport(input: TrendReportInput): TrendReport {
  const points = [...input.points];
  validateTrendInput(input.seriesId, points);
  const segments = segmentTrendPoints(points);
  const chartSeries = segments
    .filter((segment) => segment.status === "COMPARABLE" && segment.pointIds.length > 1)
    .map((segment) => ({
      segmentId: segment.segmentId,
      points: segment.pointIds.map((pointId) => {
        const point = points.find((item) => item.pointId === pointId);
        if (!point) {
          throw new Error(`Trend segment references missing point ${pointId}.`);
        }
        return {
          pointId: point.pointId,
          generatedAt: point.generatedAt,
          score: point.score,
          ...(point.gateDecision ? { gateDecision: point.gateDecision } : {})
        };
      })
    }));
  const content = {
    seriesId: input.seriesId,
    points
  };
  const inputHash = sha256Text(stableJson(content));

  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    artifactType: "trend_report" as const,
    product: PRODUCT_NAME,
    seriesId: input.seriesId,
    inputHash,
    points,
    segments,
    chartSeries,
    manifest: {
      artifactType: "trend_report",
      seriesId: input.seriesId,
      inputHash,
      pointCount: points.length,
      segmentCount: segments.length
    }
  } satisfies Omit<TrendReport, "integrity">;
  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

function segmentTrendPoints(points: TrendPoint[]): TrendSegment[] {
  if (points.length === 0) {
    return [];
  }
  const segments: TrendSegment[] = [];
  let current: TrendPoint[] = [points[0]!];
  let currentKey = comparabilityKey(points[0]!);
  let boundaryReasons: TrendDriftReason[] = [];

  for (const point of points.slice(1)) {
    const nextKey = comparabilityKey(point);
    const drift = driftReasons(currentKey, nextKey);
    if (drift.length === 0) {
      current.push(point);
      continue;
    }

    segments.push(toSegment(current, boundaryReasons));
    current = [point];
    currentKey = nextKey;
    boundaryReasons = drift;
  }

  segments.push(toSegment(current, boundaryReasons));
  return segments;
}

function toSegment(points: TrendPoint[], reasonCodes: TrendDriftReason[]): TrendSegment {
  const keyHash = sha256Text(stableJson(comparabilityKey(points[0]!)));
  return {
    segmentId: `trend-segment-${keyHash.slice("sha256:".length, "sha256:".length + 12)}`,
    status:
      reasonCodes.length > 0 && points.length === 1
        ? "INCOMPARABLE"
        : "COMPARABLE",
    reasonCodes,
    pointIds: points.map((point) => point.pointId),
    comparabilityKeyHash: keyHash
  };
}

function comparabilityKey(point: TrendPoint): ComparabilityKey {
  return {
    schemaVersion: point.schemaVersion,
    policyVersion: point.policyVersion,
    policyHash: point.policyHash,
    rulesHash: point.rulesHash,
    runnerName: point.runnerName,
    runnerCapabilitiesHash: point.runnerCapabilitiesHash,
    conditionsHash: point.conditionsHash,
    contractHash: point.contractHash,
    suite: point.suite,
    targetId: point.targetId,
    observationLevel: point.observationLevel
  };
}

function driftReasons(left: ComparabilityKey, right: ComparabilityKey): TrendDriftReason[] {
  const reasons: TrendDriftReason[] = [];
  if (left.schemaVersion !== right.schemaVersion) {
    reasons.push("SCHEMA_VERSION_DRIFT");
  }
  if (
    left.policyVersion !== right.policyVersion ||
    left.policyHash !== right.policyHash ||
    left.rulesHash !== right.rulesHash
  ) {
    reasons.push("GATE_POLICY_DRIFT");
  }
  if (
    left.runnerName !== right.runnerName ||
    left.runnerCapabilitiesHash !== right.runnerCapabilitiesHash
  ) {
    reasons.push("RUNNER_DRIFT");
  }
  if (left.conditionsHash !== right.conditionsHash) {
    reasons.push("CONDITIONS_DRIFT");
  }
  if (left.contractHash !== right.contractHash) {
    reasons.push("CONTRACT_DRIFT");
  }
  if (left.targetId !== right.targetId) {
    reasons.push("TARGET_DRIFT");
  }
  if (left.suite !== right.suite) {
    reasons.push("SUITE_DRIFT");
  }
  if (left.observationLevel !== right.observationLevel) {
    reasons.push("OBSERVATION_LEVEL_DRIFT");
  }
  return reasons;
}

function validateTrendInput(seriesId: string, points: TrendPoint[]): void {
  if (!seriesId.trim()) {
    throw new Error("Trend seriesId is required.");
  }
  if (points.length === 0) {
    throw new Error("Trend reports require at least one point.");
  }
  if (points.length > 10_000) {
    throw new Error("Trend report exceeds the maximum point count of 10000.");
  }
  const pointIds = new Set<string>();
  let priorTimestamp = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!point.pointId.trim() || pointIds.has(point.pointId)) {
      throw new Error(`Trend pointId is missing or duplicated: ${point.pointId}`);
    }
    pointIds.add(point.pointId);
    const timestamp = Date.parse(point.generatedAt);
    if (!Number.isFinite(timestamp) || timestamp < priorTimestamp) {
      throw new Error(
        `Trend points must use valid nondecreasing generatedAt timestamps: ${point.pointId}`
      );
    }
    priorTimestamp = timestamp;
    if (!Number.isFinite(point.score)) {
      throw new Error(`Trend point score must be finite: ${point.pointId}`);
    }
    for (const [name, value] of Object.entries(comparabilityKey(point))) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `Trend point ${point.pointId} is missing comparability field ${name}.`
        );
      }
    }
    for (const hash of [
      point.policyHash,
      point.rulesHash,
      point.runnerCapabilitiesHash,
      point.conditionsHash,
      point.contractHash
    ]) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
        throw new Error(`Trend point ${point.pointId} has an invalid comparability hash.`);
      }
    }
  }
}
