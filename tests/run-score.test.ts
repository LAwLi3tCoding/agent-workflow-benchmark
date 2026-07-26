import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { runCase } from "../src/runner/simulatedRunner.js";
import { statusMappingDiagnostics } from "../src/evaluation/statusSemantics.js";
import {
  scoreCase,
  scoreCaseWithContract,
  scoreSuite
} from "../src/scorer/score.js";
import { renderMarkdownReport } from "../src/report/report.js";

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
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
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
      actor: "observer",
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

  test("missing owner-reviewed status semantics caps qualified evidence at diagnostic-only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract) as typeof profile.contract & {
      statusSemantics?: unknown;
    };
    delete contract.statusSemantics;
    const testCase = materializeSmokeSuite(contract).cases[0]!;
    const run = runCase(testCase, contract);
    run.runner = {
      name: "codex",
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    };
    const result = scoreCase(testCase, run);
    const suite = scoreSuite(
      "status-mapping-missing",
      contract,
      "smoke",
      [result],
      {
        evidenceKind: "live",
        observationLevel: "workflow_trace",
        observerQualification: "valid"
      }
    ) as ReturnType<typeof scoreSuite> & {
      contractDiagnostics: Array<{
        code: string;
        statusCodes: string[];
      }>;
    };

    expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
    expect(suite.releaseRuleId).toBe("REL-CONTRACT-MAPPING-MISSING");
    expect(suite.contractDiagnostics).toContainEqual({
      code: "CONTRACT_MAPPING_MISSING",
      statusCodes: contract.statuses
    });
    expect(suite.p0CaseRecords).toEqual([]);
    expect(suite.recommendations).toContainEqual(
      expect.objectContaining({
        category: "contract",
        sourceFailureCodes: ["CONTRACT_MAPPING_MISSING"]
      })
    );
    const report = renderMarkdownReport(suite);
    expect(report).toContain("Release Rule: REL-CONTRACT-MAPPING-MISSING");
    expect(report).toContain("## Contract Mapping Diagnostics");
    expect(report).toContain("CONTRACT_MAPPING_MISSING");
    expect(report).toContain(contract.statuses.join(", "));
  });

  test("a status-bound case without matching gate evidence is diagnostic-only", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const testCase = structuredClone(
      materializeSmokeSuite(profile.contract).cases[0]!
    );
    testCase.bindings.statusCode = "PASS";
    testCase.bindings.statusScope = "release-gate";
    const run = runCase(testCase, profile.contract);
    run.events = run.events.filter((event) => event.type !== "gate_decision");

    const result = scoreCaseWithContract(testCase, run, profile.contract);

    expect(
      result.evaluationDimensions.find(
        (dimension) => dimension.dimension === "gate"
      )
    ).toMatchObject({
      status: "DIAGNOSTIC_ONLY",
      score: 0,
      evidenceEventIds: []
    });
    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.scoreProvenance.oracleResults).toEqual([
      expect.objectContaining({
        status: "FAIL",
        why: expect.stringContaining("incomplete")
      })
    ]);
  });

  test("accepts an unscoped gate status only when its contract scope is unambiguous", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const testCase = materializeSmokeSuite(profile.contract).cases.find(
      (item) => item.templateId === "skip-not-pass"
    )!;
    const run = runCase(testCase, profile.contract);
    delete run.events.find(
      (event) => event.type === "gate_decision"
    )!.payload.scope;

    expect(
      scoreCaseWithContract(
        testCase,
        run,
        profile.contract
      ).evaluationDimensions.find(
        (dimension) => dimension.dimension === "gate"
      )
    ).toMatchObject({
      status: "PASS"
    });

    const ambiguousContract = structuredClone(profile.contract);
    ambiguousContract.statusSemantics!.push({
      ...ambiguousContract.statusSemantics!.find(
        (mapping) => mapping.code === testCase.bindings.statusCode
      )!,
      scope: "release-gate"
    });
    expect(
      scoreCaseWithContract(
        testCase,
        run,
        ambiguousContract
      ).evaluationDimensions.find(
        (dimension) => dimension.dimension === "gate"
      )
    ).toMatchObject({
      status: "DIAGNOSTIC_ONLY"
    });
  });

  test("derives false-pass failure only from complete contract-mapped gate evidence", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract);
    contract.statuses = ["GREEN", "WAIVED"];
    contract.statusSemantics = [
      {
        code: "GREEN",
        semanticClass: "pass",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      },
      {
        code: "WAIVED",
        semanticClass: "skipped",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      }
    ];
    const testCase = materializeSmokeSuite(contract).cases.find(
      (item) => item.templateId === "skip-not-pass"
    )!;
    const run = runCase(testCase, contract);
    const gate = run.events.find((event) => event.type === "gate_decision")!;
    gate.payload = {
      status: "GREEN",
      sourceStatus: "WAIVED",
      scope: "release-gate",
      flowDecision: "release",
      transition: { from: "WAIVED", to: "GREEN" },
      readbackStatus: "GREEN"
    };

    expect(
      scoreCaseWithContract(testCase, run, contract).hardFailures.map(
        (failure) => failure.code
      )
    ).toContain("GATE_FALSE_PASS");

    const incompleteRun = structuredClone(run);
    delete incompleteRun.events.find(
      (event) => event.type === "gate_decision"
    )!.payload.transition;
    expect(
      scoreCaseWithContract(testCase, incompleteRun, contract).hardFailures.map(
        (failure) => failure.code
      )
    ).not.toContain("GATE_FALSE_PASS");

    const allowedRun = structuredClone(run);
    contract.statusSemantics[1]!.blocking = true;
    contract.statusSemantics[1]!.terminal = false;
    contract.statusSemantics[1]!.allowedTransitions = ["GREEN"];
    expect(
      scoreCaseWithContract(testCase, allowedRun, contract).hardFailures.map(
        (failure) => failure.code
      )
    ).not.toContain("GATE_FALSE_PASS");
  });

  test("terminal status mappings with outgoing transitions remain diagnostic-only", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract);
    contract.statuses = ["GREEN", "FAILED_FINAL"];
    contract.statusSemantics = [
      {
        code: "GREEN",
        semanticClass: "pass",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      },
      {
        code: "FAILED_FINAL",
        semanticClass: "failure",
        scope: "release-gate",
        blocking: true,
        terminal: true,
        allowedTransitions: ["GREEN"]
      }
    ];
    const testCase = materializeSmokeSuite(contract).cases[0]!;
    const result = scoreCase(testCase, runCase(testCase, contract));
    const suite = scoreSuite(
      "terminal-transition-contradiction",
      contract,
      "smoke",
      [result],
      {
        evidenceKind: "live",
        observationLevel: "workflow_trace",
        observerQualification: "valid"
      }
    );

    expect(suite.contractDiagnostics).toEqual([
      {
        code: "CONTRACT_MAPPING_MISSING",
        statusCodes: ["FAILED_FINAL"]
      }
    ]);
    expect(suite.p0CaseRecords).toEqual([]);
    expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
    expect(suite.releaseRuleId).toBe("REL-CONTRACT-MAPPING-MISSING");
  });

  test("diagnoses transition targets that are not mapped in the same scope", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract);
    contract.statuses = ["GREEN", "WAIT"];
    contract.statusSemantics = [
      {
        code: "GREEN",
        semanticClass: "pass",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      },
      {
        code: "WAIT",
        semanticClass: "pending",
        scope: "build-gate",
        blocking: true,
        terminal: false,
        allowedTransitions: ["GREEN"]
      }
    ];

    expect(statusMappingDiagnostics(contract)).toEqual([
      {
        code: "CONTRACT_MAPPING_MISSING",
        statusCodes: ["GREEN", "WAIT"]
      }
    ]);
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

  test("directional-only contract-summary runner FAIL remains diagnostic-only", async () => {
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
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "codex",
      payload: {
        verdict: "FAIL",
        observationLevel: "contract_summary",
        authoritative: false
      }
    });

    const result = scoreCase(testCase, run);

    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(result.score).toBe(0);
    expect(result.scoreProvenance.oracleResults[0]?.why).toContain("fail");
  });

  test("ignores runner-authored hard failures from contract-summary evidence", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
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
    run.events.push(
      {
        eventId: "event-runner-result",
        timestamp: new Date(20_000).toISOString(),
        type: "runner_result",
        actor: "codex",
        payload: {
          verdict: "FAIL",
          observationLevel: "contract_summary",
          authoritative: false,
          hardFailureCodes: ["GATE_FALSE_PASS"]
        }
      },
      {
        eventId: "event-runner-hard-failure",
        timestamp: new Date(21_000).toISOString(),
        type: "hard_failure",
        actor: "codex",
        payload: {
          code: "GATE_FALSE_PASS",
          why: "Runner summary asserted a hard failure."
        }
      }
    );

    const result = scoreCaseWithContract(testCase, run, profile.contract);
    const suite = scoreSuite(
      "contract-summary-hard-failure",
      profile.contract,
      "smoke",
      [result],
      {
        evidenceKind: "live",
        observationLevel: "contract_summary"
      }
    );

    expect(result.hardFailures).toEqual([]);
    expect(result.verdict).toBe("DIAGNOSTIC_ONLY");
    expect(suite.p0CaseRecords).toEqual([]);
    expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
    expect(suite.releaseRuleId).toBe("REL-EVIDENCE-CONTRACT-SUMMARY");
  });

  test("comparable workflow-trace runner FAIL remains a failed case", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
    const run = runCase(testCase, profile.contract);
    run.runner = {
      name: "codex",
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    };
    run.events.push({
      eventId: "event-runner-result",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "observer",
      payload: {
        verdict: "FAIL",
        observationLevel: "workflow_trace",
        authoritative: true
      }
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
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    };
    failedRun.events.push({
      eventId: "event-runner-fail",
      timestamp: new Date(0).toISOString(),
      type: "runner_result",
      actor: "observer",
      payload: {
        verdict: "FAIL",
        observationLevel: "workflow_trace",
        authoritative: true
      }
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
