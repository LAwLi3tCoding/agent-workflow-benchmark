import type { AiCasePlan, BenchmarkCase, ContractModel, MaterializedSuite } from "../core/types.js";
import {
  getImplementedOracles,
  getReliabilityPolicy
} from "../evaluation/evaluationContract.js";
import {
  scopesWithPassAndNonPassSemantics
} from "../evaluation/statusSemantics.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { publicAiCasePlan } from "../utils/redaction.js";
import { normalizeCaseId } from "./caseIds.js";
import { normalizeAiCasePlanBindings, validateAiCasePlan } from "./coverage.js";

const safetyCategories = [
  "prompt-injection",
  "objective-hijack",
  "tool-chain-escalation",
  "handoff-delay-trigger",
  "memory-poison",
  "unsafe-recovery"
] as const;

export function materializeSmokeSuite(
  contract: ContractModel,
  options: { suite?: string; seed?: string } = {}
): MaterializedSuite {
  const suiteName = options.suite ?? "smoke";
  const seed = options.seed ?? getReliabilityPolicy().defaultSeed;
  const templates = getImplementedOracles();
  const applicability = templates.map((oracle) => ({
    templateId: oracle.templateId,
    ...oracleApplicability(contract, oracle.templateId)
  }));
  const cases = templates.flatMap((oracle, index) => {
    if (applicability[index]!.status !== "materialized") {
      return [];
    }
    const statusScopes =
      oracle.templateId === "skip-not-pass"
        ? scopesWithPassAndNonPassSemantics(contract)
        : [undefined];
    return statusScopes.map((statusScope) =>
      makeCase(
        contract,
        suiteName,
        oracle.templateId,
        oracle.title,
        oracle.expectedHardFailures,
        index + 1,
        oracle.id,
        statusScope,
        statusScopes.length > 1
      )
    );
  });
  return {
    suite: suiteName,
    targetId: contract.targetId,
    cases,
    applicability,
    manifest: {
      schemaVersion: "0.1.0",
      artifactType: "generation_manifest",
      targetId: contract.targetId,
      suite: suiteName,
      contractHash: contract.contractHash,
      generatedAt: new Date(0).toISOString(),
      seed,
      caseIds: cases.map((testCase) => testCase.id)
    }
  };
}

export function materializeAiSuite(
  contract: ContractModel,
  options: {
    planner: string;
    model?: string;
    plan: AiCasePlan;
    suite?: string;
    seed?: string;
    sensitiveValues?: string[];
  }
): MaterializedSuite {
  const suiteName = options.suite ?? "smoke";
  const seed = options.seed ?? getReliabilityPolicy().defaultSeed;
  const normalizedPlan = publicAiCasePlan(
    normalizeAiCasePlanBindings(options.plan, contract),
    { values: options.sensitiveValues }
  );
  const validation = validateAiCasePlan(normalizedPlan, contract);
  if (validation.invalidBindings.length > 0) {
    throw new Error(`AI case plan has invalid ContractModel bindings: ${validation.invalidBindings.map((item) => `${item.caseId}.${item.field}=${item.value}`).join(", ")}`);
  }
  const cases = normalizedPlan.cases.map((draft, index) => makeAiCase(contract, suiteName, normalizedPlan, draft, index + 1));
  return {
    suite: suiteName,
    targetId: contract.targetId,
    cases,
    applicability: cases.map((testCase) => ({
      templateId: testCase.templateId,
      status: "materialized" as const,
      reason: testCase.generation?.riskFocus
    })),
    manifest: {
      schemaVersion: "0.1.0",
      artifactType: "generation_manifest",
      targetId: contract.targetId,
      suite: suiteName,
      contractHash: contract.contractHash,
      generatedAt: new Date(0).toISOString(),
      seed,
      caseIds: cases.map((testCase) => testCase.id),
      generation: {
        mode: "ai-first",
        planner: options.planner,
        model: options.model,
        targetUnderstanding: normalizedPlan.targetUnderstanding,
        validation
      }
    }
  };
}

function makeCase(
  contract: ContractModel,
  suite: string,
  templateId: string,
  title: string,
  expectedHardFailures: readonly string[],
  index: number,
  oracleId: string,
  statusScope?: string,
  qualifyStatusScope = false
): BenchmarkCase {
  const primaryRole = contract.roles[0]?.id ?? "agent";
  const owner = Object.values(contract.requiredOwners)[0] ?? primaryRole;
  const join = contract.joins[0];
  const artifact = contract.artifacts[0];
  const state = contract.states[0];
  const statusCode = statusScope
    ? (contract.statusSemantics ?? []).find(
        (mapping) =>
          mapping.scope === statusScope && mapping.semanticClass === "pass"
      )?.code
    : undefined;
  const id = `${contract.targetId}-smoke-${String(index).padStart(3, "0")}-${templateId}${
    qualifyStatusScope && statusScope ? `-${normalizeCaseId(statusScope)}` : ""
  }`;
  const safety = safetyMetadata(templateId);
  const base = {
    schemaVersion: "0.1.0",
    id,
    targetId: contract.targetId,
    suite,
    templateId,
    title,
    contractHash: contract.contractHash,
    oracleIds: [oracleId],
    expectedHardFailures: [...expectedHardFailures],
    prompt: `Evaluate ${contract.targetId} with smoke template ${templateId}.`,
    bindings: {
      primaryRole,
      owner,
      ...(safety ? {
        safetyCategory: safety.category,
        safetyControl: String(safety.control)
      } : {}),
      ...(templateId === "required-join" && join
        ? { joinId: join.id }
        : {}),
      ...(artifact ? { artifactPath: artifact.path } : {}),
      ...(templateId === "state-recovery" && state ? { statePath: state.path } : {}),
      ...(statusCode ? { statusCode } : {}),
      ...(statusScope ? { statusScope } : {})
    },
    budgets: contract.budgets
  };
  return {
    ...base,
    caseHash: sha256Text(stableJson(base))
  };
}

function oracleApplicability(
  contract: ContractModel,
  templateId: string
): {
  status: "materialized" | "notApplicable";
  reason?: string;
} {
  const unavailable = (reason: string) => ({
    status: "notApplicable" as const,
    reason
  });
  if (
    templateId === "forbidden-route" &&
    contract.routing.forbidden.length === 0
  ) {
    return unavailable("The target declares no forbidden routes.");
  }
  if (templateId === "required-join" && contract.joins.length === 0) {
    return unavailable("The target declares no required joins.");
  }
  if (templateId === "role-boundary" && contract.roles.length < 2) {
    return unavailable("The target has no cross-role boundary.");
  }
  if (templateId === "state-recovery" && contract.states.length === 0) {
    return unavailable("The target declares no recoverable state.");
  }
  if (templateId === "skip-not-pass" && !hasPassAndNonPassSemantics(contract)) {
    return unavailable(
      "The target has no complete pass/non-pass status semantics for one gate scope."
    );
  }
  return { status: "materialized" };
}

function safetyMetadata(templateId: string): { category: string; control: boolean } | undefined {
  for (const category of safetyCategories) {
    if (templateId === `safety-${category}-probe`) {
      return { category, control: false };
    }
    if (templateId === `safety-${category}-control`) {
      return { category, control: true };
    }
  }
  return undefined;
}

function hasPassAndNonPassSemantics(contract: ContractModel): boolean {
  return scopesWithPassAndNonPassSemantics(contract).length > 0;
}

function makeAiCase(contract: ContractModel, suite: string, plan: AiCasePlan, draft: AiCasePlan["cases"][number], index: number): BenchmarkCase {
  const primaryRole = draft.bindings?.primaryRole ?? contract.roles[0]?.id ?? "agent";
  const owner = draft.bindings?.owner ?? Object.values(contract.requiredOwners)[0] ?? primaryRole;
  const templateId = `ai-${normalizeCaseId(draft.id)}`;
  const id = `${contract.targetId}-ai-${String(index).padStart(3, "0")}-${normalizeCaseId(draft.id)}`;
  const base = {
    schemaVersion: "0.1.0",
    id,
    targetId: contract.targetId,
    suite,
    templateId,
    title: draft.title,
    contractHash: contract.contractHash,
    oracleIds: draft.oracleIds,
    expectedHardFailures: draft.expectedHardFailures,
    prompt: [
      `Use AI-first benchmark case ${draft.id} for ${contract.targetId}.`,
      `Target understanding: ${plan.targetUnderstanding}`,
      `Risk focus: ${draft.riskFocus}`,
      ...(draft.referenceOutcome ? [`Reference outcome: ${draft.referenceOutcome}`] : []),
      ...(draft.counterexampleOutcome ? [`Counterexample outcome: ${draft.counterexampleOutcome}`] : []),
      `Operation sequence: ${draft.operationSequence.join(" -> ")}`
    ].join("\n"),
    bindings: {
      primaryRole,
      owner,
      ...draft.bindings
    },
    budgets: contract.budgets,
    generation: {
      mode: "ai-first" as const,
      planner: plan.planner,
      model: plan.model,
      targetUnderstanding: plan.targetUnderstanding,
      riskFocus: draft.riskFocus,
      referenceOutcome: draft.referenceOutcome,
      counterexampleOutcome: draft.counterexampleOutcome,
      operationSequence: draft.operationSequence,
      coverageTags: draft.coverageTags,
      scoringRubric: draft.scoringRubric
    }
  };
  return {
    ...base,
    caseHash: sha256Text(stableJson(base))
  };
}
