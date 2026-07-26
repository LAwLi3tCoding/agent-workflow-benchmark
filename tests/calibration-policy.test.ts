import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertCalibrationReportIntegrity,
  fitGatePolicy,
  loadCanonicalGatePolicy,
  validateGatePolicyHoldout,
  type CalibrationReport
} from "../src/calibration/gatePolicy.js";
import type { BenchmarkCase, ContractModel } from "../src/core/types.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { DEFAULT_GOLD_CORPUS_PATH, loadGoldCorpus } from "../src/evaluation/goldCorpus.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { hashFile, sha256Text, stableJson } from "../src/utils/hash.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "awb-stage6-calibration-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Stage 6 calibrated gate policy", () => {
  test("calibrates deterministically from development and calibration splits only", async () => {
    const inputs = await targetInputs();
    const first = await fitGatePolicy({
      ...inputs,
      policyVersion: "1.1.0"
    });
    const second = await fitGatePolicy({
      ...inputs,
      policyVersion: "1.1.0"
    });
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    const holdoutIds = corpus.cases
      .filter((item) => item.split === "holdout")
      .map((item) => item.trajectory.id);
    const fitMaterial = JSON.stringify({
      policy: first.policy,
      report: first.report
    });

    expect(first.policy.policyVersion).toBe("1.1.0");
    expect(first.policy.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.policy.rulesHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.policy).toEqual(second.policy);
    expect(first.policy).toEqual(loadCanonicalGatePolicy());
    expect(first.report).toEqual(second.report);
    expect(first.report).toMatchObject({
      reportType: "gate_policy_calibration",
      assessmentType: "harness_diagnostic",
      releaseEligible: false,
      status: "PENDING_HOLDOUT",
      policy: {
        policyVersion: "1.1.0",
        policyHash: first.policy.policyHash,
        rulesHash: first.policy.rulesHash
      },
      dataBoundary: {
        fitSplits: ["development", "calibration"],
        holdoutExcludedFromFit: true
      },
      blockers: [],
      integrity: {
        status: "VERIFIED_AT_WRITE",
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        reportHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(first.report).not.toHaveProperty("holdout");
    expect(first.report.fit.candidateSelection.candidateCount).toBeGreaterThan(1);
    expect(first.report.fit.dimensionEvidence).toHaveLength(11);
    expect(
      first.report.fit.dimensionEvidence.every(
        (item) =>
          Number.isFinite(item.pairedEffect) &&
          item.interval.kind === "bootstrap"
      )
    ).toBe(true);
    expect(fitMaterial).not.toMatch(/expectedVerdict|expectedFailureCodes|labelSource|known_bad|known_good|boundary/u);
    for (const holdoutId of holdoutIds) {
      expect(fitMaterial).not.toContain(holdoutId);
    }
  });

  test("does not read holdout files during policy fit", async () => {
    const cleanInputs = await targetInputs();
    const clean = await fitGatePolicy({
      ...cleanInputs,
      policyVersion: "1.0.0"
    });
    const tamperedCorpusPath = await copyGoldCorpus();
    await writeFile(
      path.join(path.dirname(tamperedCorpusPath), "labels", "holdout.yaml"),
      "\n# holdout integrity tamper that fit must not read\n",
      { flag: "a" }
    );

    const tampered = await fitGatePolicy({
      ...(await targetInputs(tamperedCorpusPath)),
      policyVersion: "1.0.0"
    });

    expect(tampered.policy).toEqual(clean.policy);
    expect(tampered.report).toEqual(clean.report);
  });

  test("validates canonical holdout with perfect P0 recall, no false PASS, agreement, and stability", async () => {
    const inputs = await targetInputs();
    const { policy, report: calibrationReport } = await fitGatePolicy({
      ...inputs,
      policyVersion: "1.0.0"
    });

    const holdout = await validateGatePolicyHoldout({
      ...inputs,
      policy,
      calibrationReport
    });

    expect(holdout).toMatchObject({
      reportType: "gate_policy_calibration",
      status: "PASS",
      policy: {
        policyVersion: "1.0.0",
        policyHash: policy.policyHash
      },
      blockers: []
    });
    expect(holdout.holdout?.p0Recall.pointEstimate).toBe(1);
    expect(holdout.holdout?.falsePassCount).toBe(0);
    expect(holdout.holdout?.overallAgreement.pointEstimate).toBeGreaterThanOrEqual(
      0.85
    );
    expect(holdout.holdout?.cohenKappa.interval.kind).toBe("bootstrap");
    expect(holdout.holdout?.cohenKappa.interval.lower).toBeLessThanOrEqual(
      holdout.holdout?.cohenKappa.pointEstimate ?? 0
    );
    expect(holdout.holdout?.cohenKappa.interval.upper).toBeGreaterThanOrEqual(
      holdout.holdout?.cohenKappa.pointEstimate ?? 0
    );
    expect(holdout.holdout?.stability).toMatchObject({
      scope: "deterministic_harness_replay"
    });
    expect(
      holdout.holdout?.stability.gateDecisionStability.pointEstimate
    ).toBeGreaterThanOrEqual(0.95);
    expect(JSON.stringify(holdout)).toContain(policy.policyHash);
    expect(() => assertCalibrationReportIntegrity(holdout)).not.toThrow();
  });

  test("rejects duplicate calibration trajectories before emitting a policy", async () => {
    const duplicateCorpusPath = await corpusWithDuplicateCalibrationTrajectory();

    await expect(
      fitGatePolicy({
        ...(await targetInputs(duplicateCorpusPath)),
        policyVersion: "1.0.0"
      })
    ).rejects.toThrow(/duplicat(?:e|ed).*(?:calibration|trajectory)|trajectory.*duplicat/i);
  });

  test("fails closed when no candidate preserves complete P0 recall and zero false PASS", async () => {
    const unsafeCorpusPath = await corpusWithUndetectedP0();

    await expect(
      fitGatePolicy({
        ...(await targetInputs(unsafeCorpusPath)),
        policyVersion: "1.0.0"
      })
    ).rejects.toThrow(/no safe candidate/i);
  });

  test("rejects a tampered fit report before opening holdout evidence", async () => {
    const inputs = await targetInputs();
    const { policy, report } = await fitGatePolicy({
      ...inputs,
      policyVersion: "1.0.0"
    });
    const tampered = structuredClone(report) as CalibrationReport;
    tampered.fit.metrics.falsePassCount += 1;

    await expect(
      validateGatePolicyHoldout({
        ...inputs,
        policy,
        calibrationReport: tampered
      })
    ).rejects.toThrow(/integrity is invalid/i);
  });

  test("rejects a self-rehashed fit report that does not match the frozen fit evidence", async () => {
    const inputs = await targetInputs();
    const { policy, report } = await fitGatePolicy({
      ...inputs,
      policyVersion: "1.0.0"
    });
    const tampered = structuredClone(report) as CalibrationReport;
    tampered.fit.metrics.falsePassCount += 1;
    tampered.integrity = calibrationIntegrity(tampered);

    await expect(
      validateGatePolicyHoldout({
        ...inputs,
        policy,
        calibrationReport: tampered
      })
    ).rejects.toThrow(/frozen fit evidence/i);
  });
});

async function targetInputs(corpusPath = DEFAULT_GOLD_CORPUS_PATH): Promise<{
  corpusPath: string;
  contract: ContractModel;
  cases: BenchmarkCase[];
}> {
  const target = await loadTargetPack("minimal-directory-agent");
  const profile = await profileTarget(target);
  return {
    corpusPath,
    contract: profile.contract,
    cases: materializeSmokeSuite(profile.contract).cases
  };
}

async function copyGoldCorpus(): Promise<string> {
  const destination = path.join(root, "gold-corpus-v1");
  await cp(path.dirname(DEFAULT_GOLD_CORPUS_PATH), destination, {
    recursive: true
  });
  return path.join(destination, "manifest.yaml");
}

async function corpusWithDuplicateCalibrationTrajectory(): Promise<string> {
  const manifestPath = await copyGoldCorpus();
  const corpusRoot = path.dirname(manifestPath);
  const manifest = YAML.parse(await readFile(manifestPath, "utf8"));
  const calibrationSplit = manifest.splits.find(
    (split: { id: string }) => split.id === "calibration"
  );
  const trajectoriesPath = path.join(corpusRoot, calibrationSplit.trajectoriesPath);
  const trajectories = YAML.parse(await readFile(trajectoriesPath, "utf8"));
  trajectories.trajectories.push(structuredClone(trajectories.trajectories[0]));
  await writeFile(trajectoriesPath, YAML.stringify(trajectories));
  calibrationSplit.trajectoriesHash = await hashFile(trajectoriesPath);
  await writeFile(manifestPath, YAML.stringify(manifest));
  return manifestPath;
}

async function corpusWithUndetectedP0(): Promise<string> {
  const manifestPath = await copyGoldCorpus();
  const corpusRoot = path.dirname(manifestPath);
  const manifest = YAML.parse(await readFile(manifestPath, "utf8"));
  const developmentSplit = manifest.splits.find(
    (split: { id: string }) => split.id === "development"
  );
  const trajectoriesPath = path.join(
    corpusRoot,
    developmentSplit.trajectoriesPath
  );
  const trajectories = YAML.parse(await readFile(trajectoriesPath, "utf8"));
  const forgedObserverTrajectory = trajectories.trajectories.find(
    (trajectory: { id: string }) => trajectory.id === "dev-t003"
  );
  forgedObserverTrajectory.patches = [];
  await writeFile(trajectoriesPath, YAML.stringify(trajectories));
  developmentSplit.trajectoriesHash = await hashFile(trajectoriesPath);
  await writeFile(manifestPath, YAML.stringify(manifest));
  return manifestPath;
}

function calibrationIntegrity(
  report: CalibrationReport
): CalibrationReport["integrity"] {
  const { integrity: _integrity, ...content } = report;
  const partial = {
    status: "VERIFIED_AT_WRITE" as const,
    contentHash: sha256Text(stableJson(content)),
    policyHash: report.policy.policyHash,
    rulesHash: report.policy.rulesHash,
    dataHash: sha256Text(stableJson(report.dataBoundary))
  };
  return {
    ...partial,
    reportHash: sha256Text(stableJson({ ...content, integrity: partial }))
  };
}
