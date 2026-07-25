import { getImplementedOracles } from "../evaluation/evaluationContract.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { publicAiCasePlan } from "../utils/redaction.js";
import { normalizeCaseId } from "./caseIds.js";
import { normalizeAiCasePlanBindings, validateAiCasePlan } from "./coverage.js";
export function materializeSmokeSuite(contract, options = {}) {
    const suiteName = options.suite ?? "smoke";
    const templates = getImplementedOracles();
    const cases = templates.map((oracle, index) => makeCase(contract, suiteName, oracle.templateId, oracle.title, oracle.expectedHardFailures, index + 1, oracle.id));
    return {
        suite: suiteName,
        targetId: contract.targetId,
        cases,
        applicability: templates.map((oracle) => ({
            templateId: oracle.templateId,
            status: "materialized"
        })),
        manifest: {
            schemaVersion: "0.1.0",
            targetId: contract.targetId,
            suite: suiteName,
            contractHash: contract.contractHash,
            generatedAt: new Date(0).toISOString(),
            caseIds: cases.map((testCase) => testCase.id)
        }
    };
}
export function materializeAiSuite(contract, options) {
    const suiteName = options.suite ?? "smoke";
    const normalizedPlan = publicAiCasePlan(normalizeAiCasePlanBindings(options.plan, contract), { values: options.sensitiveValues });
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
            status: "materialized",
            reason: testCase.generation?.riskFocus
        })),
        manifest: {
            schemaVersion: "0.1.0",
            targetId: contract.targetId,
            suite: suiteName,
            contractHash: contract.contractHash,
            generatedAt: new Date(0).toISOString(),
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
function makeCase(contract, suite, templateId, title, expectedHardFailures, index, oracleId) {
    const primaryRole = contract.roles[0]?.id ?? "agent";
    const owner = Object.values(contract.requiredOwners)[0] ?? primaryRole;
    const join = contract.joins[0];
    const artifact = contract.artifacts[0];
    const state = contract.states[0];
    const id = `${contract.targetId}-smoke-${String(index).padStart(3, "0")}-${templateId}`;
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
            joinId: join?.id ?? "not-applicable",
            artifactPath: artifact?.path ?? "deliverables/output.md",
            ...(templateId === "state-recovery" && state ? { statePath: state.path } : {})
        },
        budgets: contract.budgets
    };
    return {
        ...base,
        caseHash: sha256Text(stableJson(base))
    };
}
function makeAiCase(contract, suite, plan, draft, index) {
    const primaryRole = draft.bindings?.primaryRole ?? contract.roles[0]?.id ?? "agent";
    const owner = draft.bindings?.owner ?? Object.values(contract.requiredOwners)[0] ?? primaryRole;
    const join = contract.joins[0];
    const artifact = contract.artifacts[0];
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
            `Operation sequence: ${draft.operationSequence.join(" -> ")}`
        ].join("\n"),
        bindings: {
            primaryRole,
            owner,
            joinId: draft.bindings?.joinId ?? join?.id ?? "not-applicable",
            artifactPath: draft.bindings?.artifactPath ?? artifact?.path ?? "deliverables/output.md",
            ...draft.bindings
        },
        budgets: contract.budgets,
        generation: {
            mode: "ai-first",
            planner: plan.planner,
            model: plan.model,
            targetUnderstanding: plan.targetUnderstanding,
            riskFocus: draft.riskFocus,
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
