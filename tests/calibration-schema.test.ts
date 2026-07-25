import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import {
  fitGatePolicy,
  validateGatePolicyHoldout
} from "../src/calibration/gatePolicy.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { DEFAULT_GOLD_CORPUS_PATH } from "../src/evaluation/goldCorpus.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

const cwd = process.cwd();

async function compileSchema(name: string) {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", name), "utf8")
  ) as object;
  return new Ajv2020({ strict: false }).compile(schema);
}

describe("Stage 6 calibration schemas", () => {
  test("strictly validates the versioned policy and both report phases", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const suite = materializeSmokeSuite(profile.contract);
    const fitted = await fitGatePolicy({
      corpusPath: DEFAULT_GOLD_CORPUS_PATH,
      contract: profile.contract,
      cases: suite.cases,
      policyVersion: "1.0.0"
    });
    const holdout = await validateGatePolicyHoldout({
      corpusPath: DEFAULT_GOLD_CORPUS_PATH,
      contract: profile.contract,
      cases: suite.cases,
      policy: fitted.policy,
      calibrationReport: fitted.report
    });
    const validatePolicy = await compileSchema("gate-policy.schema.json");
    const validateReport = await compileSchema("calibration-report.schema.json");

    expect(
      validatePolicy(fitted.policy),
      JSON.stringify(validatePolicy.errors)
    ).toBe(true);
    expect(
      validateReport(fitted.report),
      JSON.stringify(validateReport.errors)
    ).toBe(true);
    expect(
      validateReport(holdout),
      JSON.stringify(validateReport.errors)
    ).toBe(true);
    const committedPolicy = await readJson(
      "fixtures/calibration/v1/fit/gate-policy.json"
    );
    const committedFit = await readJson(
      "fixtures/calibration/v1/fit/calibration-report.json"
    );
    const committedHoldout = await readJson(
      "fixtures/calibration/v1/holdout/calibration-report.json"
    );
    expect(committedPolicy).toEqual(fitted.policy);
    expect(committedFit).toEqual(fitted.report);
    expect(committedHoldout).toEqual(holdout);

    const weakened = structuredClone(fitted.policy) as unknown as Record<
      string,
      unknown
    >;
    weakened.hardFailurePrecedence = false;
    expect(validatePolicy(weakened)).toBe(false);

    const weakenedClassification = structuredClone(fitted.policy);
    weakenedClassification.rules.classification.minimumMeaningfulScoreDelta = 2;
    expect(validatePolicy(weakenedClassification)).toBe(false);

    const weakenedThresholds = structuredClone(fitted.policy);
    weakenedThresholds.rules.score.casePassMinimum = 80;
    weakenedThresholds.rules.telemetry.minimumCompleteness = 0.5;
    weakenedThresholds.rules.telemetry.blockingFailureCodes =
      weakenedThresholds.rules.telemetry.blockingFailureCodes.filter(
        (code) => code !== "GATE_FALSE_PASS"
      );
    weakenedThresholds.rules.budget.exhaustionFailureCodes = [];
    expect(validatePolicy(weakenedThresholds)).toBe(false);

    const leaked = structuredClone(holdout) as unknown as Record<
      string,
      unknown
    >;
    leaked.localPath = "/private/target";
    expect(validateReport(leaked)).toBe(false);

    const unscopedStability = structuredClone(holdout);
    delete (
      unscopedStability.holdout?.stability as Partial<
        NonNullable<typeof unscopedStability.holdout>["stability"]
      >
    ).scope;
    expect(validateReport(unscopedStability)).toBe(false);
  });
});

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(cwd, relativePath), "utf8")
  ) as unknown;
}
