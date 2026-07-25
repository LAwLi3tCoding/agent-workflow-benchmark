import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import type { BenchmarkCase, RunEvent } from "../src/core/types.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

const cwd = process.cwd();
let root = "";
let publicKeyPath = "";
let wrongPublicKeyPath = "";
let baselineTracePath = "";
let candidateTracePath = "";

describe("attested workflow trace ingestion", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-workflow-trace-"));
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const trustedKeys = generateKeyPairSync("ed25519");
    const wrongKeys = generateKeyPairSync("ed25519");
    publicKeyPath = path.join(root, "observer-public.pem");
    wrongPublicKeyPath = path.join(root, "wrong-observer-public.pem");
    await writeFile(publicKeyPath, trustedKeys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(wrongPublicKeyPath, wrongKeys.publicKey.export({ type: "spki", format: "pem" }));
    baselineTracePath = path.join(root, "baseline-trace.json");
    candidateTracePath = path.join(root, "candidate-trace.json");
    await writeSignedTrace(
      baselineTracePath,
      makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "baseline"),
      trustedKeys.privateKey,
      trustedKeys.publicKey
    );
    await writeSignedTrace(
      candidateTracePath,
      makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "candidate"),
      trustedKeys.privateKey,
      trustedKeys.publicKey
    );
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("admits a signed external observer trace and produces a real paired PASS", async () => {
    const baselineOut = path.join(root, "baseline-run");
    const candidateOut = path.join(root, "candidate-run");
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut);

    const baselineProvenance = JSON.parse(await readFile(path.join(baselineOut, "provenance.json"), "utf8"));
    const runtime = JSON.parse(await readFile(path.join(baselineOut, "runtime-manifest.json"), "utf8"));
    expect(baselineProvenance.conditions).toMatchObject({
      evidenceKind: "live",
      observationLevel: "workflow_trace"
    });
    expect(baselineProvenance.conditions.observer).toMatchObject({
      id: "fixture-observer",
      version: "1.0.0",
      keyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(runtime.workflowTrace).toMatchObject({
      verified: true,
      ref: "workflow-trace.json",
      caseCount: 10
    });

    const comparisonOut = path.join(root, "comparison");
    await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "compare",
        "--baseline",
        baselineOut,
        "--candidate",
        candidateOut,
        "--trusted-observer-key",
        publicKeyPath,
        "--out",
        comparisonOut
      ],
      { cwd }
    );
    const comparison = JSON.parse(await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8"));
    expect(comparison.classification).toBe("UNCHANGED");
    expect(comparison.comparability).toMatchObject({ status: "COMPARABLE", reasons: [] });

    const gateOut = path.join(root, "gate");
    const gate = await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "gate",
        "--comparison",
        path.join(comparisonOut, "comparison-result.json"),
        "--trusted-observer-key",
        publicKeyPath,
        "--out",
        gateOut
      ],
      { cwd, reject: false }
    );
    expect(gate.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"))).toMatchObject({
      decision: "PASS",
      ruleId: "GATE-PASS",
      comparisonIntegrity: "VALID"
    });
  }, 30_000);

  test("rejects a trace whose signed payload was modified", async () => {
    const tamperedTracePath = path.join(root, "tampered-trace.json");
    const trace = JSON.parse(await readFile(baselineTracePath, "utf8"));
    trace.cases[0].events.find((event: RunEvent) => event.type === "contract_observed").payload.contractHash = "sha256:tampered";
    await writeFile(tamperedTracePath, `${JSON.stringify(trace, null, 2)}\n`);

    const result = await ingestTrace(tamperedTracePath, publicKeyPath, path.join(root, "tampered-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("signature");
  });

  test("rejects a valid signature when the configured trust anchor is different", async () => {
    const result = await ingestTrace(baselineTracePath, wrongPublicKeyPath, path.join(root, "wrong-key-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("keyFingerprint");
  });

  test("rejects a private signing key passed as the public trust anchor", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const keys = generateKeyPairSync("ed25519");
    const tracePath = path.join(root, "private-key-trace.json");
    const privateKeyPath = path.join(root, "observer-private.pem");
    await writeFile(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeSignedTrace(
      tracePath,
      makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "private-key"),
      keys.privateKey,
      keys.publicKey
    );

    const result = await ingestTrace(tracePath, privateKeyPath, path.join(root, "private-key-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("public key");
  });

  test("rejects an attested trace that omits a materialized case", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const keys = generateKeyPairSync("ed25519");
    const incompleteTracePath = path.join(root, "incomplete-trace.json");
    const incompleteKeyPath = path.join(root, "incomplete-public.pem");
    await writeFile(incompleteKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    const payload = makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases.slice(0, -1), "incomplete");
    await writeSignedTrace(incompleteTracePath, payload, keys.privateKey, keys.publicKey);

    const result = await ingestTrace(incompleteTracePath, incompleteKeyPath, path.join(root, "incomplete-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("case set");
  });

  test("rejects an attested side-effect case without observable deny evidence", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const keys = generateKeyPairSync("ed25519");
    const tracePath = path.join(root, "missing-side-effect-ledger.json");
    const keyPath = path.join(root, "missing-side-effect-ledger.pem");
    await writeFile(keyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    const payload = makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "missing-ledger");
    const sideEffectCase = payload.cases.find((item) => item.caseId.endsWith("side-effect-deny"))!;
    sideEffectCase.events = sideEffectCase.events.filter((event) => event.type !== "side_effect_attempt");
    await writeSignedTrace(tracePath, payload, keys.privateKey, keys.publicKey);

    const result = await ingestTrace(tracePath, keyPath, path.join(root, "missing-side-effect-ledger-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("side_effect_attempt");
  });

  test("rejects signed trace evidence that was not redacted before attestation", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const keys = generateKeyPairSync("ed25519");
    const tracePath = path.join(root, "sensitive-trace.json");
    const keyPath = path.join(root, "sensitive-trace.pem");
    await writeFile(keyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    const payload = makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "sensitive");
    payload.cases[0]!.events.push({
      eventId: "sensitive-path-event",
      timestamp: new Date(50_000).toISOString(),
      type: "runner_transcript",
      actor: "observer",
      payload: { path: "/opt/private-workflow/secret.txt" }
    });
    await writeSignedTrace(tracePath, payload, keys.privateKey, keys.publicKey);

    const result = await ingestTrace(tracePath, keyPath, path.join(root, "sensitive-trace-run"), false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("pre-redacted");
  });

  test("does not trust workflow-trace provenance during compare without the external public key", async () => {
    const baselineOut = path.join(root, "baseline-no-key");
    const candidateOut = path.join(root, "candidate-no-key");
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut);

    const comparisonOut = path.join(root, "comparison-no-key");
    await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "compare",
        "--baseline",
        baselineOut,
        "--candidate",
        candidateOut,
        "--out",
        comparisonOut
      ],
      { cwd }
    );
    const comparison = JSON.parse(await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8"));
    expect(comparison.classification).toBe("HARD_FAILURE");
    expect(comparison.comparability.reasons).toContain("PROVENANCE_INVALID");
  }, 30_000);

  test("recomputed editable hashes cannot rescue a tampered observer signature", async () => {
    const baselineOut = path.join(root, "baseline-rehashed");
    const candidateOut = path.join(root, "candidate-rehashed");
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut);

    const traceArtifactPath = path.join(candidateOut, "workflow-trace.json");
    const runtimePath = path.join(candidateOut, "runtime-manifest.json");
    const provenancePath = path.join(candidateOut, "provenance.json");
    const trace = JSON.parse(await readFile(traceArtifactPath, "utf8"));
    trace.cases[0].events[0].actor = "tampered-observer";
    await writeFile(traceArtifactPath, `${JSON.stringify(trace, null, 2)}\n`);

    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.workflowTrace.sha256 = await sha256File(traceArtifactPath);
    await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.integrity.artifacts.find(
      (artifact: { ref: string }) => artifact.ref === "workflow-trace.json"
    ).sha256 = await sha256File(traceArtifactPath);
    provenance.integrity.artifacts.find(
      (artifact: { ref: string }) => artifact.ref === "runtime-manifest.json"
    ).sha256 = await sha256File(runtimePath);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

    const comparisonOut = path.join(root, "comparison-rehashed");
    await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "compare",
        "--baseline",
        baselineOut,
        "--candidate",
        candidateOut,
        "--trusted-observer-key",
        publicKeyPath,
        "--out",
        comparisonOut
      ],
      { cwd }
    );
    const comparison = JSON.parse(await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8"));
    expect(comparison.classification).toBe("HARD_FAILURE");
    expect(comparison.comparability.reasons).toContain("PROVENANCE_INVALID");
    expect(comparison.hardFailures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PROVENANCE_INVALID", source: "candidate" })])
    );
  }, 30_000);
});

async function ingestTrace(tracePath: string, keyPath: string, out: string, reject = true) {
  return execa(
    "node",
    [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "ingest-trace",
      "--target",
      "minimal-directory-agent",
      "--suite",
      "smoke",
      "--trace",
      tracePath,
      "--trusted-observer-key",
      keyPath,
      "--out",
      out
    ],
    { cwd, reject }
  );
}

function makeTracePayload(targetId: string, contractHash: string, cases: BenchmarkCase[], runLabel: string) {
  const runner = {
    name: "codex",
    adapterVersion: "observer-fixture-adapter-1",
    version: "fixture-codex",
    capabilitiesHash: `sha256:${"1".repeat(64)}`
  };
  return {
    schemaVersion: "0.1.0",
    observer: {
      id: "fixture-observer",
      version: "1.0.0",
      keyFingerprint: ""
    },
    subject: {
      targetId,
      contractHash,
      suite: "smoke",
      caseSetHash: semanticCaseSetHash(cases),
      runner,
      isolation: "read_only_sandbox",
      permissionMode: "read_only_no_approval",
      model: "fixture-model"
    },
    cases: cases.map((testCase, index) => makeObservedCase(testCase, runLabel, index)),
    attestation: {
      algorithm: "ed25519",
      signature: ""
    }
  };
}

function makeObservedCase(testCase: BenchmarkCase, runLabel: string, index: number) {
  const events: RunEvent[] = [];
  let sequence = 0;
  const push = (type: RunEvent["type"], actor: string, payload: Record<string, unknown>) => {
    sequence += 1;
    events.push({
      eventId: `${runLabel}-${index}-${sequence}`,
      timestamp: new Date(1_000 + sequence * 1_000).toISOString(),
      type,
      actor,
      payload
    });
  };
  push("case_start", "observer", { caseId: testCase.id, templateId: testCase.templateId });
  push("contract_observed", "observer", { contractHash: testCase.contractHash });
  push("runner_start", "observer", { runner: "codex", executionMode: "live" });
  push("handoff", testCase.bindings.primaryRole, { to: testCase.bindings.owner, status: "accepted" });
  push("artifact_write", testCase.bindings.owner, { path: testCase.bindings.artifactPath, bytes: 128 });
  push("state_read", testCase.bindings.owner, { path: "process/workflow-state.json" });
  push("gate_decision", testCase.bindings.owner, { status: "PASS" });
  if (testCase.templateId === "side-effect-deny") {
    push("side_effect_attempt", "observer", {
      command: "fixture-production-write",
      policyDecision: "deny",
      allowed: false,
      classifiedAs: "production_write"
    });
  }
  push("runner_result", "observer", { verdict: "PASS", hardFailureCodes: [] });
  push("runner_exit", "observer", { exitCode: 0, timedOut: false });
  push("token_usage", "observer", { input: 500, output: 100, total: 600, wasted: 20, source: "native" });
  push("case_end", "observer", { status: "completed" });
  return {
    caseId: testCase.id,
    templateId: testCase.templateId,
    runId: `observed-${runLabel}-${testCase.id}`,
    events,
    wallClockSeconds: 12,
    tokens: {
      input: 500,
      output: 100,
      total: 600,
      wasted: 20,
      costEstimateConfidence: "high"
    },
    telemetryCompleteness: 0.96
  };
}

async function writeSignedTrace(
  filePath: string,
  input: ReturnType<typeof makeTracePayload>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]
): Promise<void> {
  const keyFingerprint = publicKeyFingerprint(publicKey.export({ type: "spki", format: "der" }));
  const payload = {
    ...input,
    observer: {
      ...input.observer,
      keyFingerprint
    }
  };
  const { attestation: _attestation, ...unsigned } = payload;
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...unsigned,
        attestation: {
          algorithm: "ed25519",
          signature
        }
      },
      null,
      2
    )}\n`
  );
}

function publicKeyFingerprint(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

async function sha256File(filePath: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
}

function semanticCaseSetHash(cases: BenchmarkCase[]): string {
  const semanticCases = [...cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((testCase) => ({
      id: testCase.id,
      targetId: testCase.targetId,
      suite: testCase.suite,
      templateId: testCase.templateId,
      title: testCase.title,
      oracleIds: testCase.oracleIds,
      expectedHardFailures: testCase.expectedHardFailures,
      prompt: testCase.prompt,
      bindings: testCase.bindings,
      budgets: testCase.budgets
    }));
  return `sha256:${createHash("sha256").update(canonicalJson(semanticCases)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
