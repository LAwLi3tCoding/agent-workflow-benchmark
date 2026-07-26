import type {
  AgentWorkflowRecommendation,
  BenchmarkCase,
  CaseEvaluationDimension,
  CaseResult,
  CaseRun,
  ContractModel,
  EvaluationDimension,
  EvaluationStatus,
  HardFailure,
  P0CaseRecord,
  SuiteDimensionScore,
  SuiteResult
} from "../core/types.js";
import {
  getEvaluationContract,
  getHardFailureDefinition,
  getImplementedDimensions
} from "../evaluation/evaluationContract.js";
import {
  isFalsePassTransition,
  resolveStatusSemantic,
  statusMappingDiagnostics
} from "../evaluation/statusSemantics.js";
import type { EvidenceKind, ObservationLevel } from "../doctor/doctor.js";
import {
  gatePolicyBinding,
  loadCanonicalGatePolicy,
  type GatePolicy,
  type GatePolicyRules
} from "../calibration/policyArtifact.js";

export interface SuiteEvidenceContext {
  evidenceKind: EvidenceKind;
  observationLevel: ObservationLevel;
  observerQualification?: "missing" | "valid" | "invalid";
}

export function scoreCase(
  testCase: BenchmarkCase,
  run: CaseRun,
  policyRules: GatePolicyRules = loadCanonicalGatePolicy().rules
): CaseResult {
  return scoreCaseAgainstContract(testCase, run, undefined, policyRules);
}

export function scoreCaseWithContract(
  testCase: BenchmarkCase,
  run: CaseRun,
  contract: ContractModel,
  policyRules: GatePolicyRules = loadCanonicalGatePolicy().rules
): CaseResult {
  return scoreCaseAgainstContract(testCase, run, contract, policyRules);
}

function scoreCaseAgainstContract(
  testCase: BenchmarkCase,
  run: CaseRun,
  contract: ContractModel | undefined,
  policyRules: GatePolicyRules
): CaseResult {
  const hardFailures = collectHardFailures(run, contract);
  const runnerFailure = hasRunnerFailure(run);
  const runnerDiagnostic = getRunnerDiagnosticReason(run);
  const runner = runnerForRun(run);
  const authoritativeRunnerFail = hasAuthoritativeRunnerFailResult(run, runner);
  if (authoritativeRunnerFail) {
    const evaluationDimensions = evaluateCaseDimensions(
      testCase,
      run,
      hardFailures,
      {
        status: "FAIL",
        why: "Runner returned FAIL for the provided oracle evidence."
      },
      policyRules,
      contract
    );
    return {
      schemaVersion: "0.1.0",
      resultType: "case",
      targetId: testCase.targetId,
      caseId: testCase.id,
      caseHash: testCase.caseHash,
      contractHash: testCase.contractHash,
      templateId: testCase.templateId,
      title: testCase.title,
      runner: {
        name: runner.name,
        comparability: runner.comparability
      },
      score: 0,
      rawScore: 0,
      cappedScore: 0,
      scoreCap: 100,
      verdict: "FAIL",
      hardFailures,
      telemetryCompleteness: run.telemetryCompleteness,
      tokens: run.tokens,
      efficiency: { wallClockSeconds: run.wallClockSeconds },
      evaluationDimensions,
      scoreProvenance: {
        oracleResults: testCase.oracleIds.map((oracleId) => ({
          oracleId,
          status: "FAIL",
          why: "Runner returned FAIL for the provided oracle evidence."
        })),
        dimensionProvenance: toDimensionProvenance(evaluationDimensions)
      }
    };
  }
  if (runnerFailure || runnerDiagnostic) {
    const reason = runnerFailure
      ? "Runner exited unsuccessfully; workflow result is not comparable."
      : `Runner result was ${runnerDiagnostic}; workflow result is not comparable.`;
    const evaluationDimensions = evaluateCaseDimensions(
      testCase,
      run,
      hardFailures,
      {
        status: "DIAGNOSTIC_ONLY",
        why: reason
      },
      policyRules,
      contract
    );
    return {
      schemaVersion: "0.1.0",
      resultType: "case",
      targetId: testCase.targetId,
      caseId: testCase.id,
      caseHash: testCase.caseHash,
      contractHash: testCase.contractHash,
      templateId: testCase.templateId,
      title: testCase.title,
      runner: {
        name: runner.name,
        comparability: {
          workflowScore: "not_comparable",
          efficiency: "not_comparable",
          tokenCost: "not_comparable"
        }
      },
      score: 0,
      rawScore: 0,
      cappedScore: 0,
      scoreCap: 0,
      verdict: "DIAGNOSTIC_ONLY",
      hardFailures,
      telemetryCompleteness: run.telemetryCompleteness,
      tokens: run.tokens,
      efficiency: { wallClockSeconds: run.wallClockSeconds },
      evaluationDimensions,
      scoreProvenance: {
        oracleResults: testCase.oracleIds.map((oracleId) => ({
          oracleId,
          status: "FAIL",
          why: reason
        })),
        dimensionProvenance: toDimensionProvenance(evaluationDimensions)
      }
    };
  }
  const evaluationDimensions = evaluateCaseDimensions(
    testCase,
    run,
    hardFailures,
    {
      status: "PASS",
      why: "Runner produced comparable PASS evidence."
    },
    policyRules,
    contract
  );
  const policy = policyRules.score;
  const rawScore = Math.max(
    0,
    Math.round(
      weightedDimensionAverage(
        evaluationDimensions,
        policyRules.dimensionWeights
      )
    )
  );
  const hasP0 = hardFailures.some((failure) => failure.severity === "P0");
  const hasP1 = hardFailures.some((failure) => failure.severity === "P1");
  const hasDiagnosticOnlyDimension = evaluationDimensions.some(
    (dimension) => dimension.status === "DIAGNOSTIC_ONLY"
  );
  const scoreCap = hasP0
    ? policy.p0ScoreCap
    : hasP1
      ? policy.p1ScoreCap
      : hasDiagnosticOnlyDimension
        ? 0
        : 100;
  const cappedScore = Math.min(rawScore, scoreCap);
  const verdict =
    hasP0
      ? "FAIL"
      : hasDiagnosticOnlyDimension
        ? "DIAGNOSTIC_ONLY"
        : cappedScore < policy.caseConditionalMinimum
          ? "FAIL"
          : cappedScore < policy.casePassMinimum
            ? "PASS_WITH_WARNINGS"
            : "PASS";

  return {
    schemaVersion: "0.1.0",
    resultType: "case",
    targetId: testCase.targetId,
    caseId: testCase.id,
    caseHash: testCase.caseHash,
    contractHash: testCase.contractHash,
    templateId: testCase.templateId,
    title: testCase.title,
    runner: {
      name: runner.name,
      comparability: runner.comparability
    },
    score: cappedScore,
    rawScore,
    cappedScore,
    scoreCap,
    verdict,
    hardFailures,
    telemetryCompleteness: run.telemetryCompleteness,
    tokens: run.tokens,
    efficiency: { wallClockSeconds: run.wallClockSeconds },
    evaluationDimensions,
    scoreProvenance: {
      oracleResults: testCase.oracleIds.map((oracleId) => ({
        oracleId,
        status:
          hardFailures.length === 0 && !hasDiagnosticOnlyDimension
            ? "PASS"
            : "FAIL",
        why:
          hardFailures.length > 0
            ? hardFailures[0]!.why
            : hasDiagnosticOnlyDimension
              ? "Required evidence is incomplete; the oracle remains diagnostic-only."
              : "Required evidence was observed."
      })),
      dimensionProvenance: toDimensionProvenance(evaluationDimensions)
    }
  };
}

function getRunnerDiagnosticReason(run: CaseRun): string | undefined {
  const runnerResult = run.events.find((event) => event.type === "runner_result");
  const verdict = typeof runnerResult?.payload.verdict === "string" ? runnerResult.payload.verdict.toLowerCase() : undefined;
  if (!verdict || verdict === "pass" || verdict === "passed") {
    return undefined;
  }
  return verdict;
}

function hasAuthoritativeRunnerFailResult(
  run: CaseRun,
  runner: NonNullable<CaseRun["runner"]>
): boolean {
  return (
    runner.comparability.workflowScore === "comparable" &&
    run.events.some(
      (event) =>
        event.type === "runner_result" &&
        event.actor === "observer" &&
        event.payload.authoritative === true &&
        event.payload.observationLevel === "workflow_trace" &&
        typeof event.payload.verdict === "string" &&
        event.payload.verdict.toLowerCase() === "fail"
    )
  );
}

function hasRunnerFailure(run: CaseRun): boolean {
  return run.events.some((event) => {
    if (event.type !== "runner_exit") {
      return false;
    }
    if (event.payload.timedOut === true) {
      return true;
    }
    return typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0;
  });
}

export function scoreSuite(
  runId: string,
  contract: ContractModel,
  suite: string,
  caseResults: CaseResult[],
  evidenceContext?: SuiteEvidenceContext,
  gatePolicy: GatePolicy = loadCanonicalGatePolicy()
): SuiteResult {
  const policy = gatePolicy.rules.score;
  const rawSuiteScore = Math.round(avg(caseResults.map((result) => result.rawScore)));
  const cappedSuiteScore = Math.round(avg(caseResults.map((result) => result.cappedScore)));
  const telemetryCompleteness = Number(avg(caseResults.map((result) => result.telemetryCompleteness)).toFixed(2));
  const dimensionScores = aggregateDimensionScores(caseResults);
  const contractDiagnostics = statusMappingDiagnostics(contract);
  const recommendations = buildRecommendations(
    caseResults,
    dimensionScores,
    contractDiagnostics
  );
  const p0CaseRecords = buildP0CaseRecords(runId, contract, suite, caseResults);
  const hasHardFailure = caseResults.some((result) => result.hardFailures.length > 0);
  const hasCaseFailure = caseResults.some((result) => result.verdict === "FAIL");
  const hasContractMappingGap = contractDiagnostics.length > 0;
  const hasDiagnosticOnly = caseResults.length === 0 || caseResults.some((result) => result.verdict === "DIAGNOSTIC_ONLY");
  const hasNotComparableWorkflow = caseResults.some((result) => result.runner.comparability.workflowScore === "not_comparable");
  const evidenceCeilingRuleId = evidenceCeilingRuleIdFor(
    evidenceContext ?? inferSuiteEvidenceContext(caseResults)
  );
  const releaseDecision = hasHardFailure || hasCaseFailure
    ? "BLOCK"
    : hasContractMappingGap ||
        evidenceCeilingRuleId ||
        hasDiagnosticOnly ||
        hasNotComparableWorkflow ||
        telemetryCompleteness < gatePolicy.rules.telemetry.minimumCompleteness
      ? "DIAGNOSTIC_ONLY"
      : cappedSuiteScore >= policy.suiteApproveMinimum
        ? "APPROVE"
        : cappedSuiteScore >= policy.suiteConditionalMinimum
          ? "CONDITIONAL_APPROVE"
          : "BLOCK";
  return {
    schemaVersion: "0.1.0",
    resultType: "suite",
    targetId: contract.targetId,
    suite,
    runId,
    gatePolicy: gatePolicyBinding(gatePolicy),
    caseResults: caseResults.map((result) => ({
      caseId: result.caseId,
      verdict: result.verdict,
      rawScore: result.rawScore,
      cappedScore: result.cappedScore,
      hardFailures: result.hardFailures,
      tokens: result.tokens,
      efficiency: result.efficiency
    })),
    dimensionScores,
    recommendations,
    p0CaseRecords,
    contractDiagnostics,
    rawSuiteScore,
    cappedSuiteScore,
    releaseDecision,
    releaseRuleId: releaseRuleIdFor({
      releaseDecision,
      hasHardFailure,
      hasCaseFailure,
      hasContractMappingGap,
      evidenceCeilingRuleId,
      hasDiagnosticOnly,
      hasNotComparableWorkflow,
      telemetryCompleteness,
      telemetryMinimum: gatePolicy.rules.telemetry.minimumCompleteness
    }),
    telemetryCompleteness,
    debugHealth: {
      status: "NOT_RUN",
      mutationKillRate: null,
      falseNegativeCount: null,
      falsePositiveCount: null,
      environmentReproducibility: null,
      lastReverseValidationRunId: null,
      doesNotAffectTargetScore: true
    }
  };
}

function releaseRuleIdFor(options: {
  releaseDecision: SuiteResult["releaseDecision"];
  hasHardFailure: boolean;
  hasCaseFailure: boolean;
  hasContractMappingGap: boolean;
  evidenceCeilingRuleId?: string;
  hasDiagnosticOnly: boolean;
  hasNotComparableWorkflow: boolean;
  telemetryCompleteness: number;
  telemetryMinimum: number;
}): string {
  if (options.hasHardFailure) {
    return "REL-P0-WORKFLOW-HARD-FAIL";
  }
  if (options.hasCaseFailure) {
    return "REL-CASE-FAILED";
  }
  if (options.hasContractMappingGap) {
    return "REL-CONTRACT-MAPPING-MISSING";
  }
  if (options.evidenceCeilingRuleId) {
    return options.evidenceCeilingRuleId;
  }
  if (options.hasDiagnosticOnly) {
    return "REL-DIAGNOSTIC-CASE";
  }
  if (options.hasNotComparableWorkflow) {
    return "REL-RUNNER-NOT-COMPARABLE";
  }
  if (options.telemetryCompleteness < options.telemetryMinimum) {
    return "REL-TELEMETRY-DIAGNOSTIC";
  }
  if (options.releaseDecision === "APPROVE") {
    return "REL-APPROVE";
  }
  if (options.releaseDecision === "CONDITIONAL_APPROVE") {
    return "REL-CONDITIONAL";
  }
  return "REL-BLOCK-LOW-SCORE";
}

function inferSuiteEvidenceContext(caseResults: CaseResult[]): SuiteEvidenceContext {
  if (caseResults.length === 0) {
    return {
      evidenceKind: "unknown",
      observationLevel: "capability_only"
    };
  }
  const runnerNames = new Set(caseResults.map((result) => result.runner.name));
  if (runnerNames.size === 1 && runnerNames.has("simulated")) {
    return {
      evidenceKind: "simulated",
      observationLevel: "synthetic_events"
    };
  }
  if (!runnerNames.has("simulated")) {
    return {
      evidenceKind: "live",
      observationLevel: "contract_summary"
    };
  }
  return {
    evidenceKind: "unknown",
    observationLevel: "capability_only"
  };
}

function evidenceCeilingRuleIdFor(context: SuiteEvidenceContext): string | undefined {
  const requirement = getEvaluationContract().evidencePolicy.truePassRequires;
  if (
    context.evidenceKind === requirement.evidenceKind &&
    context.observationLevel === requirement.observationLevel &&
    context.observerQualification === requirement.observerQualification
  ) {
    return undefined;
  }
  if (context.observationLevel === "workflow_trace") {
    return context.observerQualification === "invalid"
      ? "REL-OBSERVER-QUALIFICATION-INVALID"
      : "REL-OBSERVER-QUALIFICATION-MISSING";
  }
  if (context.observationLevel === "contract_summary") {
    return "REL-EVIDENCE-CONTRACT-SUMMARY";
  }
  if (context.observationLevel === "synthetic_events") {
    return "REL-EVIDENCE-SIMULATED";
  }
  if (context.observationLevel === "capability_only") {
    return "REL-EVIDENCE-CAPABILITY-ONLY";
  }
  return "REL-EVIDENCE-MISSING";
}

function evaluateCaseDimensions(
  testCase: BenchmarkCase,
  run: CaseRun,
  hardFailures: HardFailure[],
  runnerDimension: { status: EvaluationStatus; why: string },
  policyRules: GatePolicyRules,
  contract?: ContractModel
): CaseEvaluationDimension[] {
  const hardFailureCodes = new Set(hardFailures.map((failure) => failure.code));
  const byCode = (code: string) => hardFailures.filter((failure) => failure.code === code);
  const hasEvent = (type: CaseRun["events"][number]["type"]) => run.events.some((event) => event.type === type);
  const eventIds = (type: CaseRun["events"][number]["type"]) => run.events.filter((event) => event.type === type).map((event) => event.eventId);
  const dimensions: CaseEvaluationDimension[] = [];

  const add = (
    dimensionName: EvaluationDimension,
    points: number,
    status: EvaluationStatus,
    why: string,
    evidenceEventIds: string[] = [],
    relatedFailureCodes: string[] = []
  ) => {
    dimensions.push({
      dimension: dimensionName,
      rawPoints: points,
      maxPoints: 100,
      score: points,
      status,
      why,
      evidenceEventIds,
      relatedFailureCodes
    });
  };

  add(
    "contract",
    hardFailures.length > 0 ? 0 : 100,
    hardFailures.length > 0 ? "FAIL" : "PASS",
    hardFailures.length > 0 ? "One or more hard contract failures were observed." : "No hard contract failure was observed.",
    hardFailures.flatMap((failure) => failure.evidenceEventIds),
    [...hardFailureCodes]
  );

  addFailureDimension(
    add,
    "routing",
    byCode("TARGET_ROUTE_FORBIDDEN"),
    "Forbidden routing was observed.",
    "No forbidden routing hard failure was observed."
  );
  addFailureDimension(
    add,
    "ownership",
    byCode("TARGET_OWNER_BYPASS"),
    "A declared owner boundary was bypassed.",
    "Owner routing evidence did not produce an owner bypass hard failure."
  );
  const gateFailures = byCode("GATE_FALSE_PASS");
  const requiredStatusCode = testCase.bindings.statusCode;
  const requiredStatusScope = testCase.bindings.statusScope;
  const unscopedStatusSemantic =
    requiredStatusCode && contract
      ? resolveStatusSemantic(contract, requiredStatusCode)
      : undefined;
  const unscopedStatusIsUnambiguous =
    Boolean(requiredStatusScope) &&
    unscopedStatusSemantic?.scope === requiredStatusScope;
  const matchingGateEvents = run.events.filter(
    (event) =>
      event.type === "gate_decision" &&
      (!requiredStatusCode || event.payload.status === requiredStatusCode) &&
      (!requiredStatusScope ||
        event.payload.scope === requiredStatusScope ||
        (event.payload.scope === undefined && unscopedStatusIsUnambiguous))
  );
  const gateApplies =
    Boolean(requiredStatusCode) ||
    testCase.templateId === "skip-not-pass" ||
    gateFailures.length > 0 ||
    hasEvent("gate_decision");
  if (gateFailures.length > 0) {
    add(
      "gate",
      0,
      "FAIL",
      "A non-pass semantic status was promoted to pass-class through a transition the owner-reviewed mapping does not allow.",
      gateFailures.flatMap((failure) => failure.evidenceEventIds),
      [...new Set(gateFailures.map((failure) => failure.code))]
    );
  } else if (requiredStatusCode && matchingGateEvents.length === 0) {
    add(
      "gate",
      0,
      "DIAGNOSTIC_ONLY",
      `Required gate status ${requiredStatusCode}${
        requiredStatusScope ? ` in scope ${requiredStatusScope}` : ""
      } was not observed.`,
      []
    );
  } else {
    add(
      "gate",
      !gateApplies || hasEvent("gate_decision") ? 100 : 70,
      !gateApplies || hasEvent("gate_decision") ? "PASS" : "WARN",
      !gateApplies
        ? "No gate assertion applies to this case."
        : hasEvent("gate_decision")
          ? "Gate decision evidence was observed without a false-pass hard failure."
          : "No gate decision event was observed.",
      matchingGateEvents.length > 0
        ? matchingGateEvents.map((event) => event.eventId)
        : eventIds("gate_decision")
    );
  }
  const artifactFailures = byCode("ARTIFACT_PATH_DRIFT");
  const artifactApplies =
    Boolean(testCase.bindings.artifactPath) ||
    artifactFailures.length > 0 ||
    hasEvent("artifact_write");
  addFailureDimension(
    add,
    "artifact",
    artifactFailures,
    "A required artifact was written to the wrong path.",
    !artifactApplies
      ? "No artifact assertion applies to this case."
      : hasEvent("artifact_write")
        ? "Artifact write evidence was observed at the declared path."
        : "No artifact write event was observed.",
    !artifactApplies || hasEvent("artifact_write") ? 100 : 70,
    !artifactApplies || hasEvent("artifact_write") ? "PASS" : "WARN",
    eventIds("artifact_write")
  );
  const requiredStatePath = testCase.bindings.statePath;
  const matchingStateEvents = run.events.filter(
    (event) =>
      event.type === "state_read" &&
      (!requiredStatePath || event.payload.path === requiredStatePath)
  );
  add(
    "state",
    requiredStatePath && matchingStateEvents.length === 0 ? 0 : 100,
    requiredStatePath && matchingStateEvents.length === 0 ? "DIAGNOSTIC_ONLY" : "PASS",
    requiredStatePath
      ? matchingStateEvents.length > 0
        ? "Required state-read evidence was observed at the declared path."
        : "Required state-read evidence is missing or does not match the declared path."
      : "No state-read assertion applies to this case.",
    matchingStateEvents.map((event) => event.eventId)
  );
  addFailureDimension(
    add,
    "join",
    byCode("TARGET_JOIN_MISSING"),
    "A required join or callback was missing before downstream work.",
    testCase.bindings.joinId
      ? "No missing join hard failure was observed for the declared join binding."
      : "No join binding applies to this case."
  );
  const sideEffectFailures = hardFailures.filter(
    (failure) =>
      failure.code === "PRODUCTION_SIDE_EFFECT" ||
      failure.code === "SECRET_LEAK"
  );
  addFailureDimension(
    add,
    "sideEffect",
    sideEffectFailures,
    sideEffectFailures.some((failure) => failure.code === "SECRET_LEAK")
      ? "Sensitive information reached a public evaluation artifact."
      : "A production side effect was allowed or not denied.",
    "No unsafe production side effect or sensitive leakage was observed.",
    100,
    "PASS",
    eventIds("side_effect_attempt")
  );

  const telemetryScore = Math.max(0, Math.min(100, Math.round(run.telemetryCompleteness * 100)));
  const telemetryFailures = hardFailures.filter((failure) =>
    [
      "TRACE_EVENT_MISSING",
      "TRACE_EVENT_ORDER_INVALID",
      "TELEMETRY_MISSING",
      "TOKEN_LEDGER_MISSING"
    ].includes(failure.code)
  );
  add(
    "telemetry",
    telemetryFailures.length > 0 ? 0 : telemetryScore,
    telemetryFailures.some((failure) => failure.severity === "P0")
      ? "FAIL"
      : telemetryFailures.length > 0
        ? "WARN"
        : telemetryScore >= 80
          ? "PASS"
          : telemetryScore >= 60
            ? "WARN"
            : "FAIL",
    telemetryFailures.length > 0
      ? `Telemetry evidence produced ${telemetryFailures.map((failure) => failure.code).join(", ")}.`
      : telemetryScore >= 80
        ? "Telemetry completeness is sufficient for scoring."
        : "Telemetry completeness is too low for high-confidence workflow scoring.",
    telemetryFailures.length > 0
      ? telemetryFailures.flatMap((failure) => failure.evidenceEventIds)
      : eventIds("token_usage"),
    telemetryFailures.map((failure) => failure.code)
  );

  const tokenBudget = testCase.budgets.tokenTotal;
  const wallClockBudget = testCase.budgets.wallClockSeconds;
  const wastedRatio = run.tokens.total > 0 ? run.tokens.wasted / run.tokens.total : 0;
  const overBudget =
    run.tokens.total >
      tokenBudget * policyRules.budget.maximumTokenBudgetRatio ||
    run.wallClockSeconds >
      wallClockBudget * policyRules.budget.maximumWallClockBudgetRatio;
  const inefficient =
    wastedRatio > policyRules.budget.wastedRatioWarning;
  add(
    "efficiency",
    overBudget ? 45 : inefficient ? 80 : 100,
    overBudget ? "FAIL" : inefficient ? "WARN" : "PASS",
    overBudget
      ? "Run exceeded the declared token or wall-clock budget."
      : inefficient
        ? `Run stayed within budget but wasted-token ratio exceeded ${Math.round(
            policyRules.budget.wastedRatioWarning * 100
          )}%.`
        : "Run stayed within declared token and wall-clock budgets.",
    eventIds("token_usage")
  );

  add(
    "runner",
    hardFailureCodes.has("OBSERVER_EVENT_FORGED")
      ? 0
      : runnerDimension.status === "PASS"
        ? 100
        : 0,
    hardFailureCodes.has("OBSERVER_EVENT_FORGED") ? "FAIL" : runnerDimension.status,
    hardFailureCodes.has("OBSERVER_EVENT_FORGED")
      ? "Runner-originated evidence was represented as independent observer evidence."
      : runnerDimension.why,
    hardFailureCodes.has("OBSERVER_EVENT_FORGED")
      ? byCode("OBSERVER_EVENT_FORGED").flatMap((failure) => failure.evidenceEventIds)
      : run.events.filter((event) => event.type === "runner_result" || event.type === "runner_exit").map((event) => event.eventId),
    hardFailureCodes.has("OBSERVER_EVENT_FORGED") ? ["OBSERVER_EVENT_FORGED"] : []
  );

  return dimensions;
}

function addFailureDimension(
  add: (
    dimensionName: EvaluationDimension,
    points: number,
    status: EvaluationStatus,
    why: string,
    evidenceEventIds?: string[],
    relatedFailureCodes?: string[]
  ) => void,
  dimensionName: EvaluationDimension,
  failures: HardFailure[],
  failureWhy: string,
  passWhy: string,
  passPoints = 100,
  passStatus: EvaluationStatus = "PASS",
  passEvidenceEventIds: string[] = []
): void {
  if (failures.length > 0) {
    add(dimensionName, 0, "FAIL", failureWhy, failures.flatMap((failure) => failure.evidenceEventIds), [...new Set(failures.map((failure) => failure.code))]);
    return;
  }
  add(dimensionName, passPoints, passStatus, passWhy, passEvidenceEventIds);
}

function toDimensionProvenance(dimensions: CaseEvaluationDimension[]): CaseResult["scoreProvenance"]["dimensionProvenance"] {
  return dimensions.map((dimension) => ({
    dimension: dimension.dimension,
    rawPoints: dimension.rawPoints,
    maxPoints: dimension.maxPoints,
    status: dimension.status,
    why: dimension.why
  }));
}

function aggregateDimensionScores(caseResults: CaseResult[]): SuiteDimensionScore[] {
  const dimensionOrder = getImplementedDimensions().map(
    (dimension) => dimension.id as EvaluationDimension
  );
  return dimensionOrder.flatMap((dimension) => {
    const entries = caseResults.flatMap((result) => result.evaluationDimensions.filter((item) => item.dimension === dimension).map((item) => ({ result, item })));
    if (entries.length === 0) {
      return [];
    }
    const rawPoints = Math.round(avg(entries.map((entry) => entry.item.rawPoints)));
    const maxPoints = Math.round(avg(entries.map((entry) => entry.item.maxPoints)));
    const score = Math.round(avg(entries.map((entry) => entry.item.score)));
    const status = aggregateStatus(entries.map((entry) => entry.item.status), score);
    const affectedCaseIds = entries.filter((entry) => entry.item.status !== "PASS").map((entry) => entry.result.caseId);
    const failingCodes = [...new Set(entries.flatMap((entry) => entry.item.relatedFailureCodes))];
    return [
      {
        dimension,
        rawPoints,
        maxPoints,
        score,
        status,
        affectedCaseIds,
        why:
          failingCodes.length > 0
            ? `Observed ${failingCodes.join(", ")} in ${affectedCaseIds.length} case(s).`
            : status === "PASS"
              ? "All evaluated cases passed this dimension."
              : `${affectedCaseIds.length} case(s) need attention in this dimension.`
      }
    ];
  });
}

function weightedDimensionAverage(
  dimensions: CaseEvaluationDimension[],
  dimensionWeights: GatePolicyRules["dimensionWeights"]
): number {
  const implemented = new Set(
    getImplementedDimensions().map((dimension) => dimension.id)
  );
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const dimension of dimensions) {
    const weight = dimensionWeights[dimension.dimension];
    if (!implemented.has(dimension.dimension) || weight === undefined) {
      throw new Error(
        `Evaluation dimension ${dimension.dimension} is not implemented by the canonical registry.`
      );
    }
    weightedTotal += dimension.score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedTotal / totalWeight;
}

function aggregateStatus(statuses: EvaluationStatus[], score: number): EvaluationStatus {
  if (statuses.includes("FAIL")) {
    return "FAIL";
  }
  if (statuses.includes("DIAGNOSTIC_ONLY")) {
    return "DIAGNOSTIC_ONLY";
  }
  if (statuses.includes("WARN") || score < 85) {
    return "WARN";
  }
  return "PASS";
}

function buildRecommendations(
  caseResults: CaseResult[],
  dimensionScores: SuiteDimensionScore[],
  contractDiagnostics: ReturnType<typeof statusMappingDiagnostics>
): AgentWorkflowRecommendation[] {
  const recommendations = new Map<string, AgentWorkflowRecommendation>();
  for (const result of caseResults) {
    for (const failure of result.hardFailures) {
      const recommendation = recommendationForFailure(failure.code, result, failure);
      const existing = recommendations.get(recommendation.id);
      if (existing) {
        existing.evidenceCaseIds = [...new Set([...existing.evidenceCaseIds, ...recommendation.evidenceCaseIds])].sort();
      } else {
        recommendations.set(recommendation.id, recommendation);
      }
    }
  }

  for (const dimension of dimensionScores) {
    if (dimension.status === "PASS" || dimension.affectedCaseIds.length === 0) {
      continue;
    }
    if ([...recommendations.values()].some((recommendation) => recommendation.evidenceCaseIds.some((caseId) => dimension.affectedCaseIds.includes(caseId)))) {
      continue;
    }
    const recommendation = recommendationForDimension(dimension);
    recommendations.set(recommendation.id, recommendation);
  }

  if (contractDiagnostics.length > 0) {
    recommendations.set("contract-status-semantics", {
      id: "contract-status-semantics",
      priority: "P1",
      category: "contract",
      summary: "Status semantics mapping is missing or invalid.",
      suggestedChange:
        "Add an owner-reviewed statusSemantics mapping for every declared status, including scope, semantic class, blocking/terminal flags, and allowed transitions.",
      evidenceCaseIds: [],
      sourceFailureCodes: ["CONTRACT_MAPPING_MISSING"],
      targetRoles: []
    });
  }

  return [...recommendations.values()].sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.id.localeCompare(right.id));
}

function recommendationForFailure(code: string, result: CaseResult, failure: HardFailure): AgentWorkflowRecommendation {
  const mapped = failureRecommendation(code);
  return {
    id: `${mapped.category}-${code.toLowerCase()}`,
    priority: failure.severity,
    category: mapped.category,
    summary: mapped.summary,
    suggestedChange: mapped.suggestedChange,
    evidenceCaseIds: [result.caseId],
    sourceFailureCodes: [code],
    targetRoles: []
  };
}

function recommendationForDimension(dimension: SuiteDimensionScore): AgentWorkflowRecommendation {
  const category = dimension.dimension === "runner" ? "runner-evidence" : dimension.dimension === "sideEffect" ? "side-effect" : dimension.dimension;
  const priority = dimension.status === "FAIL" ? "P1" : "P2";
  return {
    id: `${category}-${dimension.status.toLowerCase()}`,
    priority,
    category,
    summary: `${dimension.dimension} dimension needs attention.`,
    suggestedChange: recommendationForSoftDimension(dimension.dimension),
    evidenceCaseIds: dimension.affectedCaseIds,
    sourceFailureCodes: [],
    targetRoles: []
  };
}

function failureRecommendation(code: string): Pick<AgentWorkflowRecommendation, "category" | "summary" | "suggestedChange"> {
  const map: Record<string, Pick<AgentWorkflowRecommendation, "category" | "summary" | "suggestedChange">> = {
    TARGET_ROUTE_FORBIDDEN: {
      category: "routing",
      summary: "Forbidden workflow route was observed.",
      suggestedChange: "Remove forbidden direct routing and send work through the declared owner or an allowed dispatch boundary."
    },
    TARGET_OWNER_BYPASS: {
      category: "ownership",
      summary: "Declared owner boundary was bypassed.",
      suggestedChange: "Route owner-scoped work to the role declared in requiredOwners before allowing completion evidence."
    },
    GATE_FALSE_PASS: {
      category: "gate",
      summary: "Gate status semantics were weakened.",
      suggestedChange: "Preserve each raw status and allow pass-class promotion only through an owner-reviewed transition."
    },
    ARTIFACT_PATH_DRIFT: {
      category: "artifact",
      summary: "Required artifact was written to a non-canonical path.",
      suggestedChange: "Write the workflow evidence to the artifact path declared in the target pack and keep aliases read-only."
    },
    TARGET_JOIN_MISSING: {
      category: "join",
      summary: "Required join or callback was skipped before downstream work.",
      suggestedChange: "Require the producer callback artifact before dispatching the consumer or QA execution stage."
    },
    PRODUCTION_SIDE_EFFECT: {
      category: "side-effect",
      summary: "Unsafe external side effect was allowed.",
      suggestedChange: "Deny and record production writes during evaluation; move real deployment or publish actions behind explicit approval."
    }
  };
  return (
    map[code] ?? {
      category: "contract",
      summary: `Hard failure ${code} was observed.`,
      suggestedChange: "Repair the target workflow contract violation and rerun the benchmark case."
    }
  );
}

function recommendationForSoftDimension(dimension: EvaluationDimension): string {
  const map: Record<EvaluationDimension, string> = {
    contract: "Review hard-failure evidence and align the workflow with the declared ContractModel.",
    routing: "Make routing decisions explicit and record handoff evidence for every owner boundary.",
    ownership: "Ensure owner-scoped work is completed by the declared owner role.",
    gate: "Emit structured gate decisions and preserve raw codes with their non-pass semantic classes.",
    artifact: "Write required evidence to the canonical artifact paths declared by the target pack.",
    state: "Read the declared workflow state before repeated or recovery work and emit state-read evidence.",
    join: "Record producer-to-consumer callbacks before downstream execution.",
    sideEffect: "Record denied side-effect attempts and keep evaluation runs isolated from production writes.",
    telemetry: "Emit complete token, runner, and case-end telemetry for every benchmark case.",
    efficiency: "Reduce repeated loops, unused tool calls, and wasted tokens while staying within workflow budgets.",
    runner: "Collect comparable runner verdicts and exit evidence before making release decisions."
  };
  return map[dimension];
}

function buildP0CaseRecords(runId: string, contract: ContractModel, suite: string, caseResults: CaseResult[]): P0CaseRecord[] {
  return caseResults.flatMap((result) =>
    result.hardFailures
      .filter((failure) => failure.severity === "P0")
      .map((failure) => ({
        schemaVersion: "0.1.0",
        recordedAt: new Date().toISOString(),
        targetId: contract.targetId,
        suite,
        runId,
        caseId: result.caseId,
        caseHash: result.caseHash,
        contractHash: result.contractHash,
        templateId: result.templateId,
        title: result.title,
        failureCode: failure.code,
        severity: "P0" as const,
        why: failure.why,
        evidenceEventIds: failure.evidenceEventIds,
        recommendedAction: failureRecommendation(failure.code).suggestedChange
      }))
  );
}

function priorityRank(priority: AgentWorkflowRecommendation["priority"]): number {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function collectHardFailures(
  run: CaseRun,
  contract?: ContractModel
): HardFailure[] {
  const failures = new Map<string, HardFailure>();
  const addFailure = (definition: ReturnType<typeof requiredHardFailureDefinition>, eventIds: string[]) => {
    const existing = failures.get(definition.code);
    if (existing) {
      existing.evidenceEventIds = [...new Set([...existing.evidenceEventIds, ...eventIds])];
      return;
    }
    failures.set(definition.code, {
      code: definition.code,
      severity: definition.severity,
      why: definition.why,
      evidenceEventIds: eventIds
    });
  };
  for (const event of run.events) {
    if (event.type === "hard_failure" && typeof event.payload.code === "string") {
      const benchmarkOwned =
        event.actor === "benchmark" &&
        (!run.runner || run.runner.name === "simulated");
      const observerOwned =
        event.actor === "observer" &&
        (!run.runner ||
          run.runner.comparability.workflowScore === "comparable");
      if (!benchmarkOwned && !observerOwned) {
        continue;
      }
      const definition =
        getHardFailureDefinition(event.payload.code) ??
        requiredHardFailureDefinition("UNREGISTERED_HARD_FAILURE");
      const sourceEventIds = Array.isArray(event.payload.evidenceEventIds)
        ? event.payload.evidenceEventIds.filter(
            (eventId): eventId is string => typeof eventId === "string"
          )
        : [];
      addFailure(definition, sourceEventIds.length > 0 ? sourceEventIds : [event.eventId]);
    }
    if (
      event.type === "side_effect_attempt" &&
      event.payload.classifiedAs === "external_write" &&
      (event.payload.allowed === true || event.payload.policyDecision !== "deny")
    ) {
      const definition = requiredHardFailureDefinition("PRODUCTION_SIDE_EFFECT");
      addFailure(definition, [event.eventId]);
    }
    if (
      contract &&
      event.type === "gate_decision" &&
      isFalsePassTransition(contract, event.payload)
    ) {
      const definition = requiredHardFailureDefinition("GATE_FALSE_PASS");
      addFailure(definition, [event.eventId]);
    }
  }
  return [...failures.values()];
}

function requiredHardFailureDefinition(code: string) {
  const definition = getHardFailureDefinition(code);
  if (!definition) {
    throw new Error(`Canonical hard-failure registry is missing implemented code ${code}.`);
  }
  return definition;
}

function runnerForRun(run: CaseRun): NonNullable<CaseRun["runner"]> {
  return (
    run.runner ?? {
      name: "simulated",
      comparability: {
        workflowScore: "not_comparable",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    }
  );
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
