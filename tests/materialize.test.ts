import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { materializeAiSuite, materializeSmokeSuite } from "../src/generator/materialize.js";
import { runCase } from "../src/runner/simulatedRunner.js";
import { scoreCase } from "../src/scorer/score.js";

describe("case materialization", () => {
  test("materializes ten generic smoke templates for a directory target", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeSmokeSuite(profile.contract);

    expect(suite.cases).toHaveLength(10);
    expect(suite.applicability.every((item) => item.status === "materialized")).toBe(true);
    expect(suite.cases.map((item) => item.templateId)).toContain("required-join");
    expect(suite.manifest.contractHash).toBe(profile.contract.contractHash);
  });

  test("marks topology-specific templates not applicable instead of inventing bindings", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const contract = structuredClone(profile.contract);
    contract.roles = contract.roles.slice(0, 1);
    contract.routing.forbidden = [];
    contract.joins = [];
    contract.artifacts = [];
    contract.states = [];
    contract.statuses = [];
    delete contract.statusSemantics;

    const suite = materializeSmokeSuite(contract);
    const notApplicable = suite.applicability
      .filter((item) => item.status === "notApplicable")
      .map((item) => item.templateId);

    expect(notApplicable).toEqual(
      expect.arrayContaining([
        "forbidden-route",
        "required-join",
        "role-boundary",
        "state-recovery",
        "skip-not-pass"
      ])
    );
    expect(suite.cases.map((item) => item.templateId)).not.toEqual(
      expect.arrayContaining(notApplicable)
    );
    const run = runCase(suite.cases[0]!, contract);
    expect(run.events.some((event) => event.type === "state_read")).toBe(false);
    const result = scoreCase(suite.cases[0]!, run);
    expect(
      result.evaluationDimensions.find(
        (dimension) => dimension.dimension === "artifact"
      )
    ).toMatchObject({
      status: "PASS",
      why: "No artifact assertion applies to this case."
    });
    expect(
      result.evaluationDimensions.find(
        (dimension) => dimension.dimension === "gate"
      )
    ).toMatchObject({
      status: "PASS",
      why: "No gate assertion applies to this case."
    });
  });

  test("materializes independent gate evidence for every pass/non-pass status scope", async () => {
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
    const testCases = materializeSmokeSuite(contract).cases.filter(
      (item) => item.templateId === "skip-not-pass"
    );

    expect(testCases.map((item) => item.bindings.statusScope)).toEqual([
      "build-gate",
      "release-gate"
    ]);
    expect(new Set(testCases.map((item) => item.id)).size).toBe(2);
    expect(
      testCases.map((testCase) =>
        runCase(testCase, contract).events.find(
          (event) => event.type === "gate_decision"
        )?.payload
      )
    ).toEqual([
      expect.objectContaining({
        status: "BUILD_GREEN",
        sourceStatus: "BUILD_GREEN",
        scope: "build-gate",
        transition: { from: "BUILD_GREEN", to: "BUILD_GREEN" },
        readbackStatus: "BUILD_GREEN"
      }),
      expect.objectContaining({
        status: "RELEASE_GREEN",
        sourceStatus: "RELEASE_GREEN",
        scope: "release-gate",
        transition: { from: "RELEASE_GREEN", to: "RELEASE_GREEN" },
        readbackStatus: "RELEASE_GREEN"
      })
    ]);
  });

  test("turns a status coverage tag into executable status and scope bindings", async () => {
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
    const suite = materializeAiSuite(contract, {
      planner: "fixture",
      plan: {
        planner: "fixture",
        targetUnderstanding: "A multi-stage workflow with scoped gate statuses.",
        workflowUnderstanding: {
          goal: "Preserve scoped gate semantics.",
          stages: ["build gate", "release gate"],
          criticalInvariants: ["Each status is evaluated in its declared scope."],
          scoringSignals: ["Exact gate status and scope evidence."]
        },
        cases: [
          {
            id: "release-wait",
            title: "Observe the release wait state",
            riskFocus: "release status evidence",
            operationSequence: ["enter release gate", "emit wait", "read back wait"],
            oracleIds: ["oracle-release-wait"],
            expectedHardFailures: [],
            coverageTags: ["dimension:gate-statuses", "status:RELEASE_WAIT"],
            scoringRubric: ["The exact status and scope must be observed."]
          }
        ]
      }
    });
    const testCase = suite.cases[0]!;
    const gate = runCase(testCase, contract).events.find(
      (event) => event.type === "gate_decision"
    );

    expect(testCase.bindings).toMatchObject({
      statusCode: "RELEASE_WAIT",
      statusScope: "release-gate"
    });
    expect(gate?.payload).toMatchObject({
      status: "RELEASE_WAIT",
      sourceStatus: "RELEASE_WAIT",
      scope: "release-gate",
      readbackStatus: "RELEASE_WAIT"
    });
  });

  test("materializes cases from an AI understanding plan", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeAiSuite(profile.contract, {
      planner: "fixture",
      model: "fixture-model",
      plan: {
        planner: "fixture",
        model: "fixture-model",
        targetUnderstanding: "The workflow is a directory-backed agent workflow with owner handoff, artifact writes, and gate states.",
        cases: [
          {
            id: "owner-artifact-gate",
            title: "Owner writes declared artifact before PASS gate",
            riskFocus: "owner routing and artifact/gate ordering",
            referenceOutcome: "The declared owner writes the implementation plan before the gate passes.",
            counterexampleOutcome: "The gate passes without owner-bound implementation evidence.",
            operationSequence: ["invoke primary role", "verify owner handoff", "verify artifact write", "verify PASS gate"],
            oracleIds: ["oracle-ai-owner-artifact-gate"],
            expectedHardFailures: [],
            coverageTags: ["dimension:owner-routing", "dimension:artifacts", "role:orchestrator-agent"],
            scoringRubric: ["Owner binding must match a declared role.", "Artifact path must match the ContractModel."],
            bindings: {
              primaryRole: "orchestrator-agent",
              owner: "orchestrator-agent",
              artifactPath: "deliverables/implementation-plan.md"
            }
          },
          {
            id: "join-before-downstream",
            title: "Join callback gates downstream work",
            riskFocus: "join callback ordering",
            operationSequence: ["produce join artifact", "observe callback", "allow downstream handoff"],
            oracleIds: ["oracle-ai-join-before-downstream"],
            expectedHardFailures: ["TARGET_JOIN_MISSING"],
            coverageTags: ["dimension:joins", "join:code-testdesign", "role:worker-agent"],
            scoringRubric: ["Downstream work must wait for the declared join artifact."],
            bindings: {
              primaryRole: "worker-agent",
              owner: "orchestrator-agent",
              joinId: "code-testdesign"
            }
          }
        ]
      }
    });

    expect(suite.cases).toHaveLength(2);
    expect(suite.manifest.generation).toBeDefined();
    expect(suite.manifest.generation?.mode).toBe("ai-first");
    expect(suite.manifest.generation?.planner).toBe("fixture");
    expect(suite.manifest.generation?.targetUnderstanding).toContain("owner handoff");
    const validation = suite.manifest.generation?.validation;
    expect(validation).toBeDefined();
    expect(validation!.status).not.toBe("FAIL");
    expect(validation!.coveredCoverageTargetIds).toContain("dimension:joins");
    expect(suite.cases[0].templateId).toBe("ai-owner-artifact-gate");
    expect(suite.cases[0].prompt).toContain("Risk focus: owner routing and artifact/gate ordering");
    expect(suite.cases[0].prompt).toContain("Reference outcome: The declared owner writes the implementation plan before the gate passes.");
    expect(suite.cases[0].prompt).toContain("Counterexample outcome: The gate passes without owner-bound implementation evidence.");
    expect(suite.cases[0].generation?.mode).toBe("ai-first");
    expect(suite.cases[0].generation?.referenceOutcome).toBe("The declared owner writes the implementation plan before the gate passes.");
    expect(suite.cases[0].generation?.counterexampleOutcome).toBe("The gate passes without owner-bound implementation evidence.");
    expect(suite.cases[0].generation?.coverageTags).toContain("dimension:artifacts");
    expect(suite.cases[0].generation?.scoringRubric).toContain("Owner binding must match a declared role.");
    expect(suite.cases[0].generation?.operationSequence).toContain("verify artifact write");
    expect(suite.cases[1].expectedHardFailures).toContain("TARGET_JOIN_MISSING");
  });

  test("materializes external AI plans with duplicate-normalized ids into stable unique cases", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeAiSuite(profile.contract, {
      planner: "external",
      plan: {
        planner: "external",
        targetUnderstanding: "The workflow has repeated human-readable risk labels.",
        workflowUnderstanding: {
          goal: "Keep external AI plans executable even when ids collide after normalization.",
          stages: ["plan", "materialize"],
          criticalInvariants: ["case ids are stable and unique"],
          scoringSignals: ["manifest ids", "case hashes"]
        },
        cases: [
          {
            id: "Owner Artifact Gate",
            title: "Owner artifact gate one",
            riskFocus: "owner routing",
            operationSequence: ["invoke", "write", "score"],
            oracleIds: ["oracle-owner-artifact-one"],
            expectedHardFailures: [],
            coverageTags: ["dimension:owner-routing", "role:orchestrator-agent"],
            scoringRubric: ["First case remains the canonical normalized id."],
            bindings: { primaryRole: "orchestrator-agent" }
          },
          {
            id: "owner-artifact-gate",
            title: "Owner artifact gate two",
            riskFocus: "artifact path",
            operationSequence: ["invoke", "write alternate", "score"],
            oracleIds: ["oracle-owner-artifact-two"],
            expectedHardFailures: [],
            coverageTags: ["dimension:artifacts", "role:orchestrator-agent"],
            scoringRubric: ["Second case receives a deterministic suffix."],
            bindings: { primaryRole: "orchestrator-agent" }
          }
        ]
      }
    });

    expect(suite.cases.map((testCase) => testCase.templateId)).toEqual(["ai-owner-artifact-gate", "ai-owner-artifact-gate-2"]);
    expect(suite.manifest.caseIds).toEqual([
      "minimal-directory-agent-ai-001-owner-artifact-gate",
      "minimal-directory-agent-ai-002-owner-artifact-gate-2"
    ]);
  });

  test("normalizes AI planner bindings that reference owner scopes and coverage-style ids", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeAiSuite(profile.contract, {
      planner: "codex",
      plan: {
        planner: "codex",
        targetUnderstanding: "The workflow is gate-driven and orchestrator controlled.",
        workflowUnderstanding: {
          goal: "Block execution until the declared join returns to the orchestrator.",
          stages: ["entrypoint", "design gate", "execution handoff"],
          criticalInvariants: ["owner scopes map to declared roles", "join ids may be written as coverage tags"],
          scoringSignals: ["owner routing", "join callback", "artifact path"]
        },
        cases: [
          {
            id: "owner-scope-prefix-bindings",
            title: "Owner scope and join bindings normalize to canonical contract values",
            riskFocus: "AI planner emits coverage-style binding ids",
            operationSequence: ["dispatch worker", "wait for join return", "allow execution"],
            oracleIds: ["oracle-owner-join-gate"],
            expectedHardFailures: ["TARGET_JOIN_MISSING"],
            coverageTags: ["owner:design", "join:code-testdesign", "artifact:implementation-plan"],
            scoringRubric: ["The materialized case must bind to declared roles and artifact paths."],
            bindings: {
              primaryRole: "role:orchestrator-agent",
              owner: "design",
              joinId: "join:code-testdesign",
              artifactPath: "artifact:implementation-plan"
            }
          }
        ]
      }
    });

    expect(suite.manifest.generation?.validation?.invalidBindings).toEqual([]);
    expect(suite.cases[0].bindings).toMatchObject({
      primaryRole: "orchestrator-agent",
      owner: "orchestrator-agent",
      joinId: "code-testdesign",
      artifactPath: "deliverables/implementation-plan.md"
    });
  });

  test("infers execution bindings from specific AI coverage tags", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeAiSuite(profile.contract, {
      planner: "codex",
      plan: {
        planner: "codex",
        targetUnderstanding: "The workflow must wait for review summary evidence before final DoD.",
        workflowUnderstanding: {
          goal: "Verify a non-default join and artifact are actually bound into the executable case.",
          stages: ["worker execution", "review summary", "orchestrator final DoD"],
          criticalInvariants: ["coverage claims must drive the same join and artifact bindings"],
          scoringSignals: ["join callback", "artifact write"]
        },
        cases: [
          {
            id: "review-summary-binding",
            title: "Review summary join is bound from coverage",
            riskFocus: "AI planner may omit bindings while claiming precise coverage tags",
            operationSequence: ["produce review summary", "callback to orchestrator", "score final DoD"],
            oracleIds: ["oracle-review-summary"],
            expectedHardFailures: ["TARGET_JOIN_MISSING"],
            coverageTags: ["join:review-summary-return", "artifact:worker-summary"],
            scoringRubric: ["The materialized case must bind to the claimed join and artifact."]
          }
        ]
      }
    });

    expect(suite.manifest.generation?.validation?.invalidBindings).toEqual([]);
    expect(suite.cases[0].bindings).toMatchObject({
      joinId: "review-summary-return",
      artifactPath: "reviews/summary.md"
    });
  });

  test("rejects AI bindings that contradict specific coverage tags", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);

    expect(() =>
      materializeAiSuite(profile.contract, {
        planner: "codex",
        plan: {
          planner: "codex",
          targetUnderstanding: "The workflow must not claim one join and bind another.",
          workflowUnderstanding: {
            goal: "Detect false coverage claims.",
            stages: ["plan", "materialize"],
            criticalInvariants: ["join coverage and join binding must match"],
            scoringSignals: ["invalid binding"]
          },
          cases: [
            {
              id: "mismatched-join-binding",
              title: "Mismatched join binding is rejected",
              riskFocus: "false coverage",
              operationSequence: ["claim review join", "bind implementation join"],
              oracleIds: ["oracle-mismatched-join"],
              expectedHardFailures: ["TARGET_JOIN_MISSING"],
              coverageTags: ["join:review-summary-return"],
              scoringRubric: ["The binding must match the claimed join."],
              bindings: { joinId: "code-testdesign" }
            }
          ]
        }
      })
    ).toThrow(/invalid ContractModel bindings/u);
  });

  test("rejects AI coverage tags that claim multiple scalar joins in one case", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);

    expect(() =>
      materializeAiSuite(profile.contract, {
        planner: "codex",
        plan: {
          planner: "codex",
          targetUnderstanding: "The workflow has independent joins that cannot share one scalar case binding.",
          workflowUnderstanding: {
            goal: "Detect false multi-target coverage claims.",
            stages: ["plan", "materialize"],
            criticalInvariants: ["one scalar join binding cannot prove two distinct joins"],
            scoringSignals: ["invalid binding"]
          },
          cases: [
            {
              id: "multi-join-binding",
              title: "Multiple join claims are rejected",
              riskFocus: "false coverage",
              operationSequence: ["claim review join", "claim implementation join", "bind one join"],
              oracleIds: ["oracle-multi-join"],
              expectedHardFailures: ["TARGET_JOIN_MISSING"],
              coverageTags: ["join:review-summary-return", "join:code-testdesign"],
              scoringRubric: ["A scalar joinId cannot satisfy two different join coverage tags."],
              bindings: { joinId: "review-summary-return" }
            }
          ]
        }
      })
    ).toThrow(/invalid ContractModel bindings/u);
  });

  test("rejects AI role coverage tags that contradict the primary role binding", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);

    expect(() =>
      materializeAiSuite(profile.contract, {
        planner: "codex",
        plan: {
          planner: "codex",
          targetUnderstanding: "The workflow has distinct orchestrator and worker roles.",
          workflowUnderstanding: {
            goal: "Detect role coverage that does not match the executable role.",
            stages: ["plan", "materialize"],
            criticalInvariants: ["role coverage must bind the same executable primaryRole"],
            scoringSignals: ["invalid binding"]
          },
          cases: [
            {
              id: "role-contradiction",
              title: "Role tag cannot contradict primaryRole",
              riskFocus: "false role coverage",
              operationSequence: ["claim worker role", "bind orchestrator"],
              oracleIds: ["oracle-role-contradiction"],
              expectedHardFailures: [],
              coverageTags: ["role:worker-agent"],
              scoringRubric: ["The primaryRole binding must match the claimed role tag."],
              bindings: { primaryRole: "orchestrator-agent" }
            }
          ]
        }
      })
    ).toThrow(/invalid ContractModel bindings/u);
  });

  test("normalizes AI planner artifactPath bindings that point at declared state paths", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeAiSuite(profile.contract, {
      planner: "codex",
      plan: {
        planner: "codex",
        targetUnderstanding: "The workflow records recoverable blocked state under the task state tree.",
        workflowUnderstanding: {
          goal: "Verify blocked-state recovery paths are explicit.",
          stages: ["entrypoint", "blocked state", "recovery"],
          criticalInvariants: ["blocked state must use the declared state path"],
          scoringSignals: ["state read/write evidence"]
        },
        cases: [
          {
            id: "blocked-state-path-binding",
            title: "Blocked state is recorded before recovery",
            riskFocus: "AI planner may bind declared state paths through the generic artifactPath field",
            operationSequence: ["record blocked state", "read blocked state", "recover"],
            oracleIds: ["oracle-blocked-state"],
            expectedHardFailures: [],
            coverageTags: ["state:blocked", "dimension:states"],
            scoringRubric: ["The materialized case must accept declared state paths as evidence paths."],
            bindings: {
              primaryRole: "role:orchestrator-agent",
              owner: "orchestrator-agent",
              artifactPath: "blocked/BLOCKED.md"
            }
          }
        ]
      }
    });

    expect(suite.manifest.generation?.validation?.invalidBindings).toEqual([]);
    expect(suite.cases[0].bindings.artifactPath).toBe("blocked/BLOCKED.md");
  });
});
