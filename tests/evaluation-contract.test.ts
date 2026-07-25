import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, test } from "vitest";
import type { CaseRun, RunEvent } from "../src/core/types.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { scoreCase } from "../src/scorer/score.js";

const cwd = process.cwd();

interface EvaluationContractFixture {
  schemaVersion: string;
  models: {
    targetPack: { definitionRef: string; implementationRef: string };
    contractModel: {
      definitionRef: string;
      implementationRef: string;
      formalSchemaStatus: "backlog";
    };
  };
  claims: Array<{
    id: string;
    status: "implemented" | "backlog";
    contractFields: string[];
    caseTemplateIds: string[];
    eventTypes: string[];
    oracleIds: string[];
    scoreDimensions: string[];
    gateRuleIds: string[];
    tests: string[];
  }>;
  events: Array<{ id: string; status: "implemented" | "backlog" }>;
  oracles: Array<{ id: string; status: "implemented" | "backlog" }>;
  hardFailures: Array<{
    code: string;
    severity: "P0" | "P1";
    status: "implemented" | "backlog";
    why: string;
  }>;
  dimensions: Array<{ id: string; status: "implemented" | "backlog" }>;
  comparisonClassifications: Array<{ id: string; status: "implemented" | "backlog" }>;
  gateRules: Array<{ id: string; status: "implemented" | "backlog" }>;
  evidencePolicy: {
    truePassRequires: {
      evidenceKind: "live";
      observationLevel: "workflow_trace";
      observerQualification: "valid";
    };
    diagnosticOnlyObservationLevels: string[];
  };
  scorePolicy: {
    hardFailurePrecedence: true;
    p0ScoreCap: number;
    p1ScoreCap: number;
    casePassMinimum: number;
    caseConditionalMinimum: number;
    suiteApproveMinimum: number;
    suiteConditionalMinimum: number;
    telemetryMinimum: number;
  };
  reliabilityPolicy: {
    deterministicMinimumSamples: number;
    liveMinimumSamples: number;
    gateConsistencyMinimum: number;
    caseConsistencyMinimum: number;
    maximumMissingRate: number;
    minimumTelemetryCompleteness: number;
    confidenceLevel: number;
    bootstrapIterations: number;
    defaultSeed: string;
  };
  criterionValidityPolicy: {
    requiredTargetClasses: string[];
    requiredRunners: string[];
    requiredDesignStrata: string[];
    minimumItemsPerCell: number;
    minimumTotalItems: number;
    minimumIndependentRaters: number;
    p0RecallMinimum: number;
    maximumFalsePassCount: number;
    overallAgreementMinimum: number;
    cohenKappaMinimum: number;
  };
  gatePolicy: {
    policyId: "awb-gate-policy";
    canonicalRef: "configs/evaluation/gate-policy.json";
    schemaRef: "schemas/gate-policy.schema.json";
    calibrationReportSchemaRef: "schemas/calibration-report.schema.json";
    fitSplits: ["development", "calibration"];
    holdoutSplit: "holdout";
    publicFixtureReleaseEligible: false;
  };
}

describe("canonical evaluation contract", () => {
  test("is the single machine-readable registry for implemented evaluation vocabulary", async () => {
    const contract = await readEvaluationContract();
    const workflowTraceSchema = await readJson("schemas/workflow-trace.schema.json");
    const suiteSchema = await readJson("schemas/suite-result.schema.json");
    const comparisonSchema = await readJson("schemas/comparison-result.schema.json");
    const gateSchema = await readJson("schemas/gate-result.schema.json");
    const evaluationContractSchema = await readJson(
      "schemas/evaluation-contract.schema.json"
    );

    expect(contract.schemaVersion).toBe("0.1.0");
    expect(contract.models).toEqual({
      targetPack: {
        status: "implemented",
        definitionRef: "schemas/target-pack.schema.json",
        implementationRef: "src/core/types.ts#TargetPack"
      },
      contractModel: {
        status: "implemented",
        definitionRef: "src/core/types.ts#ContractModel",
        implementationRef: "src/core/contractModel.ts#buildContractModel",
        formalSchemaStatus: "backlog"
      }
    });
    expect(contract.scorePolicy).toMatchObject({
      hardFailurePrecedence: true,
      p0ScoreCap: 49,
      p1ScoreCap: 84,
      casePassMinimum: 85,
      caseConditionalMinimum: 70,
      suiteApproveMinimum: 85,
      suiteConditionalMinimum: 70,
      telemetryMinimum: 0.75
    });
    const frozenReliabilityPolicy = {
      deterministicMinimumSamples: 5,
      liveMinimumSamples: 20,
      gateConsistencyMinimum: 0.95,
      caseConsistencyMinimum: 0.95,
      maximumMissingRate: 0,
      minimumTelemetryCompleteness: 0.75,
      confidenceLevel: 0.95,
      bootstrapIterations: 2000,
      defaultSeed: "awb-default-seed-v1"
    };
    expect(contract.reliabilityPolicy).toEqual(frozenReliabilityPolicy);
    expect(
      Object.fromEntries(
        Object.entries(
          evaluationContractSchema.properties.reliabilityPolicy.properties
        ).map(([key, value]) => [key, (value as { const?: unknown }).const])
      )
    ).toEqual(frozenReliabilityPolicy);
    const frozenCriterionValidityPolicy = {
      requiredTargetClasses: ["directory", "cli", "hybrid"],
      requiredRunners: ["codex", "claude"],
      requiredDesignStrata: [
        "known_improvement",
        "no_change",
        "ordinary_regression",
        "p0_regression"
      ],
      minimumItemsPerCell: 5,
      minimumTotalItems: 120,
      minimumIndependentRaters: 2,
      p0RecallMinimum: 1,
      maximumFalsePassCount: 0,
      overallAgreementMinimum: 0.85,
      cohenKappaMinimum: 0.8
    };
    expect(contract.criterionValidityPolicy).toEqual(
      frozenCriterionValidityPolicy
    );
    expect(
      Object.fromEntries(
        Object.entries(
          evaluationContractSchema.properties.criterionValidityPolicy
            .properties
        ).map(([key, value]) => [
          key,
          (value as { const?: unknown }).const
        ])
      )
    ).toEqual(frozenCriterionValidityPolicy);
    expect(contract.gatePolicy).toEqual({
      policyId: "awb-gate-policy",
      canonicalRef: "configs/evaluation/gate-policy.json",
      schemaRef: "schemas/gate-policy.schema.json",
      calibrationReportSchemaRef: "schemas/calibration-report.schema.json",
      fitSplits: ["development", "calibration"],
      holdoutSplit: "holdout",
      publicFixtureReleaseEligible: false
    });
    expectUnique(contract.events.map((item) => item.id));
    expectUnique(contract.oracles.map((item) => item.id));
    expectUnique(contract.hardFailures.map((item) => item.code));
    expectUnique(contract.dimensions.map((item) => item.id));
    expectUnique(contract.comparisonClassifications.map((item) => item.id));
    expectUnique(contract.gateRules.map((item) => item.id));

    expect(
      workflowTraceSchema.properties.cases.items.properties.events.items.properties.type.enum.slice().sort()
    ).toEqual(implementedIds(contract.events).sort());
    expect(suiteSchema.properties.dimensionScores.items.properties.dimension.enum.slice().sort()).toEqual(
      implementedIds(contract.dimensions).sort()
    );
    expect(comparisonSchema.properties.classification.enum.slice().sort()).toEqual(
      implementedIds(contract.comparisonClassifications).sort()
    );
    expect(gateSchema.properties.ruleId.enum.slice().sort()).toEqual(
      implementedIds(contract.gateRules).sort()
    );
    const implementedHardFailures = contract.hardFailures
      .filter((item) => item.status === "implemented")
      .map((item) => item.code)
      .sort();
    expect(
      suiteSchema.properties.caseResults.items.properties.hardFailures.items.properties.code.enum
        .slice()
        .sort()
    ).toEqual(implementedHardFailures);
    expect(
      comparisonSchema.properties.hardFailures.items.properties.code.enum.slice().sort()
    ).toEqual(implementedHardFailures);

    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    expect([...new Set(suite.cases.flatMap((item) => item.oracleIds))].sort()).toEqual(
      implementedIds(contract.oracles).sort()
    );
    expect(
      [...new Set(suite.cases.flatMap((item) => item.expectedHardFailures))].every((code) =>
        contract.hardFailures.some((failure) => failure.code === code && failure.status === "implemented")
      )
    ).toBe(true);
  });

  test("canonical hard-failure definitions override untrusted event labels and fail closed on unknown codes", async () => {
    const contract = await readEvaluationContract();
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const knownRun = makeRun(testCase.id, {
      eventId: "known-hard-failure",
      timestamp: new Date(0).toISOString(),
      type: "hard_failure",
      actor: "runner",
      payload: { code: "TARGET_ROUTE_FORBIDDEN", why: "untrusted replacement text" }
    });
    const unknownRun = makeRun(testCase.id, {
      eventId: "unknown-hard-failure",
      timestamp: new Date(0).toISOString(),
      type: "hard_failure",
      actor: "runner",
      payload: { code: "TARGET_PRIVATE_FAILURE", why: "private implementation detail" }
    });

    const known = scoreCase(testCase, knownRun).hardFailures[0]!;
    const canonicalKnown = contract.hardFailures.find((failure) => failure.code === "TARGET_ROUTE_FORBIDDEN")!;
    expect(known).toMatchObject({
      code: canonicalKnown.code,
      severity: canonicalKnown.severity,
      why: canonicalKnown.why
    });

    const unknown = scoreCase(testCase, unknownRun).hardFailures[0]!;
    const canonicalUnknown = contract.hardFailures.find((failure) => failure.code === "UNREGISTERED_HARD_FAILURE")!;
    expect(unknown).toMatchObject({
      code: canonicalUnknown.code,
      severity: canonicalUnknown.severity,
      why: canonicalUnknown.why
    });
    expect(unknown.why).not.toContain("TARGET_PRIVATE_FAILURE");

    const secretResult = scoreCase(
      testCase,
      makeRun(testCase.id, {
        eventId: "secret-hard-failure",
        timestamp: new Date(0).toISOString(),
        type: "hard_failure",
        actor: "awb-oracle",
        payload: { code: "SECRET_LEAK" }
      })
    );
    expect(secretResult.evaluationDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "sideEffect",
          status: "FAIL",
          relatedFailureCodes: ["SECRET_LEAK"]
        })
      ])
    );

    const p1Result = scoreCase(
      testCase,
      makeRun(testCase.id, {
        eventId: "telemetry-hard-failure",
        timestamp: new Date(0).toISOString(),
        type: "hard_failure",
        actor: "awb-oracle",
        payload: { code: "TELEMETRY_MISSING" }
      })
    );
    expect(p1Result).toMatchObject({
      verdict: "PASS_WITH_WARNINGS",
      scoreCap: 84
    });
  });

  test("implemented claims are fully traceable and the validity protocol names every proof axis", async () => {
    const contract = await readEvaluationContract();
    const matrix = await readFile(path.join(cwd, "docs/evaluation-contract-traceability.md"), "utf8");
    const protocol = await readFile(path.join(cwd, "docs/evaluation-validity-protocol.md"), "utf8");

    for (const claim of contract.claims.filter((item) => item.status === "implemented")) {
      expect(claim.contractFields.length, `${claim.id} contract fields`).toBeGreaterThan(0);
      expect(claim.caseTemplateIds.length, `${claim.id} cases`).toBeGreaterThan(0);
      expect(claim.eventTypes.length, `${claim.id} events`).toBeGreaterThan(0);
      expect(claim.oracleIds.length, `${claim.id} oracles`).toBeGreaterThan(0);
      expect(claim.scoreDimensions.length + claim.gateRuleIds.length, `${claim.id} score/gate`).toBeGreaterThan(0);
      expect(claim.tests.length, `${claim.id} tests`).toBeGreaterThan(0);
      expect(matrix).toContain(`| ${claim.id} |`);
    }

    for (const heading of [
      "Construct Validity",
      "Content Validity",
      "Criterion Validity",
      "Reliability",
      "Observer Qualification",
      "Bias and Leakage Control",
      "Thresholds",
      "Failure Conditions"
    ]) {
      expect(protocol).toContain(`## ${heading}`);
    }
    expect(contract.evidencePolicy.truePassRequires).toEqual({
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualification: "valid"
    });
    expect(contract.evidencePolicy.diagnosticOnlyObservationLevels).toEqual(
      expect.arrayContaining(["synthetic_events", "capability_only", "contract_summary"])
    );
  });
});

async function readEvaluationContract(): Promise<EvaluationContractFixture> {
  return YAML.parse(
    await readFile(path.join(cwd, "configs/evaluation/evaluation-contract.yaml"), "utf8")
  ) as EvaluationContractFixture;
}

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(path.join(cwd, relativePath), "utf8"));
}

function implementedIds(items: Array<{ id: string; status: "implemented" | "backlog" }>): string[] {
  return items.filter((item) => item.status === "implemented").map((item) => item.id);
}

function expectUnique(values: string[]): void {
  expect(new Set(values).size).toBe(values.length);
}

function makeRun(caseId: string, hardFailure: RunEvent): CaseRun {
  return {
    runId: `run-${hardFailure.eventId}`,
    caseId,
    runner: {
      name: "codex",
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    },
    events: [hardFailure],
    wallClockSeconds: 1,
    tokens: {
      input: 1,
      output: 1,
      total: 2,
      wasted: 0,
      costEstimateConfidence: "high"
    },
    telemetryCompleteness: 1
  };
}
