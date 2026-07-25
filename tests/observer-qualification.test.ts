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
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, test } from "vitest";
import {
  getBenchmarkRoot,
  loadTargetPack
} from "../src/core/targetRegistry.js";
import { getImplementedHardFailureCodes } from "../src/evaluation/evaluationContract.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  referenceObserverImplementationHash
} from "../src/observer/referenceObserver.js";
import {
  OBSERVER_QUALIFICATION_REQUIRED_CHECK_IDS,
  verifyObserverQualificationArtifact
} from "../src/observer/qualification.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { semanticCaseSetHash } from "../src/regression/provenance.js";
import {
  hashFile,
  sha256Text,
  stableJson
} from "../src/utils/hash.js";

const cwd = process.cwd();
let root = "";

describe("Observer qualification", () => {
  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs the complete suite and emits an authority-signed integrity-bound artifact", async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-observer-qualification-"));
    const observerKeys = generateKeyPairSync("ed25519");
    const authorityKeys = generateKeyPairSync("ed25519");
    const observerPrivateKeyPath = path.join(root, "observer-private.pem");
    const observerPublicKeyPath = path.join(root, "observer-public.pem");
    const authorityPrivateKeyPath = path.join(root, "qualification-authority-private.pem");
    const authorityPublicKeyPath = path.join(root, "qualification-authority-public.pem");
    const outputDir = path.join(root, "qualification");
    await writeFile(
      observerPrivateKeyPath,
      observerKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );
    await writeFile(
      observerPublicKeyPath,
      observerKeys.publicKey.export({ type: "spki", format: "pem" })
    );
    await writeFile(
      authorityPrivateKeyPath,
      authorityKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );
    await writeFile(
      authorityPublicKeyPath,
      authorityKeys.publicKey.export({ type: "spki", format: "pem" })
    );

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
        "awb-reference-observer",
        "--observer-version",
        "1.0.0",
        "--observer-private-key",
        observerPrivateKeyPath,
        "--qualification-authority-private-key",
        authorityPrivateKeyPath,
        "--out",
        outputDir
      ],
      { cwd }
    );

    const artifactPath = path.join(outputDir, "observer-qualification.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const qualificationSchema = JSON.parse(
      await readFile(
        path.join(cwd, "schemas", "observer-qualification.schema.json"),
        "utf8"
      )
    );
    const validateArtifact = new Ajv2020({ strict: false }).compile(
      qualificationSchema
    );
    expect(
      validateArtifact(artifact),
      JSON.stringify(validateArtifact.errors)
    ).toBe(true);
    expect(artifact.subject.evaluationContractHash).toBe(
      await hashFile(
        path.join(
          getBenchmarkRoot(),
          "configs",
          "evaluation",
          "evaluation-contract.yaml"
        )
      )
    );
    const report = JSON.parse(
      await readFile(path.join(outputDir, "observer-qualification-report.json"), "utf8")
    );
    expect(report).toMatchObject({
      decision: "valid",
      p0DetectionRate: 1,
      falsePassCount: 0,
      knownGoodPassed: true,
      repeatAgreement: 1,
      privateKeyVisibleToRunner: false
    });
    expect(new Set(report.checks.map((check: { id: string }) => check.id))).toEqual(
      new Set(OBSERVER_QUALIFICATION_REQUIRED_CHECK_IDS)
    );
    expect(
      new Set(
        report.checks
          .filter((check: { kind: string }) => check.kind === "p0_mutation")
          .map((check: { failureCode: string }) => check.failureCode)
      )
    ).toEqual(new Set(getImplementedHardFailureCodes("P0")));

    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    await expect(
      verifyObserverQualificationArtifact(artifactPath, authorityPublicKeyPath, {
        observer: {
          id: "awb-reference-observer",
          version: "1.0.0",
          keyFingerprint: report.observer.keyFingerprint,
          implementationHash: referenceObserverImplementationHash(),
          evidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES
        },
        contractHash: profile.contract.contractHash,
        caseSetHash: semanticCaseSetHash(suite.cases)
      })
    ).resolves.toMatchObject({
      artifact: {
        results: {
          decision: "valid",
          p0DetectionRate: 1,
          falsePassCount: 0
        }
      },
      artifactHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });

    const serializedOutput = [
      await readFile(artifactPath, "utf8"),
      await readFile(path.join(outputDir, "observer-qualification-report.json"), "utf8")
    ].join("\n");
    expect(serializedOutput).not.toContain("PRIVATE KEY");
    expect(serializedOutput).not.toContain(observerPrivateKeyPath);
    expect(serializedOutput).not.toContain(authorityPrivateKeyPath);
  }, 60_000);

  test("rejects edited, wrongly signed, and contract-stale qualification artifacts", async () => {
    const artifactPath = path.join(root, "qualification", "observer-qualification.json");
    const authorityPublicKeyPath = path.join(root, "qualification-authority-public.pem");
    const wrongAuthority = generateKeyPairSync("ed25519");
    const wrongAuthorityPath = path.join(root, "wrong-authority-public.pem");
    await writeFile(
      wrongAuthorityPath,
      wrongAuthority.publicKey.export({ type: "spki", format: "pem" })
    );
    const report = JSON.parse(
      await readFile(path.join(root, "qualification", "observer-qualification-report.json"), "utf8")
    );
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const expected = {
      observer: {
        id: "awb-reference-observer",
        version: "1.0.0",
        keyFingerprint: report.observer.keyFingerprint,
        implementationHash: referenceObserverImplementationHash(),
        evidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES
      },
      contractHash: profile.contract.contractHash,
      caseSetHash: semanticCaseSetHash(suite.cases)
    };

    await expect(
      verifyObserverQualificationArtifact(artifactPath, wrongAuthorityPath, expected)
    ).rejects.toThrow(/authority|signature|fingerprint/iu);
    await expect(
      verifyObserverQualificationArtifact(
        artifactPath,
        path.join(root, "observer-public.pem"),
        expected
      )
    ).rejects.toThrow(/authority|independent|fingerprint/iu);

    const selfSignedPath = path.join(root, "self-signed-qualification.json");
    const selfSigned = JSON.parse(await readFile(artifactPath, "utf8"));
    await resignQualification(
      selfSigned,
      path.join(root, "observer-private.pem"),
      selfSignedPath
    );
    await expect(
      verifyObserverQualificationArtifact(
        selfSignedPath,
        path.join(root, "observer-public.pem"),
        expected
      )
    ).rejects.toThrow(/independent/iu);

    const staleEvaluationPath = path.join(
      root,
      "stale-evaluation-contract-qualification.json"
    );
    const staleEvaluation = JSON.parse(await readFile(artifactPath, "utf8"));
    staleEvaluation.subject.evaluationContractHash = `sha256:${"e".repeat(64)}`;
    await resignQualification(
      staleEvaluation,
      path.join(root, "qualification-authority-private.pem"),
      staleEvaluationPath
    );
    await expect(
      verifyObserverQualificationArtifact(
        staleEvaluationPath,
        authorityPublicKeyPath,
        expected
      )
    ).rejects.toThrow(/evaluation contract/iu);

    const staleImplementationPath = path.join(
      root,
      "stale-observer-implementation-qualification.json"
    );
    const staleImplementation = JSON.parse(await readFile(artifactPath, "utf8"));
    const staleImplementationHash = `sha256:${"d".repeat(64)}`;
    staleImplementation.observer.implementationHash = staleImplementationHash;
    await resignQualification(
      staleImplementation,
      path.join(root, "qualification-authority-private.pem"),
      staleImplementationPath
    );
    await expect(
      verifyObserverQualificationArtifact(
        staleImplementationPath,
        authorityPublicKeyPath,
        {
          ...expected,
          observer: {
            ...expected.observer,
            implementationHash: staleImplementationHash
          }
        }
      )
    ).rejects.toThrow(/implementation.*stale|current implementation/iu);

    await expect(
      verifyObserverQualificationArtifact(artifactPath, authorityPublicKeyPath, {
        ...expected,
        contractHash: `sha256:${"f".repeat(64)}`
      })
    ).rejects.toThrow(/contract/iu);

    const tamperedPath = path.join(root, "tampered-qualification.json");
    const tampered = JSON.parse(await readFile(artifactPath, "utf8"));
    tampered.results.falsePassCount = 1;
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(
      verifyObserverQualificationArtifact(tamperedPath, authorityPublicKeyPath, expected)
    ).rejects.toThrow(/integrity|signature|hash/iu);
  });
});

async function resignQualification(
  artifact: Record<string, any>,
  privateKeyPath: string,
  outputPath: string
): Promise<void> {
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  const publicKey = createPublicKey(privateKey);
  artifact.qualificationId = sha256Text(
    stableJson({
      observer: artifact.observer,
      subject: artifact.subject,
      results: artifact.results,
      checks: artifact.checks
    })
  );
  const {
    attestation: _attestation,
    integrity: _integrity,
    ...content
  } = artifact;
  const integrity = {
    status: "VERIFIED_AT_WRITE",
    contentHash: sha256Text(stableJson(content))
  };
  const signed = { ...content, integrity };
  const der = publicKey.export({ type: "spki", format: "der" });
  const authorityFingerprint = `sha256:${createHash("sha256")
    .update(der)
    .digest("hex")}`;
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        ...signed,
        attestation: {
          algorithm: "ed25519",
          authorityFingerprint,
          signature: sign(
            null,
            Buffer.from(stableJson(signed)),
            privateKey
          ).toString("base64")
        }
      },
      null,
      2
    )}\n`
  );
}
