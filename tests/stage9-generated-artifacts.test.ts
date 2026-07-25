import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { execa } from "execa";
import {
  buildDecisionReport
} from "../src/report/decisionReport.js";
import {
  buildTraceDiff
} from "../src/report/traceDiff.js";
import {
  buildTrendReport
} from "../src/report/trends.js";
import {
  buildHtmlViewerArtifacts
} from "../src/report/htmlViewer.js";
import {
  sha256Text,
  stableJson
} from "../src/utils/hash.js";
import type { RunEvent } from "../src/core/types.js";

const cwd = process.cwd();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

describe("Stage 9 generated artifact contracts", () => {
  test("validates the actual builder outputs against every registered Stage 9 schema", async () => {
    const decision = buildDecisionReport({
      comparison: comparisonResult(),
      gate: gateResult(),
      generatedAt: "2026-07-26T00:00:00.000Z"
    });
    const traceDiff = buildTraceDiff({
      mode: "baseline_candidate",
      targetId: "target-a",
      suite: "smoke",
      comparability: { status: "COMPARABLE", reasons: [] },
      baseline: trace("baseline", [event("baseline-start")]),
      candidate: trace("candidate", [event("candidate-start")])
    });
    const trends = buildTrendReport({
      seriesId: "target-a-smoke",
      points: [trendPoint("p1"), trendPoint("p2")]
    });
    const viewer = buildHtmlViewerArtifacts(
      {
        title: "AWB decision",
        decisionReport: decision,
        comparison: comparisonResult(),
        traceDiff,
        trends
      },
      {
        generatedAt: "2026-07-26T00:00:00.000Z",
        viewerRef: "viewer.html"
      }
    );

    await expectValid("decision-report.schema.json", decision);
    await expectValid("trace-diff.schema.json", traceDiff);
    await expectValid("trend-report.schema.json", trends);
    await expectValid("html-viewer-manifest.schema.json", viewer.manifest);

    expect(decision.integrity.contentHash).toBe(contentHash(decision));
    expect(traceDiff.integrity.contentHash).toBe(contentHash(traceDiff));
    expect(trends.integrity.contentHash).toBe(contentHash(trends));
    expect(viewer.manifest.integrity.contentHash).toBe(
      contentHash(viewer.manifest)
    );
    expect(viewer.manifest.integrity.viewerHash).toBe(sha256Text(viewer.html));
  });

  test("refuses to package an HTML viewer from an unredacted artifact", () => {
    const privatePath = ["/", "private", "/", "target", "/source.txt"].join("");
    expect(() =>
      buildHtmlViewerArtifacts({
        title: "unsafe",
        decisionReport: {
          schemaVersion: "0.1.0",
          artifactType: "decision_report",
          evidenceRefs: [privatePath]
        }
      })
    ).toThrow(/already-redacted public artifacts/iu);
  });

  test("binds explicit viewer manifest inputs to the displayed artifact values", () => {
    expect(() =>
      buildHtmlViewerArtifacts(
        {
          title: "bound viewer",
          decisionReport: {
            schemaVersion: "0.1.0",
            artifactType: "decision_report",
            gateDecision: "BLOCK"
          }
        },
        {
          inputs: [
            {
              artifactType: "trend_report",
              ref: "trend-report.json",
              sha256: HASH_A,
              schemaVersion: "0.1.0"
            }
          ]
        }
      )
    ).toThrow(/match the displayed artifacts/iu);
  });

  test("normalizes real reliability and validity metrics into the decision schema", async () => {
    const decision = buildDecisionReport({
      comparison: comparisonResult(),
      gate: gateResult(),
      generatedAt: "2026-07-26T00:00:00.000Z",
      reliability: {
        resultType: "reliability_report",
        conclusion: "INSUFFICIENT_EVIDENCE",
        gateEligibility: "DIAGNOSTIC_ONLY",
        quarantinedCases: [
          { caseId: "case-1", consistency: 0.8, status: "QUARANTINED" }
        ],
        metrics: {
          sampleSize: {
            requested: 20,
            observed: 19,
            missing: 1,
            minimum: 20
          },
          missingRate: 0.05,
          dimensionVariance: [
            { dimension: "routing", meanDelta: -1, variance: 0.2 }
          ],
          pairedDelta: {
            mean: -1,
            variance: 0.2,
            interval: { lower: -2, upper: 0 }
          }
        }
      } as any,
      validity: {
        resultType: "external_validity_report",
        status: "PENDING_HUMAN_INPUT",
        metrics: {
          sampleSize: {
            planned: 120,
            observed: 20,
            labeled: 0,
            adjudicated: 0
          },
          confusionMatrix: [],
          p0Precision: null,
          p0Recall: null,
          falsePassCount: null,
          overallAgreement: null,
          interRaterAgreement: null,
          cohenKappa: null
        }
      } as any
    });

    await expectValid("decision-report.schema.json", decision);
    expect(decision.statistics?.variance).toEqual([
      { dimension: "routing", variance: 0.2 }
    ]);
    expect(decision.statistics?.validity).toEqual({
      sampleSize: {
        planned: 120,
        observed: 20,
        labeled: 0,
        adjudicated: 0
      },
      p0Recall: null,
      falsePassCount: null,
      overallAgreement: null,
      cohenKappa: null
    });
  });

  test("exposes Stage 9 report subcommands without caller-controlled time", async () => {
    const help = await execa(
      "npm",
      ["run", "benchmark", "--", "report", "--help"],
      { cwd }
    );

    expect(help.stdout).toContain("decision");
    expect(help.stdout).toContain("trace-diff");
    expect(help.stdout).toContain("trend");
    expect(help.stdout).toContain("viewer");
    expect(help.stdout).toContain("--run");
    expect(help.stdout).not.toContain("--now");
  });
});

async function expectValid(schemaName: string, value: unknown): Promise<void> {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", schemaName), "utf8")
  ) as object;
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function contentHash(value: { integrity: { contentHash: string } }): string {
  const { integrity: _integrity, ...content } = value;
  return sha256Text(stableJson(content));
}

function comparisonResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: HASH_A,
      policyHash: HASH_B
    },
    baseline: {
      targetId: "target-a",
      suite: "smoke",
      runId: "baseline",
      releaseDecision: "APPROVE",
      score: 90,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    candidate: {
      targetId: "target-a",
      suite: "smoke",
      runId: "candidate",
      releaseDecision: "APPROVE",
      score: 90,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    comparability: { status: "COMPARABLE", reasons: [] },
    classification: "UNCHANGED",
    scoreDelta: 0,
    caseDeltas: [
      {
        caseId: "case-1",
        classification: "UNCHANGED",
        baselineVerdict: "PASS",
        candidateVerdict: "PASS",
        scoreDelta: 0,
        newHardFailures: [],
        resolvedHardFailures: []
      }
    ],
    summary: {
      improved: 0,
      regressed: 0,
      unchanged: 1,
      hardFailure: 0,
      incomparable: 0
    },
    hardFailures: [],
    evidenceRefs: {
      baseline: ["baseline:workflow-trace.json"],
      candidate: ["candidate:workflow-trace.json"]
    },
    integrity: {
      status: "VERIFIED_AT_WRITE",
      comparisonHash: HASH_C,
      baselineRef: "evidence/baseline",
      candidateRef: "evidence/candidate",
      artifacts: [
        { ref: "evidence/baseline/suite-result.json", sha256: HASH_A },
        { ref: "evidence/candidate/suite-result.json", sha256: HASH_B }
      ]
    }
  };
}

function gateResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    decision: "PASS",
    ruleId: "GATE-PASS",
    targetId: "target-a",
    suite: "smoke",
    comparisonClassification: "UNCHANGED",
    comparisonIntegrity: "VALID",
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: HASH_A,
      policyHash: HASH_B
    },
    reasons: ["matched"],
    evidenceRefs: [
      "comparison:comparison-result.json",
      "policy:configs/evaluation/gate-policy.json"
    ]
  };
}

function trace(label: string, events: RunEvent[]): any {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: label === "baseline" ? HASH_A : HASH_B,
    cases: [{ caseId: "case-1", templateId: "static-contract", events }]
  };
}

function event(eventId: string): RunEvent {
  return {
    eventId,
    timestamp: "2026-07-26T00:00:00.000Z",
    type: "case_start",
    actor: "observer",
    payload: { observedBy: "reference_observer" }
  };
}

function trendPoint(pointId: string): any {
  return {
    pointId,
    generatedAt: "2026-07-26T00:00:00.000Z",
    schemaVersion: "0.1.0",
    policyVersion: "1.0.0",
    policyHash: HASH_A,
    rulesHash: HASH_B,
    runnerName: "codex",
    runnerCapabilitiesHash: HASH_C,
    conditionsHash: HASH_A,
    contractHash: HASH_B,
    suite: "smoke",
    targetId: "target-a",
    observationLevel: "workflow_trace",
    gateDecision: "PASS",
    score: 90
  };
}
