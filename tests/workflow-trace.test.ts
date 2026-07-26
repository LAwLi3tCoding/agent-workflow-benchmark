import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import type { BenchmarkCase, RunEvent } from "../src/core/types.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  buildReferenceObserverIsolationManifest,
  referenceObserverImplementationHash
} from "../src/observer/referenceObserver.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

const cwd = process.cwd();
let root = "";
let publicKeyPath = "";
let wrongPublicKeyPath = "";
let baselineTracePath = "";
let candidateTracePath = "";
let qualificationArtifactPath = "";
let qualificationAuthorityPublicKeyPath = "";
let observerPrivateKeyPath = "";
let qualificationAuthorityPrivateKeyPath = "";

describe("attested workflow trace ingestion", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-workflow-trace-"));
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const trustedKeys = generateKeyPairSync("ed25519");
    const wrongKeys = generateKeyPairSync("ed25519");
    const qualificationAuthorityKeys = generateKeyPairSync("ed25519");
    publicKeyPath = path.join(root, "observer-public.pem");
    wrongPublicKeyPath = path.join(root, "wrong-observer-public.pem");
    observerPrivateKeyPath = path.join(root, "observer-private.pem");
    qualificationAuthorityPrivateKeyPath = path.join(
      root,
      "qualification-authority-private.pem"
    );
    qualificationAuthorityPublicKeyPath = path.join(
      root,
      "qualification-authority-public.pem"
    );
    await writeFile(publicKeyPath, trustedKeys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(wrongPublicKeyPath, wrongKeys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(
      observerPrivateKeyPath,
      trustedKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );
    await writeFile(
      qualificationAuthorityPrivateKeyPath,
      qualificationAuthorityKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );
    await writeFile(
      qualificationAuthorityPublicKeyPath,
      qualificationAuthorityKeys.publicKey.export({ type: "spki", format: "pem" })
    );
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
    const qualificationDir = path.join(root, "qualification");
    await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "observer",
        "qualify",
        "--target",
        "minimal-directory-agent",
        "--suite",
        "smoke",
        "--observer-id",
        "fixture-observer",
        "--observer-version",
        "1.0.0",
        "--observer-private-key",
        observerPrivateKeyPath,
        "--qualification-authority-private-key",
        qualificationAuthorityPrivateKeyPath,
        "--out",
        qualificationDir
      ],
      { cwd }
    );
    qualificationArtifactPath = path.join(
      qualificationDir,
      "observer-qualification.json"
    );
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a signed but unqualified external observer trace diagnostic-only", async () => {
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
      keyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      qualificationStatus: "missing"
    });
    expect(
      JSON.parse(await readFile(path.join(baselineOut, "suite-result.json"), "utf8"))
        .releaseDecision
    ).toBe("DIAGNOSTIC_ONLY");
    expect(runtime.workflowTrace).toMatchObject({
      verified: true,
      ref: "workflow-trace.json",
      caseCount: 22
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
    expect(gate.exitCode).toBe(2);
    expect(JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"))).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-OBSERVER-UNQUALIFIED",
      comparisonIntegrity: "VALID"
    });
  }, 30_000);

  test("admits an authority-qualified observer trace through ingest, compare, and gate", async () => {
    const baselineOut = path.join(root, "baseline-qualified");
    const candidateOut = path.join(root, "candidate-qualified");
    const qualification = {
      artifactPath: qualificationArtifactPath,
      authorityPublicKeyPath: qualificationAuthorityPublicKeyPath
    };
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut, true, qualification);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut, true, qualification);

    const baselineProvenance = JSON.parse(
      await readFile(path.join(baselineOut, "provenance.json"), "utf8")
    );
    const baselineRuntime = JSON.parse(
      await readFile(path.join(baselineOut, "runtime-manifest.json"), "utf8")
    );
    expect(baselineProvenance.conditions.observer).toMatchObject({
      qualificationStatus: "valid",
      qualificationRef: "observer-qualification.json",
      qualificationArtifactHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      qualificationAuthorityFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      isolationManifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(
      baselineRuntime.workflowTrace.observer.isolationManifestHash
    ).toBe(baselineProvenance.conditions.observer.isolationManifestHash);
    expect(
      JSON.parse(await readFile(path.join(baselineOut, "suite-result.json"), "utf8"))
        .releaseDecision
    ).toBe("APPROVE");

    const comparisonOut = path.join(root, "comparison-qualified");
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
        "--trusted-qualification-key",
        qualificationAuthorityPublicKeyPath,
        "--out",
        comparisonOut
      ],
      { cwd }
    );
    const comparison = JSON.parse(
      await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8")
    );
    expect(comparison.baseline.observerQualificationStatus).toBe("valid");
    expect(comparison.candidate.observerQualificationStatus).toBe("valid");

    const gateOut = path.join(root, "gate-qualified");
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
        "--trusted-qualification-key",
        qualificationAuthorityPublicKeyPath,
        "--out",
        gateOut
      ],
      { cwd, reject: false }
    );
    expect(gate.exitCode).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"))
    ).toMatchObject({
      decision: "PASS",
      ruleId: "GATE-PASS",
      comparisonIntegrity: "VALID"
    });

    const missingAuthorityGateOut = path.join(
      root,
      "gate-qualified-missing-authority"
    );
    const missingAuthorityGate = await execa(
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
        missingAuthorityGateOut
      ],
      { cwd, reject: false }
    );
    expect(missingAuthorityGate.exitCode).toBe(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(missingAuthorityGateOut, "gate-result.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-COMPARISON-INTEGRITY",
      comparisonIntegrity: "INVALID"
    });
  }, 60_000);

  test("rejects an old trace and qualification pair after the Observer implementation changes", async () => {
    const baselineOut = path.join(root, "baseline-stale-implementation");
    const candidateOut = path.join(root, "candidate-stale-implementation");
    const qualification = {
      artifactPath: qualificationArtifactPath,
      authorityPublicKeyPath: qualificationAuthorityPublicKeyPath
    };
    await ingestTrace(
      baselineTracePath,
      publicKeyPath,
      baselineOut,
      true,
      qualification
    );
    await ingestTrace(
      candidateTracePath,
      publicKeyPath,
      candidateOut,
      true,
      qualification
    );

    const staleImplementationHash = `sha256:${"d".repeat(64)}`;
    await replaceQualifiedRunWithStaleImplementation(
      baselineOut,
      staleImplementationHash
    );
    await replaceQualifiedRunWithStaleImplementation(
      candidateOut,
      staleImplementationHash
    );

    const directIngest = await ingestTrace(
      path.join(baselineOut, "workflow-trace.json"),
      publicKeyPath,
      path.join(root, "direct-stale-ingest"),
      false,
      {
        artifactPath: path.join(
          baselineOut,
          "observer-qualification.json"
        ),
        authorityPublicKeyPath: qualificationAuthorityPublicKeyPath
      }
    );
    expect(directIngest.exitCode).not.toBe(0);
    expect(`${directIngest.stdout}\n${directIngest.stderr}`).toMatch(
      /implementation.*stale|current implementation/iu
    );

    const comparisonOut = path.join(root, "comparison-stale-implementation");
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
        "--trusted-qualification-key",
        qualificationAuthorityPublicKeyPath,
        "--out",
        comparisonOut
      ],
      { cwd }
    );
    const comparison = JSON.parse(
      await readFile(
        path.join(comparisonOut, "comparison-result.json"),
        "utf8"
      )
    );
    expect(comparison.classification).toBe("HARD_FAILURE");
    expect(comparison.comparability.reasons).toContain("PROVENANCE_INVALID");

    const gateOut = path.join(root, "gate-stale-implementation");
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
        "--trusted-qualification-key",
        qualificationAuthorityPublicKeyPath,
        "--out",
        gateOut
      ],
      { cwd, reject: false }
    );
    expect(gate.exitCode).toBe(1);
    expect(
      JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"))
    ).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE",
      comparisonIntegrity: "VALID"
    });
  }, 60_000);

  test("rehashed run metadata cannot self-assert Observer qualification", async () => {
    const baselineOut = path.join(root, "baseline-self-qualified");
    const candidateOut = path.join(root, "candidate-self-qualified");
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut);
    await selfAssertObserverQualification(baselineOut);
    await selfAssertObserverQualification(candidateOut);

    const comparisonOut = path.join(root, "comparison-self-qualified");
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
    const comparison = JSON.parse(
      await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8")
    );
    expect(comparison.baseline.observerQualificationStatus).toBe("missing");
    expect(comparison.candidate.observerQualificationStatus).toBe("missing");

    const gateOut = path.join(root, "gate-self-qualified");
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
    expect(gate.exitCode).toBe(2);
    expect(
      JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"))
    ).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-OBSERVER-UNQUALIFIED",
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

  test("rejects Runner-forged capability evidence even when the Observer signs it", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const keys = generateKeyPairSync("ed25519");
    const keyPath = path.join(root, "forged-capability-public.pem");
    await writeFile(
      keyPath,
      keys.publicKey.export({ type: "spki", format: "pem" })
    );

    for (const eventType of [
      "artifact_write",
      "state_read",
      "side_effect_attempt"
    ] satisfies RunEvent["type"][]) {
      const tracePath = path.join(root, `forged-${eventType}.json`);
      const payload = makeTracePayload(
        profile.contract.targetId,
        profile.contract.contractHash,
        suite.cases,
        `forged-${eventType}`
      );
      const event = payload.cases
        .flatMap((item) => item.events)
        .find((item) => item.type === eventType)!;
      event.actor = "runner";
      await writeSignedTrace(
        tracePath,
        payload,
        keys.privateKey,
        keys.publicKey
      );

      const result = await ingestTrace(
        tracePath,
        keyPath,
        path.join(root, `forged-${eventType}-run`),
        false
      );
      expect(result.exitCode, eventType).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, eventType).toMatch(
        /runner-forged Observer evidence/iu
      );
    }
  }, 30_000);

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

  test("signed trace replay identity cannot be rewritten through unsigned manifests", async () => {
    const baselineOut = path.join(root, "baseline-attempt-binding");
    const candidateOut = path.join(root, "candidate-attempt-binding");
    await ingestTrace(baselineTracePath, publicKeyPath, baselineOut);
    await ingestTrace(candidateTracePath, publicKeyPath, candidateOut);

    const runtimePath = path.join(
      candidateOut,
      "runtime-manifest.json"
    );
    const provenancePath = path.join(candidateOut, "provenance.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    runtime.attemptId = "trace-rewritten-attempt";
    provenance.subject.attemptId = runtime.attemptId;
    await writeFile(
      runtimePath,
      `${JSON.stringify(runtime, null, 2)}\n`
    );
    provenance.integrity.artifacts.find(
      (artifact: { ref: string }) =>
        artifact.ref === "runtime-manifest.json"
    ).sha256 = await sha256File(runtimePath);
    await writeFile(
      provenancePath,
      `${JSON.stringify(provenance, null, 2)}\n`
    );

    const comparisonOut = path.join(root, "comparison-attempt-binding");
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
    const comparison = JSON.parse(
      await readFile(
        path.join(comparisonOut, "comparison-result.json"),
        "utf8"
      )
    );
    expect(comparison.classification).toBe("HARD_FAILURE");
    expect(comparison.comparability.reasons).toContain(
      "PROVENANCE_INVALID"
    );
  }, 30_000);
});

async function ingestTrace(
  tracePath: string,
  keyPath: string,
  out: string,
  reject = true,
  qualification?: { artifactPath: string; authorityPublicKeyPath: string }
) {
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
      ...(qualification
        ? [
            "--observer-qualification",
            qualification.artifactPath,
            "--trusted-qualification-key",
            qualification.authorityPublicKeyPath
          ]
        : []),
      "--out",
      out
    ],
    { cwd, reject }
  );
}

async function selfAssertObserverQualification(runDir: string): Promise<void> {
  const suitePath = path.join(runDir, "suite-result.json");
  const runtimePath = path.join(runDir, "runtime-manifest.json");
  const provenancePath = path.join(runDir, "provenance.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));

  suite.releaseDecision = "APPROVE";
  runtime.workflowTrace.observer.qualificationStatus = "valid";
  provenance.conditions.observer.qualificationStatus = "valid";
  const { conditionsHash: _conditionsHash, ...conditionBase } = provenance.conditions;
  provenance.conditions.conditionsHash = sha256Text(canonicalJson(conditionBase));

  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "suite-result.json"
  ).sha256 = await sha256File(suitePath);
  provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "runtime-manifest.json"
  ).sha256 = await sha256File(runtimePath);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function replaceQualifiedRunWithStaleImplementation(
  runDir: string,
  implementationHash: string
): Promise<void> {
  const tracePath = path.join(runDir, "workflow-trace.json");
  const qualificationPath = path.join(
    runDir,
    "observer-qualification.json"
  );
  const runtimePath = path.join(runDir, "runtime-manifest.json");
  const provenancePath = path.join(runDir, "provenance.json");

  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  trace.observer.implementationHash = implementationHash;
  const { attestation: _traceAttestation, ...traceUnsigned } = trace;
  const observerPrivateKey = createPrivateKey(
    await readFile(observerPrivateKeyPath)
  );
  trace.attestation = {
    algorithm: "ed25519",
    signature: sign(
      null,
      Buffer.from(canonicalJson(traceUnsigned)),
      observerPrivateKey
    ).toString("base64")
  };
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`);

  const qualification = JSON.parse(
    await readFile(qualificationPath, "utf8")
  );
  qualification.observer.implementationHash = implementationHash;
  qualification.qualificationId = sha256Text(
    canonicalJson({
      observer: qualification.observer,
      subject: qualification.subject,
      results: qualification.results,
      checks: qualification.checks
    })
  );
  const {
    attestation: _qualificationAttestation,
    integrity: _qualificationIntegrity,
    ...qualificationContent
  } = qualification;
  const qualificationIntegrity = {
    status: "VERIFIED_AT_WRITE",
    contentHash: sha256Text(canonicalJson(qualificationContent))
  };
  const signedQualification = {
    ...qualificationContent,
    integrity: qualificationIntegrity
  };
  const qualificationPrivateKey = createPrivateKey(
    await readFile(qualificationAuthorityPrivateKeyPath)
  );
  const qualificationPublicKey = createPublicKey(qualificationPrivateKey);
  qualification.attestation = {
    algorithm: "ed25519",
    authorityFingerprint: publicKeyFingerprint(
      qualificationPublicKey.export({ type: "spki", format: "der" })
    ),
    signature: sign(
      null,
      Buffer.from(canonicalJson(signedQualification)),
      qualificationPrivateKey
    ).toString("base64")
  };
  qualification.integrity = qualificationIntegrity;
  await writeFile(
    qualificationPath,
    `${JSON.stringify(qualification, null, 2)}\n`
  );

  const traceHash = await sha256File(tracePath);
  const qualificationHash = await sha256File(qualificationPath);
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  runtime.workflowTrace.sha256 = traceHash;
  runtime.workflowTrace.observer.qualificationArtifactHash =
    qualificationHash;
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.conditions.observer.qualificationArtifactHash =
    qualificationHash;
  const { conditionsHash: _conditionsHash, ...conditionBase } =
    provenance.conditions;
  provenance.conditions.conditionsHash = sha256Text(
    canonicalJson(conditionBase)
  );
  for (const artifact of provenance.integrity.artifacts as Array<{
    ref: string;
    sha256: string;
  }>) {
    if (artifact.ref === "workflow-trace.json") {
      artifact.sha256 = traceHash;
    } else if (artifact.ref === "observer-qualification.json") {
      artifact.sha256 = qualificationHash;
    } else if (artifact.ref === "runtime-manifest.json") {
      artifact.sha256 = await sha256File(runtimePath);
    }
  }
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
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
      keyFingerprint: "",
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES
    },
    subject: {
      targetId,
      contractHash,
      suite: "smoke",
      seed: "workflow-trace-test",
      caseSetHash: semanticCaseSetHash(cases),
      runner,
      isolation: "read_only_sandbox",
      isolationManifest: fixtureMacosIsolationManifest(),
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

function fixtureMacosIsolationManifest() {
  return buildReferenceObserverIsolationManifest({
    backend: "macos-seatbelt",
    platform: "darwin",
    runtimeVersion: "sandbox-exec",
    policyHash: `sha256:${"2".repeat(64)}`,
    mountManifestHash: `sha256:${"3".repeat(64)}`,
    networkMode: "none",
    processPolicy: "seatbelt_process_exec_allowlist",
    capabilities: { drop: ["ALL"], add: [] },
    noNewPrivileges: true,
    readOnlyRootfs: false,
    writableMounts: ["workspace://root"],
    canaries: {
      signingKeyRead: "EPERM",
      networkDenied: "EPERM",
      nestedProcessDenied: "EPERM",
      outOfScopeWriteDenied: "EPERM"
    }
  });
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
  push("filesystem_access", "observer", {
    operation: "snapshot",
    root: "workspace://root",
    observedBy: "reference_observer"
  });
  push("network_access", "observer", {
    attempted: true,
    allowed: false,
    outcomeCode: "EPERM",
    policyDecision: "deny",
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("runner_start", "observer", { runner: "codex", executionMode: "live" });
  push("process_spawn", "observer", {
    executable: "fixture-codex",
    policyDecision: "allow",
    observedBy: "reference_observer"
  });
  push("tool_call", "observer", {
    tool: "observer-boundary-canary",
    attempted: true,
    allowed: false,
    outcomeCode: "EPERM",
    policyDecision: "deny",
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("handoff", testCase.bindings.primaryRole, { to: testCase.bindings.owner, status: "accepted" });
  push("artifact_write", "observer", {
    path: testCase.bindings.artifactPath,
    bytes: 128,
    observedBy: "reference_observer"
  });
  push("state_read", "observer", {
    path: "process/workflow-state.json",
    observedBy: "reference_observer"
  });
  push("gate_decision", testCase.bindings.owner, { status: "PASS" });
  push("side_effect_attempt", "observer", {
    attempted: false,
    policyDecision: "deny",
    allowed: false,
    classifiedAs: "none",
    observedBy: "reference_observer"
  });
  if (testCase.templateId === "side-effect-deny") {
    push("side_effect_attempt", "observer", {
      command: "fixture-production-write",
      policyDecision: "deny",
      allowed: false,
      classifiedAs: "production_write",
      observedBy: "reference_observer"
    });
  }
  push("runner_result", "observer", { verdict: "PASS", hardFailureCodes: [] });
  push("runner_exit", "observer", { exitCode: 0, timedOut: false });
  push("token_usage", "observer", {
    input: 500,
    output: 100,
    total: 600,
    wasted: 20,
    source: "native",
    observedBy: "reference_observer"
  });
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

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
