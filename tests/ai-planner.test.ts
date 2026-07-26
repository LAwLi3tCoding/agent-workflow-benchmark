import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { buildAiCasePlanPrompt, normalizeAiCasePlan, runAiCasePlanner } from "../src/generator/aiPlanner.js";
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
    expect(prompt).toContain("statusSemantics");
    expect(prompt).toContain("Workflow evidence excerpts");
    expect(prompt).toContain("CoverageTargets");
    expect(prompt).toContain("Scoring policy");
    expect(prompt).toContain("Owns triage");
    expect(prompt).toContain("Owns implementation artifacts");
    expect(prompt).toContain("Return only JSON");
    expect(prompt).toContain("targetUnderstanding");
    expect(prompt).toContain("workflowUnderstanding");
    expect(prompt).toContain("operationSequence");
    expect(prompt).toContain("referenceOutcome");
    expect(prompt).toContain("counterexampleOutcome");
    expect(prompt).toContain("coverageTags");
    expect(prompt).toContain("minimal-directory-agent");
  });

  test("fixture planning uses the target pass mapping instead of status:PASS", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-ai-planner-status-"));
    try {
      const profile = await profileTarget(
        await loadTargetPack("minimal-directory-agent")
      );
      const contract = structuredClone(profile.contract);
      contract.statuses = [
        "BUILD_GREEN",
        "BUILD_WAIT",
        "RELEASE_GREEN",
        "RELEASE_WAIT"
      ];
      contract.statusSemantics = [
        {
          code: "BUILD_GREEN",
          semanticClass: "pass",
          scope: "build-gate",
          blocking: false,
          terminal: true,
          allowedTransitions: []
        },
        {
          code: "BUILD_WAIT",
          semanticClass: "pending",
          scope: "build-gate",
          blocking: true,
          terminal: false,
          allowedTransitions: ["BUILD_GREEN"]
        },
        {
          code: "RELEASE_GREEN",
          semanticClass: "pass",
          scope: "release-gate",
          blocking: false,
          terminal: true,
          allowedTransitions: []
        },
        {
          code: "RELEASE_WAIT",
          semanticClass: "pending",
          scope: "release-gate",
          blocking: true,
          terminal: false,
          allowedTransitions: ["RELEASE_GREEN"]
        }
      ];

      const run = await runAiCasePlanner(contract, {
        runner: "fixture",
        coverageMode: "smoke",
        timeoutMs: 1000,
        outDir: out,
        maxCases: 1
      });
      const serialized = JSON.stringify(run.plan.cases[0]);

      expect(run.plan.cases[0]?.coverageTags).toContain("status:BUILD_GREEN");
      expect(run.plan.cases[0]?.bindings?.statusScope).toBe("build-gate");
      expect(serialized).not.toContain("status:PASS");
      expect(serialized).not.toContain("PASS gate");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("fixture planning includes success-control and failure-probe outcome contrasts", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-ai-planner-outcomes-"));
    try {
      const profile = await profileTarget(
        await loadTargetPack("minimal-directory-agent")
      );

      const run = await runAiCasePlanner(profile.contract, {
        runner: "fixture",
        coverageMode: "smoke",
        timeoutMs: 1000,
        outDir: out,
        maxCases: 3
      });

      expect(run.plan.cases).toHaveLength(3);
      expect(run.plan.cases.every((testCase) => testCase.referenceOutcome)).toBe(
        true
      );
      expect(
        run.plan.cases.every((testCase) => testCase.counterexampleOutcome)
      ).toBe(true);
      expect(
        run.plan.cases.some(
          (testCase) => testCase.expectedHardFailures.length === 0
        )
      ).toBe(true);
      expect(
        run.plan.cases.some(
          (testCase) => testCase.expectedHardFailures.length > 0
        )
      ).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("persists only portable planner evidence and a response digest", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-ai-planner-private-"));
    try {
      const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
      const evidence = {
        ...profile.evidence,
        scannedFiles: profile.evidence.scannedFiles.map((file) => ({
          ...file,
          excerpt: "INTERNAL_BUSINESS_DATA_MARKER"
        }))
      };

      const run = await runAiCasePlanner(profile.contract, {
        runner: "fixture",
        coverageMode: "smoke",
        timeoutMs: 1000,
        outDir: out,
        maxCases: 1,
        evidence
      });
      const persistedPrompt = await readFile(run.promptPath, "utf8");
      const persistedResponse = JSON.parse(await readFile(run.rawResponsePath, "utf8"));

      expect(persistedPrompt).not.toContain("INTERNAL_BUSINESS_DATA_MARKER");
      expect(persistedPrompt).toContain(evidence.scannedFiles[0]!.sha256);
      expect(persistedResponse).toMatchObject({
        schemaVersion: "0.1.0",
        contentRedacted: true,
        contentHash: expect.stringMatching(/^sha256:/),
        planner: "fixture"
      });
      expect(JSON.stringify(persistedResponse)).not.toContain("targetUnderstanding");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("normalizes and validates raw LLM case-plan JSON", () => {
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with owner handoff and a join callback.",
      cases: [
        {
          id: "Join Callback",
          title: "Join callback gates downstream work",
          riskFocus: "join ordering",
          referenceOutcome: "  Downstream work starts only after callback evidence.  ",
          counterexampleOutcome: "  Downstream work starts before callback evidence.  ",
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
    expect(plan.cases[0].referenceOutcome).toBe("Downstream work starts only after callback evidence.");
    expect(plan.cases[0].counterexampleOutcome).toBe("Downstream work starts before callback evidence.");
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
    expect(validation.warnings).toContain("Case owner-routing is missing referenceOutcome; benchmark generation cannot state the expected correct observable result.");
    expect(validation.warnings).toContain("Case owner-routing is missing counterexampleOutcome; benchmark generation cannot state the nearest incorrect behavior it should catch.");
    expect(validation.warnings).toContain("Plan has three or more cases but only success-control cases; include at least one failure-probe case with expectedHardFailures.");
  });

  test("warns when larger AI plans are one-sided failure probes", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow with only failure probes.",
      workflowUnderstanding: {
        goal: "Verify failures are caught.",
        stages: ["entrypoint", "failure", "score"],
        criticalInvariants: ["hard failures remain hard"],
        scoringSignals: ["hard failure events"]
      },
      cases: [
        {
          id: "join-missing",
          title: "Missing join is caught",
          riskFocus: "join",
          referenceOutcome: "The join callback is present before downstream work.",
          counterexampleOutcome: "Downstream work starts without the join callback.",
          operationSequence: ["invoke", "skip join", "score"],
          oracleIds: ["oracle-join"],
          expectedHardFailures: ["TARGET_JOIN_MISSING"],
          coverageTags: ["dimension:joins", "join:code-testdesign"],
          bindings: { joinId: "code-testdesign" }
        },
        {
          id: "owner-bypass",
          title: "Owner bypass is caught",
          riskFocus: "owner",
          referenceOutcome: "The declared owner handles the scoped work.",
          counterexampleOutcome: "An undeclared owner handles the scoped work.",
          operationSequence: ["invoke", "bypass owner", "score"],
          oracleIds: ["oracle-owner"],
          expectedHardFailures: ["TARGET_OWNER_BYPASS"],
          coverageTags: ["dimension:owner-routing", "role:orchestrator-agent"],
          bindings: { primaryRole: "orchestrator-agent" }
        },
        {
          id: "side-effect",
          title: "Side effect is caught",
          riskFocus: "side effect",
          referenceOutcome: "Production side effects are denied and recorded.",
          counterexampleOutcome: "A production side effect is attempted or allowed.",
          operationSequence: ["invoke", "attempt write", "score"],
          oracleIds: ["oracle-side-effect"],
          expectedHardFailures: ["PRODUCTION_SIDE_EFFECT"],
          coverageTags: ["dimension:side-effect-policy", "policy:command"],
          bindings: { primaryRole: "orchestrator-agent" }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, profile.contract);

    expect(validation.warnings).toContain("Plan has three or more cases but only failure-probe cases; include at least one success-control case with no expectedHardFailures.");
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

  test("rejects not-applicable as a phantom join binding", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract);
    contract.joins = [];
    const plan = normalizeAiCasePlan({
      targetUnderstanding: "A workflow that declares no join topology.",
      workflowUnderstanding: {
        goal: "Exercise a target without inventing a join.",
        stages: ["entrypoint", "completion"],
        criticalInvariants: ["bindings reference only declared topology"],
        scoringSignals: ["binding validation"]
      },
      cases: [
        {
          id: "phantom-join",
          title: "Phantom join binding is rejected",
          riskFocus: "sentinel values masquerading as contract bindings",
          operationSequence: ["invoke", "complete"],
          oracleIds: ["oracle-no-join"],
          expectedHardFailures: [],
          coverageTags: ["role:orchestrator-agent"],
          bindings: {
            primaryRole: "orchestrator-agent",
            joinId: "not-applicable",
            statusScope: "not-applicable"
          }
        }
      ]
    }, "codex");

    const validation = validateAiCasePlan(plan, contract);

    expect(validation.invalidBindings).toContainEqual(
      expect.objectContaining({
        caseId: "phantom-join",
        field: "joinId",
        value: "not-applicable"
      })
    );
    expect(validation.invalidBindings).toContainEqual(
      expect.objectContaining({
        caseId: "phantom-join",
        field: "statusScope",
        value: "not-applicable"
      })
    );
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
