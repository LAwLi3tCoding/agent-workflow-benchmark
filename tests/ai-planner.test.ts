import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { buildAiCasePlanPrompt, normalizeAiCasePlan } from "../src/generator/aiPlanner.js";
import { recommendedAiCaseCount, validateAiCasePlan } from "../src/generator/coverage.js";
import type { ContractModel } from "../src/core/types.js";

function buildLargeGenericContract(): ContractModel {
  const roles = Array.from({ length: 50 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return { id: `role-${suffix}`, path: `roles/role-${suffix}.md`, ownerScopes: [`scope-${suffix}`] };
  });
  return {
    schemaVersion: "0.1.0",
    targetId: "large-generic-workflow",
    targetType: "directory",
    root: "fixtures/repos/large-generic-workflow",
    contractHash: "sha256:large-generic-fixture",
    entrypoints: [{ id: "entrypoint", kind: "file", path: "roles/role-01.md" }],
    roles,
    statuses: ["PASS", "FAILED", "SKIPPED", "ADVISORY"],
    requiredOwners: Object.fromEntries(roles.slice(0, 12).map((role, index) => [`scope-${index + 1}`, role.id])),
    routing: {
      forbidden: roles.slice(0, 10).map((role, index) => ({
        id: `forbidden-route-${index + 1}`,
        from: role.id,
        to: roles[index + 10]!.id,
        when: `risk >= ${index + 1}`
      }))
    },
    joins: roles.slice(0, 20).map((role, index) => ({
      id: `join-${index + 1}`,
      producer: role.id,
      consumer: roles[index + 20]!.id,
      artifact: `joins/join-${index + 1}.md`
    })),
    artifacts: roles.slice(0, 20).map((role, index) => ({
      id: `artifact-${index + 1}`,
      path: `deliverables/artifact-${index + 1}.md`,
      owner: role.id
    })),
    states: Array.from({ length: 20 }, (_, index) => ({
      id: `state-${index + 1}`,
      path: `state/state-${index + 1}.json`
    })),
    budgets: { wallClockSeconds: 120, tokenTotal: 12000 },
    commandPolicy: { allowedExecutables: ["node", "npm"], forbiddenArgs: ["--prod-write"] },
    evidenceRefs: []
  };
}

describe("AI case planner", () => {
  test("builds a prompt that asks the runtime LLM to understand the workflow before cases", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const prompt = buildAiCasePlanPrompt(profile.contract, { maxCases: 4, evidence: profile.evidence });

    expect(prompt).toContain("understand the target agent workflow first");
    expect(prompt).toContain("ContractModel");
    expect(prompt).toContain("Workflow evidence excerpts");
    expect(prompt).toContain("CoverageTargets");
    expect(prompt).toContain("Scoring policy");
    expect(prompt).toContain("Owns triage");
    expect(prompt).toContain("Owns implementation artifacts");
    expect(prompt).toContain("Return only JSON");
    expect(prompt).toContain("targetUnderstanding");
    expect(prompt).toContain("workflowUnderstanding");
    expect(prompt).toContain("operationSequence");
    expect(prompt).toContain("coverageTags");
    expect(prompt).toContain("minimal-directory-agent");
  });

  test("normalizes and validates raw LLM case-plan JSON", () => {
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with owner handoff and a join callback.",
      cases: [
        {
          id: "Join Callback",
          title: "Join callback gates downstream work",
          riskFocus: "join ordering",
          operationSequence: ["produce", "callback", "consume"],
          oracleIds: ["oracle-ai-join"],
          expectedHardFailures: ["TARGET_JOIN_MISSING"],
          bindings: { joinId: "code-testdesign" }
        },
        {
          id: "Extra Case",
          title: "Extra case should be trimmed",
          riskFocus: "overflow",
          operationSequence: ["overflow"],
          oracleIds: ["oracle-extra"],
          expectedHardFailures: []
        }
      ]
    }, "codex", "gpt-fixture", { maxCases: 1 });

    expect(plan.planner).toBe("codex");
    expect(plan.model).toBe("gpt-fixture");
    expect(plan.cases).toHaveLength(1);
    expect(plan.cases[0].id).toBe("join-callback");
    expect(plan.cases[0].operationSequence).toEqual(["produce", "callback", "consume"]);
  });

  test("deduplicates AI case ids after kebab-case normalization", () => {
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with repeated risk names.",
      cases: [
        {
          id: "Owner Artifact Gate",
          title: "Owner artifact gate one",
          riskFocus: "owner routing",
          operationSequence: ["invoke", "write", "score"],
          oracleIds: ["oracle-owner-artifact-one"],
          expectedHardFailures: []
        },
        {
          id: "owner-artifact-gate",
          title: "Owner artifact gate two",
          riskFocus: "artifact path",
          operationSequence: ["invoke", "write alternate", "score"],
          oracleIds: ["oracle-owner-artifact-two"],
          expectedHardFailures: []
        }
      ]
    }, "codex");

    expect(plan.cases.map((testCase) => testCase.id)).toEqual(["owner-artifact-gate", "owner-artifact-gate-2"]);
  });

  test("marks plans without structured workflow understanding as harness warnings", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with owner handoff but no structured workflow interpretation.",
      cases: [
        {
          id: "owner-routing",
          title: "Owner routing is checked",
          riskFocus: "owner routing",
          operationSequence: ["invoke", "handoff", "score"],
          oracleIds: ["oracle-owner-routing"],
          expectedHardFailures: [],
          coverageTags: ["dimension:owner-routing", "role:orchestrator-agent"],
          bindings: { primaryRole: "orchestrator-agent" }
        },
        {
          id: "artifact-output",
          title: "Artifact output is checked",
          riskFocus: "artifact output",
          operationSequence: ["invoke", "write", "score"],
          oracleIds: ["oracle-artifact-output"],
          expectedHardFailures: [],
          coverageTags: ["dimension:artifacts", "role:worker-agent"],
          bindings: { primaryRole: "worker-agent" }
        },
        {
          id: "side-effect-policy",
          title: "Side-effect policy is checked",
          riskFocus: "side-effect policy",
          operationSequence: ["invoke", "attempt side effect", "score"],
          oracleIds: ["oracle-side-effect-policy"],
          expectedHardFailures: [],
          coverageTags: ["dimension:side-effect-policy", "policy:command"],
          bindings: { primaryRole: "orchestrator-agent" }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, profile.contract);

    expect(validation.status).toBe("WARN");
    expect(validation.invalidBindings).toEqual([]);
    expect(validation.warnings).toContain("Plan is missing workflowUnderstanding; targetUnderstanding alone is weaker evidence.");
  });

  test("validates AI case plans against contract bindings and coverage targets", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with owner handoff and a join callback.",
      workflowUnderstanding: {
        goal: "Route work to the right owner and return join evidence.",
        stages: ["entrypoint", "implementation", "join"],
        criticalInvariants: ["worker-agent owns implementation"],
        scoringSignals: ["artifact writes", "join callbacks"]
      },
      cases: [
        {
          id: "invalid-owner",
          title: "Invalid owner binding is rejected",
          riskFocus: "owner routing",
          operationSequence: ["invoke", "handoff"],
          oracleIds: ["oracle-invalid-owner"],
          expectedHardFailures: ["TARGET_OWNER_BYPASS"],
          coverageTags: ["dimension:owner-routing", "role:ghost-agent"],
          bindings: { primaryRole: "orchestrator-agent", owner: "ghost-agent", joinId: "missing-join" }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, profile.contract);

    expect(validation.status).toBe("FAIL");
    expect(validation.invalidBindings.map((item) => item.field)).toEqual(expect.arrayContaining(["owner", "joinId"]));
    expect(validation.missingCoverageTargetIds).toContain("role:worker-agent");
  });

  test("normalizes common AI coverage tag aliases before validation", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with artifact output.",
      workflowUnderstanding: {
        goal: "Verify artifact evidence.",
        stages: ["entrypoint", "artifact"],
        criticalInvariants: ["artifact path is canonical"],
        scoringSignals: ["artifact writes"]
      },
      cases: [
        {
          id: "artifact-alias",
          title: "Artifact alias tag is accepted",
          riskFocus: "AI planner may use singular dimension labels",
          operationSequence: ["write artifact", "score"],
          oracleIds: ["oracle-artifact"],
          expectedHardFailures: [],
          coverageTags: ["dimension:artifact", "role:orchestrator-agent"],
          bindings: { primaryRole: "orchestrator-agent", owner: "orchestrator-agent", artifactPath: "deliverables/implementation-plan.md" }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, profile.contract);

    expect(validation.coveredCoverageTargetIds).toContain("dimension:artifacts");
    expect(validation.unknownCoverageTags).not.toContain("dimension:artifact");
  });

  test("normalizes AI blocked-state tag drift to the declared state target", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with blocked state recovery.",
      workflowUnderstanding: {
        goal: "Verify blocked-state evidence.",
        stages: ["entrypoint", "blocked recovery"],
        criticalInvariants: ["blocked state is explicit"],
        scoringSignals: ["state reads"]
      },
      cases: [
        {
          id: "blocked-state-alias",
          title: "Blocked state alias is accepted",
          riskFocus: "AI planner may describe blocked state as an artifact-like tag",
          operationSequence: ["write blocked state", "recover"],
          oracleIds: ["oracle-blocked-state"],
          expectedHardFailures: [],
          coverageTags: ["artifact:block:state", "role:orchestrator-agent"],
          bindings: { primaryRole: "orchestrator-agent", owner: "orchestrator-agent", artifactPath: "blocked/BLOCKED.md" }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, profile.contract);

    expect(validation.status).not.toBe("FAIL");
    expect(validation.invalidBindings).toEqual([]);
    expect(validation.coveredCoverageTargetIds).toContain("state:blocked");
    expect(validation.unknownCoverageTags).not.toContain("artifact:block:state");
  });

  test("separates smoke budgets from full and adaptive workflow coverage", async () => {
    const contract = buildLargeGenericContract();

    const smoke = recommendedAiCaseCount(contract, { coverageMode: "smoke" });
    const full = recommendedAiCaseCount(contract, { coverageMode: "full" });
    const adaptive = recommendedAiCaseCount(contract, { coverageMode: "adaptive" });

    expect(smoke).toBeLessThanOrEqual(32);
    expect(full).toBeGreaterThan(32);
    expect(adaptive).toBeGreaterThanOrEqual(full);
  });
});
