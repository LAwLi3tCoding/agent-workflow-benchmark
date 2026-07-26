import { describe, expect, test } from "vitest";
import {
  assertRunnerRankingReportIntegrity,
  buildRunnerRankingReport,
  type RunnerRankingInput
} from "../src/report/runnerRanking.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

describe("Stage 10 cross-runner ranking", () => {
  test("ranks only fully comparable tasks, cases, Observer, budget, and Telemetry", () => {
    const report = buildRunnerRankingReport(comparableInput());

    expect(report.status).toBe("RANKED");
    expect(report.rankingAllowed).toBe(true);
    expect(report.reasonCodes).toEqual([]);
    expect(report.ranking.map((item) => item.runnerName)).toEqual([
      "opencode",
      "codex"
    ]);
    expect(report.ranking.map((item) => item.rank)).toEqual([1, 2]);
    expect(report.integrity.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() =>
      assertRunnerRankingReportIntegrity(report)
    ).not.toThrow();
    const tampered = structuredClone(report);
    tampered.ranking[0]!.rank = 2;
    expect(() =>
      assertRunnerRankingReportIntegrity(tampered)
    ).toThrow(/integrity/u);
  });

  test.each([
    ["task", (input: RunnerRankingInput) => {
      input.entries[1]!.bindings.taskId = "other-task";
    }, "RANKING_TASK_INCOMPARABLE"],
    ["case set", (input: RunnerRankingInput) => {
      input.entries[1]!.bindings.caseSetHash = HASH_C;
    }, "RANKING_CASES_INCOMPARABLE"],
    ["Observer", (input: RunnerRankingInput) => {
      input.entries[1]!.bindings.observer.keyFingerprint = HASH_C;
    }, "RANKING_OBSERVER_INCOMPARABLE"],
    ["budget", (input: RunnerRankingInput) => {
      input.entries[1]!.bindings.budget.tokenTotal = 999;
    }, "RANKING_BUDGET_INCOMPARABLE"],
    ["Telemetry", (input: RunnerRankingInput) => {
      input.entries[1]!.bindings.telemetry.minimumCompleteness = 0.5;
    }, "RANKING_TELEMETRY_INCOMPARABLE"]
  ] as const)("does not rank when %s differs", (_label, mutate, code) => {
    const input = comparableInput();
    mutate(input);
    const report = buildRunnerRankingReport(input);
    expect(report.status).toBe("INCOMPARABLE");
    expect(report.rankingAllowed).toBe(false);
    expect(report.ranking).toEqual([]);
    expect(report.reasonCodes).toContain(code);
  });

  test("does not rank directional axes or unqualified Observer evidence", () => {
    const directional = comparableInput();
    directional.entries[1]!.comparability.tokenCost = "directional_only";
    expect(buildRunnerRankingReport(directional)).toMatchObject({
      status: "INCOMPARABLE",
      rankingAllowed: false,
      reasonCodes: expect.arrayContaining(["RANKING_AXIS_NOT_COMPARABLE"])
    });

    const unqualified = comparableInput();
    unqualified.entries[0]!.bindings.observer.qualificationStatus = "invalid";
    expect(buildRunnerRankingReport(unqualified)).toMatchObject({
      status: "INCOMPARABLE",
      rankingAllowed: false,
      reasonCodes: expect.arrayContaining([
        "RANKING_OBSERVER_UNQUALIFIED"
      ])
    });

    const incomplete = comparableInput();
    incomplete.entries[1]!.metrics.telemetryCompleteness = 0.79;
    expect(buildRunnerRankingReport(incomplete)).toMatchObject({
      status: "INCOMPARABLE",
      rankingAllowed: false,
      reasonCodes: expect.arrayContaining([
        "RANKING_TELEMETRY_INSUFFICIENT"
      ])
    });
  });
});

function comparableInput(): RunnerRankingInput {
  const bindings = {
    taskId: "task-1",
    targetId: "minimal-directory-agent",
    contractHash: HASH_A,
    caseSetHash: HASH_B,
    observer: {
      id: "reference-observer",
      version: "1.0.0",
      keyFingerprint: HASH_A,
      qualificationArtifactHash: HASH_B,
      qualificationStatus: "valid" as const
    },
    budget: {
      wallClockSeconds: 300,
      tokenTotal: 10_000
    },
    telemetry: {
      schemaVersion: "0.1.0",
      evidenceKind: "live" as const,
      observationLevel: "workflow_trace" as const,
      tokenSource: "native" as const,
      minimumCompleteness: 0.8
    }
  };
  return {
    rankingId: "cross-runner-smoke",
    generatedAt: "2026-07-25T00:00:00.000Z",
    entries: [
      {
        runnerName: "codex",
        adapterVersion: "1.0.0",
        capabilitiesHash: HASH_A,
        comparability: {
          workflowScore: "comparable",
          efficiency: "comparable",
          tokenCost: "comparable"
        },
        bindings: structuredClone(bindings),
        metrics: {
          workflowScore: 92,
          wallClockSeconds: 25,
          tokenTotal: 500,
          telemetryCompleteness: 0.92
        }
      },
      {
        runnerName: "opencode",
        adapterVersion: "1.0.0",
        capabilitiesHash: HASH_C,
        comparability: {
          workflowScore: "comparable",
          efficiency: "comparable",
          tokenCost: "comparable"
        },
        bindings: structuredClone(bindings),
        metrics: {
          workflowScore: 96,
          wallClockSeconds: 20,
          tokenTotal: 450,
          telemetryCompleteness: 0.94
        }
      }
    ]
  };
}
