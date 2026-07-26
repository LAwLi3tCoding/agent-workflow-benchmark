import { PRODUCT_NAME } from "../core/product.js";
import type { RunnerCapability } from "../core/types.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export type RunnerRankingReasonCode =
  | "RANKING_TASK_INCOMPARABLE"
  | "RANKING_CASES_INCOMPARABLE"
  | "RANKING_OBSERVER_INCOMPARABLE"
  | "RANKING_OBSERVER_UNQUALIFIED"
  | "RANKING_BUDGET_INCOMPARABLE"
  | "RANKING_TELEMETRY_INCOMPARABLE"
  | "RANKING_TELEMETRY_INSUFFICIENT"
  | "RANKING_AXIS_NOT_COMPARABLE";

export interface RunnerRankingBindings {
  taskId: string;
  targetId: string;
  contractHash: string;
  caseSetHash: string;
  observer: {
    id: string;
    version: string;
    keyFingerprint: string;
    qualificationArtifactHash: string;
    qualificationStatus: "valid" | "invalid" | "missing";
  };
  budget: {
    wallClockSeconds: number;
    tokenTotal: number;
  };
  telemetry: {
    schemaVersion: string;
    evidenceKind: "live";
    observationLevel: "workflow_trace";
    tokenSource: "native";
    minimumCompleteness: number;
  };
}

export interface RunnerRankingEntry {
  runnerName: Exclude<RunnerCapability["name"], "simulated">;
  adapterVersion: string;
  capabilitiesHash: string;
  comparability: RunnerCapability["comparability"];
  bindings: RunnerRankingBindings;
  metrics: {
    workflowScore: number;
    wallClockSeconds: number;
    tokenTotal: number;
    telemetryCompleteness: number;
  };
}

export interface RunnerRankingInput {
  rankingId: string;
  generatedAt: string;
  entries: RunnerRankingEntry[];
}

export interface RunnerRankingReport {
  schemaVersion: "0.1.0";
  artifactType: "runner_ranking_report";
  product: typeof PRODUCT_NAME;
  rankingId: string;
  generatedAt: string;
  status: "RANKED" | "INCOMPARABLE";
  rankingAllowed: boolean;
  reasonCodes: RunnerRankingReasonCode[];
  comparabilityFingerprint: string;
  entries: RunnerRankingEntry[];
  ranking: Array<{
    rank: number;
    runnerName: RunnerRankingEntry["runnerName"];
    workflowScore: number;
    wallClockSeconds: number;
    tokenTotal: number;
  }>;
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export function buildRunnerRankingReport(
  input: RunnerRankingInput
): RunnerRankingReport {
  validateInput(input);
  const reasonCodes = compareEntries(input.entries);
  const rankingAllowed = reasonCodes.length === 0;
  const ranking = rankingAllowed ? rankEntries(input.entries) : [];
  const comparabilityFingerprint = sha256Text(
    stableJson(
      input.entries.map((entry) => ({
        bindings: entry.bindings,
        comparability: entry.comparability
      }))
    )
  );
  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    artifactType: "runner_ranking_report" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    rankingId: input.rankingId,
    generatedAt: input.generatedAt,
    status: rankingAllowed
      ? ("RANKED" as const)
      : ("INCOMPARABLE" as const),
    rankingAllowed,
    reasonCodes,
    comparabilityFingerprint,
    entries: input.entries,
    ranking
  };
  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

export function assertRunnerRankingReportIntegrity(
  report: RunnerRankingReport
): void {
  const { integrity, ...content } = report;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Runner ranking report integrity verification failed.");
  }
  const rebuilt = buildRunnerRankingReport({
    rankingId: report.rankingId,
    generatedAt: report.generatedAt,
    entries: report.entries
  });
  if (
    stableJson({
      status: report.status,
      rankingAllowed: report.rankingAllowed,
      reasonCodes: report.reasonCodes,
      comparabilityFingerprint: report.comparabilityFingerprint,
      ranking: report.ranking
    }) !==
    stableJson({
      status: rebuilt.status,
      rankingAllowed: rebuilt.rankingAllowed,
      reasonCodes: rebuilt.reasonCodes,
      comparabilityFingerprint: rebuilt.comparabilityFingerprint,
      ranking: rebuilt.ranking
    })
  ) {
    throw new Error(
      "Runner ranking decision is inconsistent with its comparable inputs."
    );
  }
}

function compareEntries(
  entries: RunnerRankingEntry[]
): RunnerRankingReasonCode[] {
  const reasons = new Set<RunnerRankingReasonCode>();
  const baseline = entries[0]!;
  for (const entry of entries) {
    if (
      Object.values(entry.comparability).some(
        (value) => value !== "comparable"
      )
    ) {
      reasons.add("RANKING_AXIS_NOT_COMPARABLE");
    }
    if (entry.bindings.observer.qualificationStatus !== "valid") {
      reasons.add("RANKING_OBSERVER_UNQUALIFIED");
    }
    if (
      stableJson({
        taskId: entry.bindings.taskId,
        targetId: entry.bindings.targetId,
        contractHash: entry.bindings.contractHash
      }) !==
      stableJson({
        taskId: baseline.bindings.taskId,
        targetId: baseline.bindings.targetId,
        contractHash: baseline.bindings.contractHash
      })
    ) {
      reasons.add("RANKING_TASK_INCOMPARABLE");
    }
    if (entry.bindings.caseSetHash !== baseline.bindings.caseSetHash) {
      reasons.add("RANKING_CASES_INCOMPARABLE");
    }
    if (
      stableJson(entry.bindings.observer) !==
      stableJson(baseline.bindings.observer)
    ) {
      reasons.add("RANKING_OBSERVER_INCOMPARABLE");
    }
    if (
      stableJson(entry.bindings.budget) !==
      stableJson(baseline.bindings.budget)
    ) {
      reasons.add("RANKING_BUDGET_INCOMPARABLE");
    }
    if (
      stableJson(entry.bindings.telemetry) !==
      stableJson(baseline.bindings.telemetry)
    ) {
      reasons.add("RANKING_TELEMETRY_INCOMPARABLE");
    }
    if (
      entry.metrics.telemetryCompleteness <
      entry.bindings.telemetry.minimumCompleteness
    ) {
      reasons.add("RANKING_TELEMETRY_INSUFFICIENT");
    }
  }
  return [...reasons];
}

function rankEntries(
  entries: RunnerRankingEntry[]
): RunnerRankingReport["ranking"] {
  const sorted = [...entries].sort(
    (left, right) =>
      right.metrics.workflowScore - left.metrics.workflowScore ||
      left.metrics.wallClockSeconds - right.metrics.wallClockSeconds ||
      left.metrics.tokenTotal - right.metrics.tokenTotal ||
      left.runnerName.localeCompare(right.runnerName)
  );
  let previousScore: number | undefined;
  let previousRank = 0;
  return sorted.map((entry, index) => {
    const rank =
      previousScore === entry.metrics.workflowScore
        ? previousRank
        : index + 1;
    previousScore = entry.metrics.workflowScore;
    previousRank = rank;
    return {
      rank,
      runnerName: entry.runnerName,
      workflowScore: entry.metrics.workflowScore,
      wallClockSeconds: entry.metrics.wallClockSeconds,
      tokenTotal: entry.metrics.tokenTotal
    };
  });
}

function validateInput(input: RunnerRankingInput): void {
  if (
    !input?.rankingId?.trim() ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !Array.isArray(input.entries) ||
    input.entries.length < 2 ||
    input.entries.length > 64
  ) {
    throw new Error(
      "Runner ranking requires an id, timestamp, and 2-64 entries."
    );
  }
  const names = new Set<string>();
  for (const entry of input.entries) {
    if (
      names.has(entry.runnerName) ||
      !["codex", "claude", "opencode"].includes(entry.runnerName) ||
      !isSemver(entry.adapterVersion) ||
      !isHash(entry.capabilitiesHash) ||
      !entry.bindings.taskId.trim() ||
      !entry.bindings.targetId.trim() ||
      !isHash(entry.bindings.contractHash) ||
      !isHash(entry.bindings.caseSetHash) ||
      !entry.bindings.observer.id.trim() ||
      !isSemver(entry.bindings.observer.version) ||
      !isHash(entry.bindings.observer.keyFingerprint) ||
      !isHash(entry.bindings.observer.qualificationArtifactHash) ||
      !Number.isFinite(entry.bindings.budget.wallClockSeconds) ||
      entry.bindings.budget.wallClockSeconds <= 0 ||
      !Number.isSafeInteger(entry.bindings.budget.tokenTotal) ||
      entry.bindings.budget.tokenTotal <= 0 ||
      !Number.isFinite(entry.bindings.telemetry.minimumCompleteness) ||
      entry.bindings.telemetry.minimumCompleteness < 0 ||
      entry.bindings.telemetry.minimumCompleteness > 1 ||
      !Number.isFinite(entry.metrics.workflowScore) ||
      entry.metrics.workflowScore < 0 ||
      entry.metrics.workflowScore > 100 ||
      !Number.isFinite(entry.metrics.wallClockSeconds) ||
      entry.metrics.wallClockSeconds < 0 ||
      !Number.isSafeInteger(entry.metrics.tokenTotal) ||
      entry.metrics.tokenTotal < 0 ||
      !Number.isFinite(entry.metrics.telemetryCompleteness) ||
      entry.metrics.telemetryCompleteness < 0 ||
      entry.metrics.telemetryCompleteness > 1
    ) {
      throw new Error(
        "Runner ranking entries require unique runners and complete comparable bindings."
      );
    }
    names.add(entry.runnerName);
  }
}

function isHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isSemver(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
    value
  );
}
