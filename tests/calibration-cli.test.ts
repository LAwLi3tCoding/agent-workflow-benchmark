import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const cwd = process.cwd();
const corpusPath = "fixtures/gold-corpus/v1/manifest.yaml";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "awb-stage6-cli-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Stage 6 gate-policy CLI", () => {
  test("help exposes gate-policy calibration commands", async () => {
    const topLevel = await awb(["--help"]);
    expect(topLevel.stdout).toContain("gate-policy");

    const gatePolicyHelp = await awb(["gate-policy", "--help"]);
    expect(gatePolicyHelp.stdout).toContain("calibrate");
    expect(gatePolicyHelp.stdout).toContain("validate-holdout");

    const compareHelp = await awb(["compare", "--help"]);
    const gateHelp = await awb(["gate", "--help"]);
    expect(compareHelp.stdout).toContain("--gate-policy");
    expect(gateHelp.stdout).toContain("--gate-policy");
  });

  test("calibrate writes a versioned policy and pending calibration report", async () => {
    const out = path.join(root, "fit");
    const result = await awb([
      "gate-policy",
      "calibrate",
      "--corpus",
      corpusPath,
      "--policy-version",
      "1.0.0",
      "--out",
      out
    ]);

    expect(result.exitCode).toBe(2);

    const policy = await readJson(path.join(out, "gate-policy.json"));
    const report = await readJson(path.join(out, "calibration-report.json"));
    const markdown = await readFile(path.join(out, "calibration-report.md"), "utf8");

    await expectValidSchema("gate-policy.schema.json", policy);
    await expectValidSchema("calibration-report.schema.json", report);
    expect(policy).toMatchObject({
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      hardFailurePrecedence: true
    });
    expect(report).toMatchObject({
      reportType: "gate_policy_calibration",
      status: "PENDING_HOLDOUT",
      releaseEligible: false,
      dataBoundary: {
        fitSplits: ["development", "calibration"],
        holdoutExcludedFromFit: true
      },
      policy: {
        policyVersion: "1.0.0",
        policyHash: policy.policyHash,
        rulesHash: policy.rulesHash
      }
    });
    expect(report).not.toHaveProperty("holdout");
    expect(markdown).toContain("PENDING_HOLDOUT");
    expect(JSON.stringify({ policy, report, markdown })).not.toMatch(
      /expectedVerdict|expectedFailureCodes|known_bad|known_good|boundary/u
    );
  }, 30_000);

  test("validate-holdout writes a final report for the frozen policy", async () => {
    const fitOut = path.join(root, "fit");
    const fit = await awb([
      "gate-policy",
      "calibrate",
      "--corpus",
      corpusPath,
      "--policy-version",
      "1.0.0",
      "--out",
      fitOut
    ]);
    expect(fit.exitCode).toBe(2);

    const holdoutOut = path.join(root, "holdout");
    const result = await awb([
      "gate-policy",
      "validate-holdout",
      "--corpus",
      corpusPath,
      "--policy",
      path.join(fitOut, "gate-policy.json"),
      "--calibration-report",
      path.join(fitOut, "calibration-report.json"),
      "--out",
      holdoutOut
    ]);
    const report = await readJson(path.join(holdoutOut, "calibration-report.json"));
    const markdown = await readFile(path.join(holdoutOut, "calibration-report.md"), "utf8");

    expect(result.exitCode).toBe(0);
    await expectValidSchema("calibration-report.schema.json", report);
    expect(report).toMatchObject({
      reportType: "gate_policy_calibration",
      status: "PASS",
      releaseEligible: false,
      blockers: [],
      holdout: {
        falsePassCount: 0,
        stability: {
          scope: "deterministic_harness_replay"
        }
      }
    });
    expect(report.holdout.p0Recall.pointEstimate).toBe(1);
    expect(report.holdout.overallAgreement.pointEstimate).toBeGreaterThanOrEqual(0.85);
    expect(report.holdout.stability.gateDecisionStability.pointEstimate).toBeGreaterThanOrEqual(0.95);
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("Deterministic harness gate stability");
  }, 30_000);
});

async function awb(args: string[]) {
  return execa("npm", ["run", "benchmark", "--", ...args], {
    cwd,
    reject: false
  });
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
}

async function expectValidSchema(schemaName: string, value: unknown): Promise<void> {
  const schema = await readJson(path.join(cwd, "schemas", schemaName));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}
