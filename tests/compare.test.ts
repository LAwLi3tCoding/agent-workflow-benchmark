import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import { evaluateGate } from "../src/regression/gate.js";
import { hashFile, sha256Text, stableJson } from "../src/utils/hash.js";

const cwd = process.cwd();
let root = "";
let cleanBaseline = "";
let cleanCandidate = "";
let hardBaseline = "";
let hardCandidate = "";
let regressedCandidate = "";
let mismatchedCandidate = "";

async function runFixture(out: string, options: { mutation?: string; suite?: string } = {}): Promise<void> {
  const args = [
    "run",
    "benchmark",
    "--",
    "run",
    "--target",
    "minimal-directory-agent",
    "--suite",
    options.suite ?? "smoke",
    "--runner",
    "simulated",
    "--out",
    out
  ];
  if (options.mutation) {
    args.push("--mutation", options.mutation);
  }
  await execa("npm", args, { cwd });
}

async function comparePair(baseline: string, candidate: string, name: string): Promise<{ out: string; result: any; report: string }> {
  const out = path.join(root, `compare-${name}`);
  await execa(
    "npm",
    ["run", "benchmark", "--", "compare", "--baseline", baseline, "--candidate", candidate, "--out", out],
    { cwd }
  );
  return {
    out,
    result: JSON.parse(await readFile(path.join(out, "comparison-result.json"), "utf8")),
    report: await readFile(path.join(out, "comparison-report.md"), "utf8")
  };
}

async function expectValidComparison(value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(cwd, "schemas", "comparison-result.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

async function gateComparison(
  comparison: string,
  name: string
): Promise<{ exitCode: number | undefined; result: any; report: string }> {
  const out = path.join(root, `gate-${name}`);
  const execution = await execa(
    "npm",
    ["run", "benchmark", "--", "gate", "--comparison", comparison, "--out", out],
    { cwd, reject: false }
  );
  return {
    exitCode: execution.exitCode,
    result: JSON.parse(await readFile(path.join(out, "gate-result.json"), "utf8")),
    report: await readFile(path.join(out, "gate-report.md"), "utf8")
  };
}

async function forgeLiveWorkflowTraceRun(
  source: string,
  destination: string,
  options: { rewriteRuntime?: boolean } = {}
): Promise<void> {
  await cp(source, destination, { recursive: true });
  const suitePath = path.join(destination, "suite-result.json");
  const provenancePath = path.join(destination, "provenance.json");
  const runtimePath = path.join(destination, "runtime-manifest.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));

  suite.releaseDecision = "APPROVE";
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);

  provenance.conditions.runner = {
    name: "codex",
    adapterVersion: "forged-adapter",
    version: "forged-version",
    capabilitiesHash: sha256Text("forged-live-runner")
  };
  provenance.conditions.executionMode = "live";
  provenance.conditions.evidenceKind = "live";
  provenance.conditions.observationLevel = "workflow_trace";
  provenance.conditions.isolation = "read_only_sandbox";
  provenance.conditions.permissionMode = "read_only_no_approval";
  const { conditionsHash: _conditionsHash, ...conditionBase } = provenance.conditions;
  provenance.conditions.conditionsHash = sha256Text(stableJson(conditionBase));
  const suiteArtifact = provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "suite-result.json"
  );
  suiteArtifact.sha256 = await hashFile(suitePath);
  if (options.rewriteRuntime) {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.runner = {
      ...runtime.runner,
      name: provenance.conditions.runner.name,
      supported: true,
      adapterVersion: provenance.conditions.runner.adapterVersion,
      version: provenance.conditions.runner.version,
      capabilitiesHash: provenance.conditions.runner.capabilitiesHash,
      executionMode: "live"
    };
    runtime.liveTranscriptCount = runtime.caseCount;
    await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    const runtimeArtifact = provenance.integrity.artifacts.find(
      (artifact: { ref: string }) => artifact.ref === "runtime-manifest.json"
    );
    runtimeArtifact.sha256 = await hashFile(runtimePath);
  }
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function injectUnregisteredSuiteFailure(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true });
  const suitePath = path.join(destination, "suite-result.json");
  const provenancePath = path.join(destination, "provenance.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));

  suite.caseResults[0].hardFailures = [
    {
      code: "TARGET_PRIVATE_FAILURE",
      severity: "P1",
      why: "private target implementation detail",
      evidenceEventIds: ["private-event"]
    }
  ];
  suite.caseResults[0].verdict = "FAIL";
  suite.releaseDecision = "BLOCK";
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);

  provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "suite-result.json"
  ).sha256 = await hashFile(suitePath);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function expectValidGate(value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(cwd, "schemas", "gate-result.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

describe("paired workflow comparison", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-compare-"));
    cleanBaseline = path.join(root, "clean-baseline");
    cleanCandidate = path.join(root, "clean-candidate");
    hardBaseline = path.join(root, "hard-baseline");
    hardCandidate = path.join(root, "hard-candidate");
    regressedCandidate = path.join(root, "regressed-candidate");
    mismatchedCandidate = path.join(root, "mismatched-candidate");
    await runFixture(cleanBaseline);
    await runFixture(cleanCandidate);
    await runFixture(hardBaseline, { mutation: "fixtures/mutations/route-break.yaml" });
    await runFixture(hardCandidate, { mutation: "fixtures/mutations/route-break.yaml" });
    await runFixture(regressedCandidate, { mutation: "fixtures/mutations/telemetry-drop.yaml" });
    await runFixture(mismatchedCandidate, { suite: "different-suite" });
  }, 30_000);

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies a matched pair with identical evidence as unchanged", async () => {
    const { out, result, report } = await comparePair(cleanBaseline, cleanCandidate, "unchanged");

    await expectValidComparison(result);
    expect(result.comparability).toMatchObject({ status: "COMPARABLE", reasons: [] });
    expect(result.classification).toBe("UNCHANGED");
    expect(result.summary).toMatchObject({
      improved: 0,
      regressed: 0,
      unchanged: expect.any(Number),
      hardFailure: 0,
      incomparable: 0
    });
    expect(report).toContain("# Agent Workflow Bench Comparison");
    expect(report).toContain("Classification: UNCHANGED");
    expect(result.integrity).toMatchObject({
      status: "VERIFIED_AT_WRITE",
      baselineRef: "evidence/baseline",
      candidateRef: "evidence/candidate",
      comparisonHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    await expect(readFile(path.join(out, result.integrity.baselineRef, "suite-result.json"), "utf8")).resolves.toContain(
      "\"targetId\""
    );
    expect(JSON.stringify(result)).not.toContain(root);
    expect(report).not.toContain(root);
  });

  test("classifies removal of baseline hard failures as improved", async () => {
    const { result } = await comparePair(hardBaseline, cleanCandidate, "improved");

    expect(result.classification).toBe("IMPROVED");
    expect(result.summary.improved).toBeGreaterThan(0);
    expect(result.caseDeltas.some((delta: { resolvedHardFailures: string[] }) => delta.resolvedHardFailures.includes("TARGET_ROUTE_FORBIDDEN"))).toBe(true);
  });

  test("classifies lower deterministic telemetry evidence as regressed", async () => {
    const { result } = await comparePair(cleanBaseline, regressedCandidate, "regressed");

    expect(result.classification).toBe("REGRESSED");
    expect(result.scoreDelta).toBeLessThan(0);
    expect(result.summary.regressed).toBeGreaterThan(0);
  });

  test("candidate hard failures dominate aggregate scores", async () => {
    const { result } = await comparePair(cleanBaseline, hardCandidate, "hard-failure");

    expect(result.classification).toBe("HARD_FAILURE");
    expect(result.summary.hardFailure).toBeGreaterThan(0);
    expect(result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TARGET_ROUTE_FORBIDDEN",
          source: "candidate"
        })
      ])
    );
  });

  test("comparison canonicalizes unregistered suite hard failures without leaking private labels", async () => {
    const candidate = path.join(root, "unregistered-hard-failure-candidate");
    await injectUnregisteredSuiteFailure(cleanCandidate, candidate);

    const comparison = await comparePair(
      cleanBaseline,
      candidate,
      "unregistered-hard-failure"
    );
    expect(comparison.result.classification).toBe("HARD_FAILURE");
    expect(comparison.result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNREGISTERED_HARD_FAILURE",
          severity: "P0",
          source: "candidate"
        })
      ])
    );
    expect(comparison.result.caseDeltas[0].newHardFailures).toContain(
      "UNREGISTERED_HARD_FAILURE"
    );
    expect(JSON.stringify(comparison.result)).not.toContain("TARGET_PRIVATE_FAILURE");
    expect(JSON.stringify(comparison.result)).not.toContain(
      "private target implementation detail"
    );
    expect(comparison.report).not.toContain("TARGET_PRIVATE_FAILURE");
    expect(comparison.report).not.toContain("private target implementation detail");

    const gate = await gateComparison(
      path.join(comparison.out, "comparison-result.json"),
      "unregistered-hard-failure"
    );
    expect(gate.exitCode).toBe(1);
    expect(gate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE"
    });
    expect(gate.report).not.toContain("TARGET_PRIVATE_FAILURE");
    expect(gate.report).not.toContain("private target implementation detail");
  });

  test("mismatched paired conditions are incomparable instead of silently ranked", async () => {
    const { result } = await comparePair(cleanBaseline, mismatchedCandidate, "incomparable");

    expect(result.classification).toBe("INCOMPARABLE");
    expect(result.comparability.status).toBe("INCOMPARABLE");
    expect(result.comparability.reasons).toEqual(expect.arrayContaining(["SUITE_MISMATCH", "CASE_SET_MISMATCH"]));
  });

  test("missing provenance is incomparable while tampered evidence is a hard failure", async () => {
    const missing = path.join(root, "missing-provenance");
    const tampered = path.join(root, "tampered-provenance");
    const tamperedRuntime = path.join(root, "tampered-runtime");
    await cp(cleanCandidate, missing, { recursive: true });
    await cp(cleanCandidate, tampered, { recursive: true });
    await cp(cleanCandidate, tamperedRuntime, { recursive: true });
    await unlink(path.join(missing, "provenance.json"));

    const missingComparison = await comparePair(cleanBaseline, missing, "missing-provenance");
    expect(missingComparison.result.classification).toBe("INCOMPARABLE");
    expect(missingComparison.result.comparability.reasons).toContain("PROVENANCE_MISSING");

    const suitePath = path.join(tampered, "suite-result.json");
    const suite = JSON.parse(await readFile(suitePath, "utf8"));
    suite.cappedSuiteScore += 1;
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
    const tamperedComparison = await comparePair(cleanBaseline, tampered, "tampered-provenance");
    expect(tamperedComparison.result.classification).toBe("HARD_FAILURE");
    expect(tamperedComparison.result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PROVENANCE_INVALID",
          source: "candidate"
        })
      ])
    );

    const runtimePath = path.join(tamperedRuntime, "runtime-manifest.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.mode = "tampered";
    await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    const runtimeComparison = await comparePair(cleanBaseline, tamperedRuntime, "tampered-runtime");
    expect(runtimeComparison.result.classification).toBe("HARD_FAILURE");
    expect(runtimeComparison.result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PROVENANCE_INVALID",
          source: "candidate"
        })
      ])
    );
  });

  test("runtime manifest prevents rehashed simulated provenance from impersonating live workflow traces", async () => {
    const forgedBaseline = path.join(root, "forged-live-baseline");
    const forgedCandidate = path.join(root, "forged-live-candidate");
    await forgeLiveWorkflowTraceRun(cleanBaseline, forgedBaseline);
    await forgeLiveWorkflowTraceRun(cleanCandidate, forgedCandidate);

    const comparison = await comparePair(forgedBaseline, forgedCandidate, "forged-live-runtime-mismatch");
    expect(comparison.result.classification).toBe("HARD_FAILURE");
    expect(comparison.result.comparability.reasons).toContain("PROVENANCE_INVALID");
    expect(comparison.result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVENANCE_INVALID", source: "baseline" }),
        expect.objectContaining({ code: "PROVENANCE_INVALID", source: "candidate" })
      ])
    );

    const gate = await gateComparison(
      path.join(comparison.out, "comparison-result.json"),
      "forged-live-runtime-mismatch"
    );
    expect(gate.exitCode).toBe(1);
    expect(gate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE"
    });
  });

  test("current runner adapters reject invented workflow-trace evidence even when all editable hashes are recomputed", async () => {
    const forgedBaseline = path.join(root, "fully-forged-live-baseline");
    const forgedCandidate = path.join(root, "fully-forged-live-candidate");
    await forgeLiveWorkflowTraceRun(cleanBaseline, forgedBaseline, { rewriteRuntime: true });
    await forgeLiveWorkflowTraceRun(cleanCandidate, forgedCandidate, { rewriteRuntime: true });

    const comparison = await comparePair(forgedBaseline, forgedCandidate, "fully-forged-live");
    expect(comparison.result.classification).toBe("HARD_FAILURE");
    expect(comparison.result.comparability.reasons).toContain("PROVENANCE_INVALID");
    expect(comparison.result.hardFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVENANCE_INVALID", source: "baseline" }),
        expect.objectContaining({ code: "PROVENANCE_INVALID", source: "candidate" })
      ])
    );
  });

  test("gate keeps clean simulated comparisons diagnostic-only with exit code 2", async () => {
    const comparison = await comparePair(cleanBaseline, cleanCandidate, "gate-simulated");
    const gate = await gateComparison(path.join(comparison.out, "comparison-result.json"), "simulated");

    await expectValidGate(gate.result);
    expect(gate.exitCode).toBe(2);
    expect(gate.result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-EVIDENCE-NOT-WORKFLOW-TRACE"
    });
    expect(gate.report).toContain("# Agent Workflow Bench Gate");
    expect(gate.report).toContain("Decision: DIAGNOSTIC_ONLY");
  });

  test("gate blocks deterministic regressions and candidate hard failures with exit code 1", async () => {
    const regression = await comparePair(cleanBaseline, regressedCandidate, "gate-regression");
    const regressionGate = await gateComparison(path.join(regression.out, "comparison-result.json"), "regression");
    expect(regressionGate.exitCode).toBe(1);
    expect(regressionGate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-REGRESSION"
    });

    const hardFailure = await comparePair(cleanBaseline, hardCandidate, "gate-hard-failure");
    const hardFailureGate = await gateComparison(path.join(hardFailure.out, "comparison-result.json"), "hard-failure");
    expect(hardFailureGate.exitCode).toBe(1);
    expect(hardFailureGate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE"
    });
  });

  test("gate blocks a comparison file that is edited to impersonate live workflow-trace evidence", async () => {
    const comparison = await comparePair(cleanBaseline, cleanCandidate, "gate-live-seed");
    const comparisonPath = path.join(comparison.out, "comparison-result.json");
    const live = JSON.parse(await readFile(comparisonPath, "utf8"));
    live.baseline.releaseDecision = "APPROVE";
    live.candidate.releaseDecision = "APPROVE";
    live.baseline.evidenceKind = "live";
    live.candidate.evidenceKind = "live";
    live.baseline.observationLevel = "workflow_trace";
    live.candidate.observationLevel = "workflow_trace";
    await writeFile(comparisonPath, `${JSON.stringify(live, null, 2)}\n`);

    const gate = await gateComparison(comparisonPath, "live-workflow-trace");
    expect(gate.exitCode).toBe(1);
    expect(gate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-COMPARISON-INTEGRITY"
    });
  });

  test("gate blocks bundled evidence that changes after comparison", async () => {
    const comparison = await comparePair(cleanBaseline, cleanCandidate, "gate-evidence-tamper");
    const runtimePath = path.join(comparison.out, comparison.result.integrity.candidateRef, "runtime-manifest.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.mode = "tampered-after-compare";
    await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

    const gate = await gateComparison(path.join(comparison.out, "comparison-result.json"), "evidence-tamper");
    expect(gate.exitCode).toBe(1);
    expect(gate.result).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-COMPARISON-INTEGRITY",
      comparisonIntegrity: "INVALID"
    });
  });

  test("gate policy passes only an integrity-verified, observer-qualified live workflow-trace comparison", async () => {
    const comparison = await comparePair(cleanBaseline, cleanCandidate, "gate-live-policy");
    const live = structuredClone(comparison.result);
    live.baseline.releaseDecision = "APPROVE";
    live.candidate.releaseDecision = "APPROVE";
    live.baseline.evidenceKind = "live";
    live.candidate.evidenceKind = "live";
    live.baseline.observationLevel = "workflow_trace";
    live.candidate.observationLevel = "workflow_trace";
    live.baseline.observerQualificationStatus = "valid";
    live.candidate.observerQualificationStatus = "valid";

    const gate = evaluateGate(live, { status: "VALID", reasons: [] });
    expect(gate).toMatchObject({
      decision: "PASS",
      ruleId: "GATE-PASS",
      comparisonIntegrity: "VALID"
    });
  });

  test("live contract-summary evidence remains diagnostic-only", async () => {
    const comparison = await comparePair(cleanBaseline, cleanCandidate, "gate-contract-seed");
    const contractOnly = structuredClone(comparison.result);
    contractOnly.baseline.releaseDecision = "APPROVE";
    contractOnly.candidate.releaseDecision = "APPROVE";
    contractOnly.baseline.evidenceKind = "live";
    contractOnly.candidate.evidenceKind = "live";
    contractOnly.baseline.observationLevel = "contract_summary";
    contractOnly.candidate.observationLevel = "contract_summary";

    const gate = evaluateGate(contractOnly, { status: "VALID", reasons: [] });
    expect(gate).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-EVIDENCE-NOT-WORKFLOW-TRACE",
      comparisonIntegrity: "VALID"
    });
  });
});
