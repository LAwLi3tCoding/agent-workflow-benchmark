import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { runCase } from "../src/runner/simulatedRunner.js";
import { scoreCase, scoreSuite } from "../src/scorer/score.js";

describe("run and score", () => {
  test("keeps simulated case scores but does not make a target release approval", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const caseResults = suite.cases.map((testCase) => scoreCase(testCase, runCase(testCase, profile.contract)));
    const suiteResult = scoreSuite("run-test", profile.contract, "smoke", caseResults);

    expect(suiteResult.releaseDecision).toBe("DIAGNOSTIC_ONLY");
    expect(suiteResult.debugHealth.doesNotAffectTargetScore).toBe(true);
    expect(suiteResult.telemetryCompleteness).toBeGreaterThan(0.8);
    expect(suiteResult.caseResults.every((item) => item.verdict === "PASS")).toBe(true);
  });

  test("route-break mutation creates a hard failure", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "forbidden-route");
    expect(testCase).toBeDefined();

    const result = scoreCase(testCase!, runCase(testCase!, profile.contract, { id: "route-break", type: "route-break" }));

    expect(result.verdict).toBe("FAIL");
    expect(result.hardFailures.map((item) => item.code)).toContain("TARGET_ROUTE_FORBIDDEN");
  });

  test("case scoring includes multi-dimensional evaluation details", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "forbidden-route")!;

    const result = scoreCase(testCase, runCase(testCase, profile.contract, { id: "route-break", type: "route-break" }));

    expect(result.evaluationDimensions.map((item) => item.dimension)).toEqual(
      expect.arrayContaining(["contract", "routing", "ownership", "gate", "artifact", "state", "join", "sideEffect", "telemetry", "efficiency", "runner"])
    );
    expect(result.evaluationDimensions.find((item) => item.dimension === "routing")).toMatchObject({
      status: "FAIL",
      relatedFailureCodes: ["TARGET_ROUTE_FORBIDDEN"]
    });
    expect(result.scoreProvenance.dimensionProvenance.length).toBeGreaterThan(3);
  });

  test("state-recovery scoring consumes matching state_read evidence and downgrades missing evidence", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find(
      (item) => item.templateId === "state-recovery"
    )!;
    const observedRun = runCase(testCase, profile.contract);
    observedRun.runner = {
      name: "codex",
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    };
    const observed = scoreCase(testCase, observedRun);
    expect(observed.evaluationDimensions.find((item) => item.dimension === "state")).toMatchObject({
      status: "PASS",
      evidenceEventIds: [expect.any(String)]
    });
    expect(
      scoreSuite("state-observed", profile.contract, "smoke", [observed], {
        evidenceKind: "live",
        observationLevel: "workflow_trace",
        observerQualification: "valid"
      }).releaseDecision
    ).toBe("APPROVE");

    const missingRun = structuredClone(observedRun);
    missingRun.events = missingRun.events.filter((event) => event.type !== "state_read");
    const missing = scoreCase(testCase, missingRun);
    expect(missing.evaluationDimensions.find((item) => item.dimension === "state")).toMatchObject({
      status: "DIAGNOSTIC_ONLY",
      score: 0,
      evidenceEventIds: []
    });
    expect(missing.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(scoreSuite("state-missing", profile.contract, "smoke", [missing]).releaseDecision).toBe(
      "DIAGNOSTIC_ONLY"
    );
  });

  test("nonzero live runner exit becomes diagnostic only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-exit",
      timestamp: new Date(0).toISOString(),
      type: "runner_exit",
      actor: "codex",
      payload: { exitCode: 2 }
    });
    run.telemetryCompleteness = 0.5;

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.score).toBe(0);
  });

  test("timed out live runner exit becomes diagnostic only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-timeout",
      timestamp: new Date(0).toISOString(),
      type: "runner_exit",
      actor: "codex",
      payload: { exitCode: null, timedOut: true }
    });

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.score).toBe(0);
  });

  test("suite with diagnostic-only case remains diagnostic-only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "inconclusive" }
    });
    const result = scoreCase(testCase, run);
    const suite = scoreSuite("diagnostic-suite", profile.contract, "smoke", [result]);

    expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
  });

  test("suite aggregates dimension scores, recommendations, and P0 case records", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "forbidden-route")!;
    const result = scoreCase(testCase, runCase(testCase, profile.contract, { id: "route-break", type: "route-break" }));
    const suite = scoreSuite("p0-suite", profile.contract, "smoke", [result]);

    expect(suite.dimensionScores.find((item) => item.dimension === "routing")).toMatchObject({
      status: "FAIL",
      affectedCaseIds: [testCase.id]
    });
    expect(suite.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: "P0",
          category: "routing",
          sourceFailureCodes: ["TARGET_ROUTE_FORBIDDEN"],
          evidenceCaseIds: [testCase.id]
        })
      ])
    );
    expect(suite.p0CaseRecords).toEqual([
      expect.objectContaining({
        targetId: "minimal-directory-agent",
        runId: "p0-suite",
        caseId: testCase.id,
        failureCode: "TARGET_ROUTE_FORBIDDEN",
        recommendedAction: expect.stringContaining("forbidden"),
        recordedAt: expect.any(String)
      })
    ]);
    expect(Date.parse(suite.p0CaseRecords[0]!.recordedAt)).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));
  });

  test("live hard failure events become P0 records and block release", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "forbidden-route")!;
    const run = runCase(testCase, profile.contract);
    run.runner = {
      name: "codex",
      comparability: {
        workflowScore: "directional_only",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    };
    run.events.push({
      eventId: "event-live-fail",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "FAIL", hardFailureCodes: ["TARGET_ROUTE_FORBIDDEN"] }
    });
    run.events.push({
      eventId: "event-live-hard-failure",
      timestamp: new Date(0).toISOString(),
      type: "hard_failure",
      actor: "codex",
      payload: { code: "TARGET_ROUTE_FORBIDDEN", why: "Live runner reported forbidden routing." }
    });

    const result = scoreCase(testCase, run);
    const suite = scoreSuite("live-p0-suite", profile.contract, "smoke", [result]);

    expect(result.hardFailures.map((failure) => failure.code)).toContain("TARGET_ROUTE_FORBIDDEN");
    expect(suite.releaseDecision).toBe("BLOCK");
    expect(suite.releaseRuleId).toBe("REL-P0-WORKFLOW-HARD-FAIL");
    expect(suite.p0CaseRecords[0]?.failureCode).toBe("TARGET_ROUTE_FORBIDDEN");
  });

  test("directional-only live contract-summary evidence remains diagnostic-only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.runner = {
      name: "codex",
      comparability: {
        workflowScore: "directional_only",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    };

    const result = scoreCase(testCase, run);
    const suite = scoreSuite("directional-live-suite", profile.contract, "smoke", [result]);

    expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
    expect(suite.releaseRuleId).toBe("REL-EVIDENCE-CONTRACT-SUMMARY");
  });

  test("conditional approval has a distinct release rule id", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const result = scoreCase(testCase, runCase(testCase, profile.contract));
    result.runner.comparability.workflowScore = "comparable";
    result.rawScore = 80;
    result.cappedScore = 80;
    result.score = 80;
    result.verdict = "PASS_WITH_WARNINGS";

    const suite = scoreSuite("conditional-suite", profile.contract, "smoke", [result], {
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualification: "valid"
    });

    expect(suite.releaseDecision).toBe("CONDITIONAL_APPROVE");
    expect(suite.releaseRuleId).toBe("REL-CONDITIONAL");
  });

  test("inconclusive live runner result becomes diagnostic only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "inconclusive" }
    });

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.scoreProvenance.oracleResults[0]?.why).toContain("inconclusive");
  });

  test("any non-pass live runner result becomes diagnostic only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "cannot_verify" }
    });

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.scoreProvenance.oracleResults[0]?.why).toContain("cannot_verify");
  });

  test("live runner fail result becomes failed case", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "FAIL" }
    });

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("FAIL");
    expect(result.score).toBe(0);
    expect(result.scoreProvenance.oracleResults[0]?.why).toContain("Runner returned FAIL");
  });

  test("suite blocks when any case fails even if the average score is high", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const smoke = materializeSmokeSuite(profile.contract);
    const failedRun = runCase(smoke.cases[0]!, profile.contract);
    failedRun.runner = {
      name: "codex",
      comparability: {
        workflowScore: "directional_only",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    };
    failedRun.events.push({
      eventId: "event-runner-fail",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: { verdict: "FAIL" }
    });
    const failed = scoreCase(smoke.cases[0]!, failedRun);
    const passes = smoke.cases.slice(1, 10).map((testCase) => {
      const run = runCase(testCase, profile.contract);
      run.runner = {
        name: "codex",
        comparability: {
          workflowScore: "directional_only",
          efficiency: "directional_only",
          tokenCost: "directional_only"
        }
      };
      return scoreCase(testCase, run);
    });

    const suite = scoreSuite("failed-average-suite", profile.contract, "smoke", [failed, ...passes]);

    expect(suite.caseResults.map((result) => result.verdict)).toContain("FAIL");
    expect(suite.cappedSuiteScore).toBeGreaterThanOrEqual(85);
    expect(suite.releaseDecision).toBe("BLOCK");
    expect(suite.releaseRuleId).toBe("REL-CASE-FAILED");
  });

  test("zero token totals do not produce NaN scores", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.tokens = {
      input: 0,
      output: 0,
      total: 0,
      wasted: 0,
      costEstimateConfidence: "unavailable"
    };

    const result = scoreCase(testCase, run);

    expect(Number.isNaN(result.rawScore)).toBe(false);
    expect(Number.isNaN(result.cappedScore)).toBe(false);
  });

  test("denied external writes are safe but allowed external writes are hard failures", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "side-effect-deny")!;
    const denied = runCase(testCase, profile.contract);
    denied.events.push({
      eventId: "event-denied-external-write",
      timestamp: new Date(0).toISOString(),
      type: "side_effect_attempt",
      actor: "benchmark",
      payload: { command: "fake-prod-write", policyDecision: "deny", allowed: false, classifiedAs: "external_write" }
    });
    const allowed = runCase(testCase, profile.contract);
    allowed.events.push({
      eventId: "event-allowed-external-write",
      timestamp: new Date(0).toISOString(),
      type: "side_effect_attempt",
      actor: "benchmark",
      payload: { command: "fake-prod-write", policyDecision: "allow", allowed: true, classifiedAs: "external_write" }
    });

    expect(scoreCase(testCase, denied).hardFailures.map((failure) => failure.code)).not.toContain("PRODUCTION_SIDE_EFFECT");
    expect(scoreCase(testCase, allowed).hardFailures.map((failure) => failure.code)).toContain("PRODUCTION_SIDE_EFFECT");
  });
});
