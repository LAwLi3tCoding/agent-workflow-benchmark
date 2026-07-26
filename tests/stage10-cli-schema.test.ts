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

const cwd = process.cwd();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
let root = "";

describe("Stage 10 CLI and artifact schemas", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-stage10-cli-"));
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exposes adapter, benchmark-health, and runner-ranking commands", async () => {
    const adapter = await awb(["adapter", "conformance", "--help"]);
    const health = await awb(["ci", "benchmark-health", "--help"]);
    const ranking = await awb(["report", "runner-ranking", "--help"]);
    expect(adapter.stdout).toContain("--adapter");
    expect(health.stdout).toContain("--input");
    expect(ranking.stdout).toContain("--input");
  });

  test("writes schema-valid health and ranking artifacts", async () => {
    const healthInputPath = path.join(root, "health-input.json");
    await writeJson(healthInputPath, healthyInput());
    const healthOut = path.join(root, "health-out");
    await awb([
      "ci",
      "benchmark-health",
      "--input",
      healthInputPath,
      "--out",
      healthOut
    ]);
    const health = JSON.parse(
      await readFile(path.join(healthOut, "benchmark-health-report.json"), "utf8")
    );
    await expectValid("benchmark-health-report.schema.json", health);
    expect(health.versionDisposition).toBe("RELEASE_ELIGIBLE");

    const rankingInputPath = path.join(root, "ranking-input.json");
    await writeJson(rankingInputPath, rankingInput());
    const rankingOut = path.join(root, "ranking-out");
    await awb([
      "report",
      "runner-ranking",
      "--input",
      rankingInputPath,
      "--out",
      rankingOut
    ]);
    const ranking = JSON.parse(
      await readFile(path.join(rankingOut, "runner-ranking-report.json"), "utf8")
    );
    await expectValid("runner-ranking-report.schema.json", ranking);
    expect(ranking.rankingAllowed).toBe(true);
  });

  test("runs built-in OpenCode conformance through a fixture executable", async () => {
    const executable = path.join(root, "opencode");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'fixture', part: { text: JSON.stringify({ verdict: 'PASS', caveats: [], hardFailureCodes: [] }) } }));",
        "console.log(JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID: 'fixture', part: { id: 'step-1', type: 'step-finish', tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 6 } } }));",
        "console.log(JSON.stringify({ type: 'message.updated', timestamp: 3, sessionID: 'fixture', info: { role: 'assistant', time: { created: 1, completed: 2 }, cost: 0, tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 6 }, finish: 'stop' } }));"
      ].join("\n"),
      { mode: 0o755 }
    );
    const output = path.join(root, "adapter-out");
    await awb([
      "adapter",
      "conformance",
      "--adapter",
      "opencode",
      "--target",
      "minimal-directory-agent",
      "--adapter-executable",
      executable,
      "--out",
      output
    ]);
    const report = JSON.parse(
      await readFile(path.join(output, "adapter-conformance-report.json"), "utf8")
    );
    await expectValid("adapter-conformance-report.schema.json", report);
    expect(report).toMatchObject({
      decision: "PASS",
      releaseDisposition: "DIAGNOSTIC_ONLY"
    });
  }, 30_000);

  test("executes OpenCode through the generic run command without granting a true PASS", async () => {
    const executable = path.join(root, "opencode-live");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'fixture', part: { text: JSON.stringify({ verdict: 'PASS', caveats: [], hardFailureCodes: [] }) } }));",
        "console.log(JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID: 'fixture', part: { id: 'step-1', type: 'step-finish', tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 6 } } }));",
        "console.log(JSON.stringify({ type: 'message.updated', timestamp: 3, sessionID: 'fixture', info: { role: 'assistant', time: { created: 1, completed: 2 }, cost: 0, tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 6 }, finish: 'stop' } }));"
      ].join("\n"),
      { mode: 0o755 }
    );
    const output = path.join(root, "opencode-live-out");
    const run = await awb(
      [
        "run",
        "--target",
        "minimal-directory-agent",
        "--suite",
        "smoke",
        "--runner",
        "opencode",
        "--execution",
        "live",
        "--mode",
        "diagnostic",
        "--out",
        output
      ],
      false,
      { AWB_OPENCODE_EXECUTABLE: executable }
    );
    expect(run.exitCode).toBe(0);
    const runtime = JSON.parse(
      await readFile(path.join(output, "runtime-manifest.json"), "utf8")
    );
    const suite = JSON.parse(
      await readFile(path.join(output, "suite-result.json"), "utf8")
    );
    const firstCase = JSON.parse(
      await readFile(
        path.join(
          output,
          "case-results",
          "minimal-directory-agent-smoke-001-static-contract.json"
        ),
        "utf8"
      )
    );
    expect(runtime.runner).toMatchObject({
      name: "opencode",
      executionMode: "live",
      adapterVersion: "1.0.0",
      tokenSourceDetail: {
        source: "native",
        confidence: "high"
      }
    });
    expect(firstCase.tokens).toMatchObject({
      input: 4,
      output: 2,
      total: 6,
      costEstimateConfidence: "high"
    });
    expect(suite).toMatchObject({
      releaseDecision: "DIAGNOSTIC_ONLY",
      releaseRuleId: "REL-EVIDENCE-CONTRACT-SUMMARY"
    });
  }, 30_000);

  test("registers all Stage 10 schemas and canonical adapter configs", async () => {
    const result = await awb(["validate-schema"]);
    expect(result.stdout).toContain("schemas valid");
    expect(result.stdout).toContain("adapter configs valid");
    expect(result.stderr).not.toContain('unknown format "date-time"');
  });
});

async function awb(
  args: string[],
  reject = true,
  env?: Record<string, string>
) {
  return execa("npm", ["run", "benchmark", "--", ...args], {
    cwd,
    reject,
    env
  });
}

async function expectValid(schemaFile: string, value: unknown): Promise<void> {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", schemaFile), "utf8")
  );
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function healthyInput() {
  return {
    benchmarkVersion: "0.1.0",
    generatedAt: "2026-07-25T00:00:00.000Z",
    goldCorpus: {
      status: "PASS",
      evidenceRef: "health/gold-corpus-report.json",
      evidenceHash: HASH_A,
      p0MutationKillRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0,
      knownGoodBlockedCount: 0
    },
    p0Mutation: {
      status: "PASS",
      evidenceRef: "health/p0-mutation-report.json",
      evidenceHash: HASH_B,
      detectionRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0
    },
    observerQualification: {
      status: "PASS",
      evidenceRef: "health/observer-qualification.json",
      evidenceHash: HASH_C,
      decision: "valid",
      p0DetectionRate: 1,
      falsePassCount: 0,
      privateKeyVisibleToRunner: false
    },
    aaReliability: {
      status: "PASS",
      evidenceRef: "health/reliability-report.json",
      evidenceHash: HASH_A,
      gateEligibility: "ELIGIBLE",
      deterministicAgreement: 1,
      stableGateAgreement: 1,
      p0FalsePassCount: 0,
      sampleSufficient: true
    },
    schemaCompatibility: {
      status: "PASS",
      evidenceRef: "health/schema-compatibility.json",
      evidenceHash: HASH_B,
      compatible: true,
      incompatibleArtifactCount: 0
    },
    pluginInstall: {
      status: "PASS",
      evidenceRef: "health/plugin-install.json",
      evidenceHash: HASH_C,
      freshInstall: true,
      runtimeParity: true
    },
    privacyScan: {
      status: "PASS",
      evidenceRef: "health/privacy-scan.json",
      evidenceHash: HASH_A,
      findingCount: 0
    }
  };
}

function rankingInput() {
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
      qualificationStatus: "valid"
    },
    budget: { wallClockSeconds: 300, tokenTotal: 10_000 },
    telemetry: {
      schemaVersion: "0.1.0",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      tokenSource: "native",
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
        bindings,
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
        bindings,
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
