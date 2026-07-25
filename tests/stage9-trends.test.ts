import { describe, expect, test } from "vitest";
import { buildTrendReport } from "../src/report/trends.js";

describe("Stage 9 trend comparability", () => {
  test("segments history whenever schema, policy, runner, conditions, or contract drift", () => {
    const report = buildTrendReport({
      seriesId: "target-a-smoke",
      points: [
        point("p1"),
        point("p2"),
        point("schema-drift", { schemaVersion: "0.2.0" }),
        point("policy-drift", { policyHash: hash("f") }),
        point("runner-drift", { runnerHash: hash("9") }),
        point("conditions-drift", { conditionsHash: hash("c") }),
        point("contract-drift", { contractHash: hash("8") })
      ]
    });

    expect(report).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "trend_report",
      seriesId: "target-a-smoke"
    });
    expect(report.points).toHaveLength(7);
    expect(report.segments[0]).toMatchObject({
      status: "COMPARABLE",
      pointIds: ["p1", "p2"]
    });
    expect(report.segments.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "INCOMPARABLE",
          reasonCodes: expect.arrayContaining(["SCHEMA_VERSION_DRIFT"]),
          pointIds: ["schema-drift"]
        }),
        expect.objectContaining({
          status: "INCOMPARABLE",
          reasonCodes: expect.arrayContaining(["GATE_POLICY_DRIFT"]),
          pointIds: ["policy-drift"]
        }),
        expect.objectContaining({
          status: "INCOMPARABLE",
          reasonCodes: expect.arrayContaining(["RUNNER_DRIFT"]),
          pointIds: ["runner-drift"]
        }),
        expect.objectContaining({
          status: "INCOMPARABLE",
          reasonCodes: expect.arrayContaining(["CONDITIONS_DRIFT"]),
          pointIds: ["conditions-drift"]
        }),
        expect.objectContaining({
          status: "INCOMPARABLE",
          reasonCodes: expect.arrayContaining(["CONTRACT_DRIFT"]),
          pointIds: ["contract-drift"]
        })
      ])
    );
    expect(report.chartSeries).toEqual([
      expect.objectContaining({
        segmentId: report.segments[0].segmentId,
        points: [
          expect.objectContaining({ pointId: "p1", score: 90 }),
          expect.objectContaining({ pointId: "p2", score: 90 })
        ]
      })
    ]);
  });

  test("starts a new comparable chart era after a policy discontinuity", () => {
    const report = buildTrendReport({
      seriesId: "target-a-smoke",
      points: [
        point("old-1"),
        point("old-2"),
        point("new-1", { policyHash: hash("f") }),
        point("new-2", { policyHash: hash("f") })
      ]
    });

    expect(report.segments).toHaveLength(2);
    expect(report.segments[1]).toMatchObject({
      status: "COMPARABLE",
      reasonCodes: ["GATE_POLICY_DRIFT"],
      pointIds: ["new-1", "new-2"]
    });
    expect(report.chartSeries.map((series) => series.points.map((point) => point.pointId))).toEqual([
      ["old-1", "old-2"],
      ["new-1", "new-2"]
    ]);
  });
});

function point(
  pointId: string,
  overrides: Partial<{
    schemaVersion: string;
    policyHash: string;
    runnerHash: string;
    conditionsHash: string;
    contractHash: string;
  }> = {}
): any {
  return {
    pointId,
    generatedAt: "2026-07-26T00:00:00.000Z",
    schemaVersion: overrides.schemaVersion ?? "0.1.0",
    policyVersion: "1.0.0",
    policyHash: overrides.policyHash ?? hash("a"),
    rulesHash: hash("b"),
    runnerName: "codex",
    runnerCapabilitiesHash: overrides.runnerHash ?? hash("c"),
    conditionsHash: overrides.conditionsHash ?? hash("d"),
    contractHash: overrides.contractHash ?? hash("e"),
    suite: "smoke",
    targetId: "target-a",
    observationLevel: "workflow_trace",
    gateDecision: "PASS",
    score: 90
  };
}

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
