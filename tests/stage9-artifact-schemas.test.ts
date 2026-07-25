import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import type { RunEvent } from "../src/core/types.js";
import {
  loadArtifactCompatibilityMatrix,
  loadArtifactSchemaRegistry
} from "../src/artifacts/registry.js";
import { buildDecisionReport } from "../src/report/decisionReport.js";
import { buildHtmlViewerArtifacts } from "../src/report/htmlViewer.js";
import { buildTraceDiff } from "../src/report/traceDiff.js";
import { buildTrendReport } from "../src/report/trends.js";
import { sha256Text } from "../src/utils/hash.js";

const cwd = process.cwd();
const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Stage 9 report and viewer artifact schemas", () => {
  test("registers Stage 9 artifact types with compatibility policies", async () => {
    const registry = await loadArtifactSchemaRegistry();
    const matrix = await loadArtifactCompatibilityMatrix();
    const stage9ArtifactTypes = [
      "decision_report",
      "trace_diff",
      "trend_report",
      "html_viewer_manifest"
    ];

    expect(registry.entries.map((entry) => entry.artifactType)).toEqual(
      expect.arrayContaining(stage9ArtifactTypes)
    );
    expect(registry.schemaFiles).toEqual(
      expect.arrayContaining([
        "decision-report.schema.json",
        "trace-diff.schema.json",
        "trend-report.schema.json",
        "html-viewer-manifest.schema.json"
      ])
    );
    expect(matrix.policies.map((policy) => policy.artifactType)).toEqual(
      expect.arrayContaining(stage9ArtifactTypes)
    );
  });

  test("validates canonical builder outputs", async () => {
    await expectValid("decision-report.schema.json", decisionReport());
    await expectValid("trace-diff.schema.json", traceDiff());
    await expectValid("trend-report.schema.json", trendReport());
    await expectValid("html-viewer-manifest.schema.json", viewerManifest());
  });

  test("rejects raw trace payloads from trace diffs", async () => {
    const rawPayloadTrace = traceDiff();
    const eventDelta = rawPayloadTrace.caseDiffs[0]!.eventDeltas[0]! as unknown as Record<
      string,
      unknown
    >;
    eventDelta.payload = { command: "cat secret.txt" };

    await expectInvalid("trace-diff.schema.json", rawPayloadTrace);
  });

  test("rejects a decision report bound to a non-canonical gate policy id", async () => {
    const report = decisionReport();
    (report.gatePolicy as { policyId: string }).policyId =
      "not-awb-gate-policy";
    await expectInvalid("decision-report.schema.json", report);
  });

  test("requires comparable trend segments and chart series", async () => {
    const brokenComparableSegment = trendReport();
    (brokenComparableSegment.segments[0]!.reasonCodes as string[]) = [
      "MODEL_MISMATCH"
    ];
    await expectInvalid("trend-report.schema.json", brokenComparableSegment);

    const missingChartSeries = trendReport() as Partial<
      ReturnType<typeof trendReport>
    >;
    delete missingChartSeries.chartSeries;
    await expectInvalid("trend-report.schema.json", missingChartSeries);
  });

  test("keeps HTML viewer manifests public, read-only, and viewer-bound", async () => {
    const mutableViewer = viewerManifest();
    (mutableViewer.restrictions as { mayChangeGateResult: boolean }).mayChangeGateResult = true;
    await expectInvalid("html-viewer-manifest.schema.json", mutableViewer);

    const unboundViewer = viewerManifest();
    delete (unboundViewer.integrity as Record<string, unknown>).viewerRef;
    await expectInvalid("html-viewer-manifest.schema.json", unboundViewer);
  });
});

async function expectValid(schemaName: string, value: unknown): Promise<void> {
  const validate = await validator(schemaName);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

async function expectInvalid(schemaName: string, value: unknown): Promise<void> {
  const validate = await validator(schemaName);
  expect(validate(value)).toBe(false);
}

async function validator(schemaName: string) {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", schemaName), "utf8")
  ) as object;
  return new Ajv2020({ strict: false }).compile(schema);
}

function decisionReport() {
  return buildDecisionReport({
    comparison: comparisonResult(),
    gate: gateResult(),
    generatedAt: "2026-07-26T00:00:00.000Z",
    candidateComparabilityFingerprint: "candidate-fingerprint",
    ownerSource: "target-pack",
    reliability: {
      resultType: "reliability_report",
      conclusion: "QUARANTINED",
      gateEligibility: "DIAGNOSTIC_ONLY",
      metrics: {
        sampleSize: { requested: 20, observed: 20, minimum: 20 },
        missingRate: 0.05,
        dimensionVariance: [{ dimension: "routing", variance: 0.12 }],
        pairedDelta: {
          score: -8,
          interval: { lower: -12, upper: -4 }
        }
      }
    },
    validity: {
      resultType: "validity_report",
      status: "INSUFFICIENT_EVIDENCE",
      metrics: {
        sampleSize: { observed: 119, required: 120 },
        p0Recall: 1,
        falsePassCount: 0,
        overallAgreement: 0.84,
        cohenKappa: 0.79
      }
    }
  });
}

function traceDiff() {
  const baseline = trace("baseline", [
    event("b-start", "case_start", "runner", { caseId: "case-route" }),
    event("b-route", "handoff", "runner", { to: "backend-owner" })
  ]);
  const candidate = trace("candidate", [
    event("c-start", "case_start", "runner", { caseId: "case-route" }),
    event("c-route", "handoff", "runner", { to: "frontend-owner" }),
    event("c-failure", "hard_failure", "observer", {
      code: "TARGET_ROUTE_FORBIDDEN"
    })
  ]);
  return buildTraceDiff({
    mode: "baseline_candidate",
    targetId: "target-a",
    suite: "smoke",
    comparability: { status: "COMPARABLE", reasons: [] },
    evidenceLevel: "verified_live",
    verification: {
      status: "QUALIFIED_SIGNED_TRACES",
      sourceTraceHashes: [baseline.traceHash, candidate.traceHash],
      observerKeyFingerprints: [hashA],
      qualificationArtifacts: [
        {
          ref: "observer:observer-qualification.json",
          sha256: hashB
        }
      ]
    },
    baseline,
    candidate
  });
}

function trendReport() {
  return buildTrendReport({
    seriesId: "target-a-smoke",
    points: [trendPoint("p1"), trendPoint("p2")]
  });
}

function viewerManifest() {
  return buildHtmlViewerArtifacts(
    {
      title: "AWB decision",
      decisionReport: decisionReport(),
      traceDiff: traceDiff(),
      trends: trendReport()
    },
    {
      generatedAt: "2026-07-26T00:00:00.000Z",
      viewerRef: "viewer.html"
    }
  ).manifest;
}

function comparisonResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    gatePolicy: gatePolicy(),
    baseline: {
      targetId: "target-a",
      suite: "smoke",
      runId: "baseline",
      releaseDecision: "APPROVE",
      score: 92,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    candidate: {
      targetId: "target-a",
      suite: "smoke",
      runId: "candidate",
      releaseDecision: "BLOCK",
      score: 72,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    comparability: { status: "COMPARABLE", reasons: [] },
    classification: "REGRESSED",
    scoreDelta: -20,
    caseDeltas: [
      {
        caseId: "case-route",
        classification: "REGRESSED",
        baselineVerdict: "PASS",
        candidateVerdict: "FAIL",
        scoreDelta: -20,
        newHardFailures: ["TARGET_ROUTE_FORBIDDEN"],
        resolvedHardFailures: []
      }
    ],
    summary: {
      improved: 0,
      regressed: 1,
      unchanged: 0,
      hardFailure: 1,
      incomparable: 0
    },
    hardFailures: [
      {
        code: "TARGET_ROUTE_FORBIDDEN",
        severity: "P0",
        source: "candidate",
        caseId: "case-route",
        owner: "backend-owner",
        why: "Candidate routed owner-only work to the wrong role.",
        evidenceEventIds: ["event-route"]
      }
    ],
    evidenceRefs: {
      baseline: ["baseline:workflow-trace.json"],
      candidate: ["candidate:workflow-trace.json#event=event-route"]
    },
    integrity: {
      status: "VERIFIED_AT_WRITE",
      comparisonHash: hashA,
      baselineRef: "evidence/baseline",
      candidateRef: "evidence/candidate",
      artifacts: []
    }
  };
}

function gateResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    decision: "BLOCK",
    ruleId: "GATE-HARD-FAILURE",
    targetId: "target-a",
    suite: "smoke",
    comparisonClassification: "REGRESSED",
    comparisonIntegrity: "VALID",
    gatePolicy: gatePolicy(),
    reasons: ["candidate:TARGET_ROUTE_FORBIDDEN"],
    evidenceRefs: [
      "comparison:comparison-result.json",
      "policy:configs/evaluation/gate-policy.json",
      "candidate:workflow-trace.json#event=event-route"
    ]
  };
}

function gatePolicy() {
  return {
    policyId: "awb-gate-policy",
    policyVersion: "1.0.0",
    rulesHash: hashA,
    policyHash: hashB
  };
}

function trace(label: string, events: RunEvent[]): any {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: sha256Text(label),
    cases: [
      {
        caseId: "case-route",
        templateId: "owner-route",
        events
      }
    ]
  };
}

function event(
  eventId: string,
  type: RunEvent["type"],
  actor: string,
  payload: Record<string, unknown>
): RunEvent {
  return {
    eventId,
    timestamp: `2026-07-26T00:00:0${eventId.length % 10}.000Z`,
    type,
    actor,
    payload
  };
}

function trendPoint(pointId: string): any {
  return {
    pointId,
    generatedAt: "2026-07-26T00:00:00.000Z",
    schemaVersion: "0.1.0",
    policyVersion: "1.0.0",
    policyHash: hashA,
    rulesHash: hashB,
    runnerName: "codex",
    runnerCapabilitiesHash: hash("c"),
    conditionsHash: hash("d"),
    contractHash: hash("e"),
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
