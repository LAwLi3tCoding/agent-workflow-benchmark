import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { execa } from "execa";
import { hashFile } from "../src/utils/hash.js";

const cwd = process.cwd();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

let root = "";
let comparisonPath = "";
let decisionPath = "";
let traceDiffPath = "";
let trendPath = "";

describe("Stage 9 report CLI", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-stage9-cli-"));
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("revalidates comparison and gate evidence before writing a decision report", async () => {
    const baseline = path.join(root, "baseline");
    const candidate = path.join(root, "candidate");
    const comparisonOut = path.join(root, "comparison");
    const gateOut = path.join(root, "gate");
    const decisionOut = path.join(root, "decision");

    await awb([
      "run",
      "--target",
      "minimal-directory-agent",
      "--suite",
      "smoke",
      "--runner",
      "simulated",
      "--seed",
      "stage9-cli-seed",
      "--out",
      baseline
    ]);
    await awb([
      "run",
      "--target",
      "minimal-directory-agent",
      "--suite",
      "smoke",
      "--runner",
      "simulated",
      "--seed",
      "stage9-cli-seed",
      "--out",
      candidate
    ]);
    await awb([
      "report",
      "--run",
      baseline,
      "--format",
      "md,json"
    ]);
    expect(await readFile(path.join(baseline, "report.md"), "utf8")).toContain(
      "# Agent Workflow Bench Report"
    );
    await awb([
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      comparisonOut
    ]);
    const gate = await awb(
      [
        "gate",
        "--comparison",
        path.join(comparisonOut, "comparison-result.json"),
        "--out",
        gateOut
      ],
      false
    );
    expect(gate.exitCode).toBe(2);

    await awb([
      "report",
      "decision",
      "--comparison",
      path.join(comparisonOut, "comparison-result.json"),
      "--gate-result",
      path.join(gateOut, "gate-result.json"),
      "--out",
      decisionOut
    ]);

    comparisonPath = path.join(comparisonOut, "comparison-result.json");
    decisionPath = path.join(decisionOut, "decision-report.json");
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    await expectValid("decision-report.schema.json", decision);
    expect(decision).toMatchObject({
      artifactType: "decision_report",
      gateDecision: "DIAGNOSTIC_ONLY",
      releaseAuthority: "source_gate_only"
    });
    expect(decision.provenance.comparisonHash).toMatch(
      /^sha256:[a-f0-9]{64}$/u
    );
    expect(
      decision.provenance.sourceArtifacts.find(
        (artifact: any) => artifact.role === "comparison"
      )
    ).toEqual({
      role: "comparison",
      ref: "comparison-result.json",
      sha256: await hashFile(comparisonPath),
      hashKind: "file_bytes"
    });
    expect(
      await readFile(path.join(decisionOut, "decision-report.md"), "utf8")
    ).toContain("Release Authority: source_gate_only");

    const tamperedComparisonPath = path.join(
      comparisonOut,
      "tampered-comparison-result.json"
    );
    const tamperedComparison = JSON.parse(
      await readFile(comparisonPath, "utf8")
    );
    tamperedComparison.integrity.candidateRef =
      "../../outside-comparison-bundle";
    await writeJson(tamperedComparisonPath, tamperedComparison);
    const tamperedGateOut = path.join(root, "tampered-gate");
    const tamperedGate = await awb(
      [
        "gate",
        "--comparison",
        tamperedComparisonPath,
        "--out",
        tamperedGateOut
      ],
      false
    );
    expect(tamperedGate.exitCode).toBe(1);

    const tamperedDecisionOut = path.join(root, "tampered-decision");
    const tamperedDecision = await awb(
      [
        "report",
        "decision",
        "--comparison",
        tamperedComparisonPath,
        "--gate-result",
        path.join(tamperedGateOut, "gate-result.json"),
        "--out",
        tamperedDecisionOut
      ],
      false
    );
    expect(tamperedDecision.exitCode).toBe(0);
    expect(
      JSON.parse(
        await readFile(
          path.join(tamperedDecisionOut, "decision-report.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      gateDecision: "BLOCK",
      gateRuleId: "GATE-COMPARISON-INTEGRITY"
    });
  }, 30_000);

  test("writes diagnostic baseline/candidate and baseline/mutant/restore trace diffs without raw payloads", async () => {
    const baseline = path.join(root, "baseline-trace.json");
    const candidate = path.join(root, "candidate-trace.json");
    const mutant = path.join(root, "mutant-trace.json");
    const restore = path.join(root, "restore-trace.json");
    await Promise.all([
      writeJson(baseline, trace("baseline", "owner-a", "PASS")),
      writeJson(candidate, trace("candidate", "owner-b", "BLOCK")),
      writeJson(mutant, trace("mutant", "owner-b", "BLOCK")),
      writeJson(restore, trace("restore", "owner-a", "PASS"))
    ]);

    const candidateOut = path.join(root, "trace-candidate");
    await awb([
      "report",
      "trace-diff",
      "--mode",
      "baseline-candidate",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      candidateOut
    ]);
    traceDiffPath = path.join(candidateOut, "trace-diff.json");
    const candidateDiff = JSON.parse(await readFile(traceDiffPath, "utf8"));
    await expectValid("trace-diff.schema.json", candidateDiff);
    expect(candidateDiff.evidenceLevel).toBe("diagnostic_simulated");
    expect(JSON.stringify(candidateDiff)).not.toContain('"payload"');
    expect(JSON.stringify(candidateDiff)).not.toContain("owner-a");
    expect(JSON.stringify(candidateDiff)).not.toContain("owner-b");

    const restoreOut = path.join(root, "trace-restore");
    await awb([
      "report",
      "trace-diff",
      "--mode",
      "baseline-mutant-restore",
      "--baseline",
      baseline,
      "--mutant",
      mutant,
      "--restore",
      restore,
      "--out",
      restoreOut
    ]);
    const restoreDiff = JSON.parse(
      await readFile(path.join(restoreOut, "trace-diff.json"), "utf8")
    );
    await expectValid("trace-diff.schema.json", restoreDiff);
    expect(restoreDiff.restoreStatus).toBe("RESTORED");
  });

  test("segments incompatible trends and renders an immutable public-safe viewer", async () => {
    const trendInput = path.join(root, "trend-input.json");
    await writeJson(trendInput, {
      seriesId: "minimal-directory-agent-smoke",
      points: [
        point("p1", "2026-07-26T00:00:00.000Z"),
        point("p2", "2026-07-26T00:01:00.000Z"),
        point("policy-drift", "2026-07-26T00:02:00.000Z", {
          policyHash: HASH_C
        })
      ]
    });
    const trendOut = path.join(root, "trend");
    await awb([
      "report",
      "trend",
      "--input",
      trendInput,
      "--out",
      trendOut
    ]);
    trendPath = path.join(trendOut, "trend-report.json");
    const trend = JSON.parse(await readFile(trendPath, "utf8"));
    await expectValid("trend-report.schema.json", trend);
    expect(trend.chartSeries).toHaveLength(1);
    expect(trend.chartSeries[0].points.map((item: any) => item.pointId)).toEqual([
      "p1",
      "p2"
    ]);
    expect(trend.chartSeries[0].points).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointId: "policy-drift" })
      ])
    );

    const inputHashes = await Promise.all(
      [decisionPath, comparisonPath, traceDiffPath, trendPath].map(hashFile)
    );
    const viewerOut = path.join(root, "viewer");
    await awb([
      "report",
      "viewer",
      "--decision",
      decisionPath,
      "--comparison",
      comparisonPath,
      "--trace-diff",
      traceDiffPath,
      "--trend",
      trendPath,
      "--out",
      viewerOut
    ]);
    expect(
      await Promise.all(
        [decisionPath, comparisonPath, traceDiffPath, trendPath].map(hashFile)
      )
    ).toEqual(inputHashes);

    const manifest = JSON.parse(
      await readFile(
        path.join(viewerOut, "html-viewer-manifest.json"),
        "utf8"
      )
    );
    await expectValid("html-viewer-manifest.schema.json", manifest);
    expect(manifest).toMatchObject({
      publicSafe: true,
      readOnly: true,
      restrictions: {
        mayChangeGateResult: false,
        mayReadUnredactedTrace: false,
        mayLoadRemoteAssets: false,
        mayExecuteCommands: false,
        mayWriteArtifacts: false
      }
    });
    expect(await hashFile(path.join(viewerOut, "viewer.html"))).toBe(
      manifest.integrity.viewerHash
    );
    const html = await readFile(path.join(viewerOut, "viewer.html"), "utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script\b|<form\b|fetch\(|localStorage/iu);
  }, 30_000);

  test("rejects impossible RFC 3339 dates instead of silently normalizing them", async () => {
    const trendInput = path.join(root, "invalid-date-trend-input.json");
    await writeJson(trendInput, {
      seriesId: "minimal-directory-agent-smoke",
      points: [point("invalid-date", "2026-02-30T00:00:00.000Z")]
    });

    const result = await awb(
      [
        "report",
        "trend",
        "--input",
        trendInput,
        "--out",
        path.join(root, "invalid-date-trend")
      ],
      false
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('unknown format "date-time"');
  });
});

function awb(args: string[], reject = true) {
  return execa("npm", ["run", "benchmark", "--", ...args], {
    cwd,
    reject
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function expectValid(schemaName: string, value: unknown): Promise<void> {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", schemaName), "utf8")
  ) as object;
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function trace(label: string, owner: string, status: string) {
  return {
    schemaVersion: "0.1.0",
    observer: {
      id: "reference-observer",
      version: "1.0.0",
      keyFingerprint: HASH_A
    },
    subject: {
      targetId: "minimal-directory-agent",
      contractHash: HASH_B,
      suite: "smoke",
      seed: "stage9-cli-seed",
      caseSetHash: HASH_C,
      runner: {
        name: "codex",
        adapterVersion: "1.0.0",
        capabilitiesHash: HASH_A
      },
      isolation: "read_only_sandbox",
      permissionMode: "read_only_no_approval"
    },
    cases: [
      {
        caseId: "case-1",
        templateId: "static-contract",
        runId: `${label}-run`,
        events: [
          {
            eventId: `${label}-start`,
            timestamp: "2026-07-26T00:00:00.000Z",
            type: "case_start",
            actor: owner,
            payload: { caseId: "case-1" }
          },
          {
            eventId: `${label}-gate`,
            timestamp: "2026-07-26T00:00:01.000Z",
            type: "gate_decision",
            actor: owner,
            payload: { status }
          }
        ],
        wallClockSeconds: 1,
        tokens: {
          input: 1,
          output: 1,
          total: 2,
          wasted: 0,
          costEstimateConfidence: "high"
        },
        telemetryCompleteness: 1
      }
    ],
    attestation: {
      algorithm: "ed25519",
      signature: "diagnostic-only"
    }
  };
}

function point(
  pointId: string,
  generatedAt: string,
  overrides: { policyHash?: string } = {}
) {
  return {
    pointId,
    generatedAt,
    schemaVersion: "0.1.0",
    policyVersion: "1.0.0",
    policyHash: overrides.policyHash ?? HASH_A,
    rulesHash: HASH_B,
    runnerName: "codex",
    runnerCapabilitiesHash: HASH_C,
    conditionsHash: HASH_A,
    contractHash: HASH_B,
    suite: "smoke",
    targetId: "minimal-directory-agent",
    observationLevel: "workflow_trace",
    gateDecision: "PASS",
    score: 90
  };
}
