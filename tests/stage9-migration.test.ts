import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  artifactMigrationExitCode,
  migrateArtifact
} from "../src/artifacts/migration.js";
import {
  buildDecisionReport,
  renderDecisionReportMarkdown
} from "../src/report/decisionReport.js";
import { buildHtmlViewerArtifacts } from "../src/report/htmlViewer.js";
import { buildTraceDiff } from "../src/report/traceDiff.js";
import { buildTrendReport } from "../src/report/trends.js";
import { sha256Text } from "../src/utils/hash.js";
import type { RunEvent } from "../src/core/types.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const GENERATED_AT = "2026-07-26T00:00:00.000Z";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "awb-stage9-migration-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Stage 9 artifact migration", () => {
  test("preserves current generated Stage 9 artifacts", async () => {
    for (const artifact of stage9Artifacts()) {
      const input = await writeJson(artifact.fileName, artifact.value);

      const migration = await migrateArtifact(input);

      expect(migration.result).toMatchObject({
        status: "CURRENT",
        trustDisposition: "PRESERVED",
        source: {
          artifactType: artifact.artifactType,
          schemaVersion: "0.1.0"
        },
        target: {
          schemaVersion: "0.1.0",
          schemaFile: artifact.schemaFile
        },
        reasonCodes: []
      });
      expect(migration.artifact).toEqual(artifact.value);
      expect(artifactMigrationExitCode(migration.result)).toBe(0);
    }
  });

  test("downgrades Stage 9 artifacts when required trust fields are missing", async () => {
    for (const artifact of stage9Artifacts()) {
      const stripped = stripPath(structuredClone(artifact.value), artifact.stripPath);
      const input = await writeJson(artifact.fileName, stripped);

      const migration = await migrateArtifact(input);
      const serialized = JSON.stringify(migration);

      expect(migration.artifact).toBeUndefined();
      expect(migration.result).toMatchObject({
        status: "DIAGNOSTIC_ONLY",
        trustDisposition: "DIAGNOSTIC_ONLY",
        source: {
          artifactType: artifact.artifactType,
          schemaVersion: "0.1.0",
          versionInferred: false
        },
        target: {
          schemaVersion: "0.1.0",
          schemaFile: artifact.schemaFile
        },
        reasonCodes: ["ARTIFACT_TRUST_FIELDS_MISSING"]
      });
      expect(migration.result.actions.join(" ")).toMatch(
        /regenerate|rebuild|verified|diagnostic-only/i
      );
      expect(serialized).not.toContain(root);
      expect(artifactMigrationExitCode(migration.result)).toBe(2);
    }
  });

  test("renders a deterministic markdown decision snapshot", () => {
    const markdown = renderDecisionReportMarkdown(decisionReport());

    expect(markdown).toMatchInlineSnapshot(`
      "# Agent Workflow Bench Decision Report

      Target: target-a
      Suite: smoke
      Gate Decision: BLOCK
      Gate Rule: GATE-HARD-FAILURE
      Classification: REGRESSED
      Policy Version: 1.0.0
      Release Authority: source_gate_only

      ## Top Risks
      - P0:TARGET_ROUTE_FORBIDDEN; owner=backend-owner; cases=case-route; evidence=candidate:workflow-trace.json#event=event-route

      ## Case Impacts
      - case-route: REGRESSED; scoreDelta=-20; Retest condition: Retest case-route after backend-owner resolves observed hard failures and fresh candidate workflow-trace evidence is collected.; evidence=candidate:workflow-trace.json#event=event-route

      ## Recommendations
      - TARGET_ROUTE_FORBIDDEN; owner=backend-owner; action=Resolve TARGET_ROUTE_FORBIDDEN: Candidate routed owner-only work to the wrong role. Then rerun the affected cases with fresh qualified workflow-trace evidence.; evidence=candidate:workflow-trace.json#event=event-route

      ## Evidence
      - comparison:comparison-result.json
      - gate:gate-result.json
      - policy:configs/evaluation/gate-policy.json
      - candidate:workflow-trace.json#event=event-route
      - baseline:workflow-trace.json
      "
    `);
  });
});

async function writeJson(fileName: string, value: unknown): Promise<string> {
  const filePath = path.join(root, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function stage9Artifacts() {
  const decision = decisionReport();
  const traceDiff = traceDiffReport();
  const trend = trendReport();
  const viewer = buildHtmlViewerArtifacts(
    { title: "AWB Stage 9", decisionReport: decision, traceDiff, trends: trend },
    { generatedAt: GENERATED_AT, viewerRef: "viewer.html" }
  ).manifest;

  return [
    {
      artifactType: "decision_report",
      fileName: "decision-report.json",
      schemaFile: "decision-report.schema.json",
      stripPath: ["integrity", "contentHash"],
      value: decision
    },
    {
      artifactType: "trace_diff",
      fileName: "trace-diff.json",
      schemaFile: "trace-diff.schema.json",
      stripPath: ["verification", "status"],
      value: traceDiff
    },
    {
      artifactType: "trend_report",
      fileName: "trend-report.json",
      schemaFile: "trend-report.schema.json",
      stripPath: ["manifest", "inputHash"],
      value: trend
    },
    {
      artifactType: "html_viewer_manifest",
      fileName: "html-viewer-manifest.json",
      schemaFile: "html-viewer-manifest.schema.json",
      stripPath: ["restrictions", "mayLoadRemoteAssets"],
      value: viewer
    }
  ] as const;
}

function stripPath<T>(value: T, keys: readonly string[]): T {
  let target: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  delete target[keys[keys.length - 1]!];
  return value;
}

function decisionReport() {
  return buildDecisionReport({
    comparison: comparisonResult(),
    gate: gateResult(),
    generatedAt: GENERATED_AT
  });
}

function traceDiffReport() {
  return buildTraceDiff({
    mode: "baseline_candidate",
    targetId: "target-a",
    suite: "smoke",
    comparability: { status: "COMPARABLE", reasons: [] },
    baseline: trace("baseline", [
      event("b-route", "handoff", "runner", { to: "backend-owner" }),
      event("b-gate", "gate_decision", "runner", { status: "PASS" })
    ]),
    candidate: trace("candidate", [
      event("c-route", "handoff", "runner", { to: "frontend-owner" }),
      event("c-failure", "hard_failure", "observer", {
        code: "TARGET_ROUTE_FORBIDDEN"
      })
    ])
  });
}

function trendReport() {
  return buildTrendReport({
    seriesId: "target-a-smoke",
    points: [trendPoint("p1"), trendPoint("p2")]
  });
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
      comparisonHash: HASH_A,
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
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: HASH_A,
      policyHash: HASH_B
    },
    reasons: ["candidate:TARGET_ROUTE_FORBIDDEN"],
    evidenceRefs: [
      "comparison:comparison-result.json",
      "policy:configs/evaluation/gate-policy.json",
      "candidate:workflow-trace.json#event=event-route"
    ]
  };
}

function trace(label: string, events: RunEvent[]): any {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: label === "baseline" ? HASH_A : HASH_B,
    cases: [{ caseId: "case-route", templateId: "owner-route", events }]
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
    timestamp: "2026-07-26T00:00:00.000Z",
    type,
    actor,
    payload
  };
}

function trendPoint(pointId: string): any {
  return {
    pointId,
    generatedAt: GENERATED_AT,
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
    gateDecision: "BLOCK",
    score: 72
  };
}
