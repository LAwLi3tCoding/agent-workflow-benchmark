import { describe, expect, test } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import YAML from "yaml";

const cwd = process.cwd();

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function expectValidSchema(schemaPath: string, value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(cwd, schemaPath), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

async function expectInvalidSchema(schemaPath: string, value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(cwd, schemaPath), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value)).toBe(false);
}

describe("benchmark CLI", () => {
  test("help presents Agent Workflow Bench as the awb CI regression CLI", async () => {
    const result = await execa("npm", ["run", "benchmark", "--", "--help"], { cwd });

    expect(result.stdout).toContain("Usage: awb");
    expect(result.stdout).toContain("Agent Workflow Bench");
    expect(result.stdout).toContain("CI-grade regression testing for coding-agent workflows");
  });

  test("doctor discovers the target and reports the simulated evidence ceiling without local paths", async () => {
    const out = await tmp("awb-doctor-");
    try {
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "doctor",
          "--target",
          "minimal-directory-agent",
          "--runner",
          "simulated",
          "--out",
          out
        ],
        { cwd }
      );

      const result = JSON.parse(await readFile(path.join(out, "doctor-result.json"), "utf8"));
      await expectValidSchema("schemas/doctor-result.schema.json", result);
      expect(result.product).toBe("Agent Workflow Bench");
      expect(result.target).toMatchObject({
        id: "minimal-directory-agent",
        status: "PASS",
        missingFiles: []
      });
      expect(result.runner).toMatchObject({
        name: "simulated",
        supported: true,
        evidenceKind: "simulated",
        observationLevel: "synthetic_events"
      });
      expect(result.readiness).toBe("DIAGNOSTIC_ONLY");
      expect(result.checks.map((check: { id: string }) => check.id)).toEqual(
        expect.arrayContaining(["target-files", "contract-profile", "runner-capability", "evidence-boundary"])
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(cwd);
      expect(serialized).not.toMatch(/\/(?:Users|home)\/[^/]+/);

      const report = await readFile(path.join(out, "doctor-report.md"), "utf8");
      expect(report).toContain("# Agent Workflow Bench Doctor");
      expect(report).toContain("Readiness: DIAGNOSTIC_ONLY");
      expect(report).toContain("synthetic_events");
      expect(report).not.toContain(cwd);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("validate-schema compiles schemas and target packs", async () => {
    const result = await execa("npm", ["run", "benchmark", "--", "validate-schema"], { cwd });
    expect(result.stdout).toContain("schemas valid");
    expect(result.stdout).toContain("runner configs valid");
  });

  test("exposes production CI canary and assessment commands", async () => {
    const result = await execa(
      "npm",
      ["run", "benchmark", "--", "ci", "--help"],
      { cwd }
    );

    expect(result.stdout).toContain("evaluate-canary");
    expect(result.stdout).toContain("assess");
    expect(result.stdout).toContain("prepare-authorization");
    expect(result.stdout).toContain("finalize-authorization");
  });

  test("production CI assess hides caller-controlled time and pairs authorization inputs", async () => {
    const help = await execa(
      "npm",
      ["run", "benchmark", "--", "ci", "assess", "--help"],
      { cwd }
    );
    expect(help.stdout).not.toContain("--now");

    const result = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "ci",
        "assess",
        "--gate-result",
        "missing-gate-result.json",
        "--runtime-manifest",
        "missing-runtime-manifest.json",
        "--provenance",
        "missing-provenance.json",
        "--isolation-manifest",
        "missing-isolation-manifest.json",
        "--canary-report",
        "missing-canary-report.json",
        "--authorization",
        "missing-authorization.json",
        "--out",
        "missing-out"
      ],
      { cwd, reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "--authorization and --trusted-authorization-key must be provided together."
    );
  });

  test("run rejects an unsupported mode before writing artifacts", async () => {
    const out = await tmp("awb-invalid-mode-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--target",
          "minimal-directory-agent",
          "--runner",
          "simulated",
          "--mode",
          "advisory",
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Unsupported run mode: advisory");
      await expect(stat(path.join(out, "runtime-manifest.json"))).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("suite-result schema rejects incomplete case result records", async () => {
    await expectInvalidSchema("schemas/suite-result.schema.json", {
      schemaVersion: "0.1.0",
      resultType: "suite",
      targetId: "minimal-directory-agent",
      suite: "smoke",
      runId: "schema-negative",
      caseResults: [{}],
      dimensionScores: [],
      recommendations: [],
      p0CaseRecords: [],
      rawSuiteScore: 100,
      cappedSuiteScore: 100,
      releaseDecision: "APPROVE",
      releaseRuleId: "REL-APPROVE",
      telemetryCompleteness: 1,
      debugHealth: {
        status: "NOT_RUN",
        mutationKillRate: null,
        falseNegativeCount: null,
        falsePositiveCount: null,
        environmentReproducibility: null,
        lastReverseValidationRunId: null,
        doesNotAffectTargetScore: true
      }
    });
  });

  test("profile writes profile evidence and contract model", async () => {
    const out = await tmp("awb-profile-");
    try {
      await execa("npm", ["run", "benchmark", "--", "profile", "--target", "minimal-directory-agent", "--out", out], { cwd });

      await expect(stat(path.join(out, "profile-evidence.json"))).resolves.toBeTruthy();
      const evidence = JSON.parse(await readFile(path.join(out, "profile-evidence.json"), "utf8"));
      const contract = JSON.parse(await readFile(path.join(out, "contract-model.json"), "utf8"));
      await expectValidSchema("schemas/profile-evidence.schema.json", evidence);
      await expectValidSchema("schemas/contract-model.schema.json", contract);
      expect(contract.targetId).toBe("minimal-directory-agent");
      expect(contract.contractHash).toMatch(/^sha256:/);
      expect(contract.root).toBe("target://root");
      expect(evidence.root).toBe("target://root");
      expect(evidence.scannedFiles.every((file: { excerpt?: string }) => file.excerpt === undefined)).toBe(true);
      expect(JSON.stringify({ contract, evidence })).not.toContain(cwd);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("profile target-root override keeps the portable contract identity stable across isolated copies", async () => {
    const baselineRoot = await tmp("awb-target-baseline-");
    const candidateRoot = await tmp("awb-target-candidate-");
    const baselineOut = await tmp("awb-profile-baseline-");
    const candidateOut = await tmp("awb-profile-candidate-");
    const fixtureRoot = path.join(cwd, "fixtures", "repos", "minimal-directory-agent");
    try {
      await cp(fixtureRoot, baselineRoot, { recursive: true });
      await cp(fixtureRoot, candidateRoot, { recursive: true });
      await execa(
        "npm",
        ["run", "benchmark", "--", "profile", "--target", "minimal-directory-agent", "--target-root", baselineRoot, "--out", baselineOut],
        { cwd }
      );
      await execa(
        "npm",
        ["run", "benchmark", "--", "profile", "--target", "minimal-directory-agent", "--target-root", candidateRoot, "--out", candidateOut],
        { cwd }
      );

      const baseline = JSON.parse(await readFile(path.join(baselineOut, "contract-model.json"), "utf8"));
      const candidate = JSON.parse(await readFile(path.join(candidateOut, "contract-model.json"), "utf8"));
      expect(baseline.contractHash).toBe(candidate.contractHash);
      expect(baseline.root).toBe("target://root");
      expect(candidate.root).toBe("target://root");
      expect(JSON.stringify({ baseline, candidate })).not.toContain(baselineRoot);
      expect(JSON.stringify({ baseline, candidate })).not.toContain(candidateRoot);
    } finally {
      await rm(baselineRoot, { recursive: true, force: true });
      await rm(candidateRoot, { recursive: true, force: true });
      await rm(baselineOut, { recursive: true, force: true });
      await rm(candidateOut, { recursive: true, force: true });
    }
  });

  test("init-target generates a reviewable target pack draft from agent files", async () => {
    const root = await tmp("awb-agent-root-");
    const out = await tmp("awb-init-target-");
    try {
      await mkdir(path.join(root, "orchestrator-agent"), { recursive: true });
      await mkdir(path.join(root, "worker-agent"), { recursive: true });
      await writeFile(
        path.join(root, "orchestrator-agent", "CLAUDE.md"),
        [
          "# Orchestrator Agent",
          "Owns triage and DoD. Statuses: PASS, FAILED, SKIPPED, ADVISORY.",
          "Routes implementation to worker-agent and records deliverables/implementation-plan.md.",
          "Never use --prod-write."
        ].join("\n")
      );
      await writeFile(
        path.join(root, "worker-agent", "CLAUDE.md"),
        [
          "# Worker Agent",
          "Owns implementation work and returns deliverables/test-design.md to orchestrator-agent.",
          "Reads process/workflow-state.json before continuing blocked work."
        ].join("\n")
      );

      const draftPath = path.join(out, "generated-agent.draft.yaml");
      const gapsPath = path.join(out, "generated-agent.gaps.md");
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "init-target",
          "--agent-root",
          root,
          "--target-id",
          "generated-agent",
          "--name",
          "Generated Agent",
          "--out",
          draftPath,
          "--gaps-out",
          gapsPath
        ],
        { cwd }
      );

      const draft = YAML.parse(await readFile(draftPath, "utf8"));
      await expectValidSchema("schemas/target-pack.schema.json", draft);
      expect(draft).toMatchObject({
        schemaVersion: "0.1.0",
        id: "generated-agent",
        name: "Generated Agent",
        targetType: "directory",
        contractReview: {
          status: "draft"
        },
        entrypoints: [{ id: "orchestrator-agent", kind: "file", path: "orchestrator-agent/CLAUDE.md" }],
        commandPolicy: {
          allowedExecutables: ["node", "npm"],
          forbiddenArgs: ["--prod-write"]
        }
      });
      expect(draft.roles.map((role: { id: string }) => role.id)).toEqual(["orchestrator-agent", "worker-agent"]);
      expect(draft.contracts.requiredOwners).toMatchObject({ triage: "orchestrator-agent", implementation: "worker-agent" });
      expect(draft.contracts.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(
        expect.arrayContaining(["deliverables/implementation-plan.md", "deliverables/test-design.md"])
      );
      expect(draft.contracts.states.map((state: { path: string }) => state.path)).toContain("process/workflow-state.json");
      const gaps = await readFile(gapsPath, "utf8");
      expect(gaps).toContain("Review required");
      expect(gaps).toContain("generated-agent");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test("materialize writes smoke cases and manifest", async () => {
    const out = await tmp("awb-cases-");
    try {
      await execa("npm", ["run", "benchmark", "--", "materialize", "--target", "minimal-directory-agent", "--suite", "smoke", "--out", out], { cwd });

      const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
      expect(manifest.caseIds).toHaveLength(22);
      await expect(stat(path.join(out, "minimal-directory-agent-smoke-006-required-join.yaml"))).resolves.toBeTruthy();
      await expect(
        stat(
          path.join(
            out,
            "minimal-directory-agent-smoke-019-safety-memory-poison-probe.yaml"
          )
        )
      ).resolves.toBeTruthy();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("materialize writes AI-first cases from a planner artifact", async () => {
    const out = await tmp("awb-ai-cases-");
    const planDir = await tmp("awb-ai-plan-");
    try {
      const planPath = path.join(planDir, "plan.json");
      const planSecret = ["sk", "-proj-", "materialize-secret"].join("");
      const planEmail = ["planner", "@", "example", ".com"].join("");
      const planPathValue = ["/", "opt", "/", "workflow", "/", "private.md"].join("");
      const targetSourceExcerpt = "Owns triage, orchestration, gates, and final DoD.";
      await writeFile(
        planPath,
        JSON.stringify(
          {
            planner: "fixture",
            model: "fixture-model",
            targetUnderstanding: `The workflow has explicit owner handoff and artifact gates. ${targetSourceExcerpt} ${planSecret} ${planEmail} ${planPathValue}`,
            cases: [
              {
                id: "owner-artifact-gate",
                title: "Owner writes declared artifact before PASS gate",
                riskFocus: `owner routing and artifact/gate ordering ${targetSourceExcerpt} ${planSecret}`,
                operationSequence: ["invoke primary role", "verify owner handoff", "verify artifact write"],
                oracleIds: ["oracle-ai-owner-artifact-gate"],
                expectedHardFailures: [],
                coverageTags: ["dimension:owner-routing", "dimension:artifacts", "role:orchestrator-agent"],
                scoringRubric: ["Owner and artifact evidence must match the contract."],
                bindings: { primaryRole: "orchestrator-agent", owner: "orchestrator-agent", artifactPath: "deliverables/implementation-plan.md" }
              }
            ]
          },
          null,
          2
        )
      );

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "materialize",
          "--target",
          "minimal-directory-agent",
          "--suite",
          "smoke",
          "--strategy",
          "ai",
          "--ai-plan",
          planPath,
          "--out",
          out
        ],
        { cwd }
      );

      const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
      expect(manifest.generation.mode).toBe("ai-first");
      expect(manifest.generation.planner).toBe("fixture");
      expect(manifest.generation.validation.status).not.toBe("FAIL");
      expect(manifest.caseIds).toHaveLength(1);
      const validation = JSON.parse(await readFile(path.join(out, "ai-case-plan-validation.json"), "utf8"));
      expect(validation.coveredCoverageTargetIds).toContain("dimension:artifacts");
      const testCase = await readFile(path.join(out, "minimal-directory-agent-ai-001-owner-artifact-gate.yaml"), "utf8");
      expect(testCase).toContain("Risk focus: owner routing and artifact/gate ordering");
      expect(testCase).toContain("coverageTags");
      expect(testCase).toContain("mode: ai-first");
      const persistedArtifacts = `${JSON.stringify(manifest)}\n${testCase}`;
      expect(persistedArtifacts).not.toContain(planSecret);
      expect(persistedArtifacts).not.toContain(planEmail);
      expect(persistedArtifacts).not.toContain(planPathValue);
      expect(persistedArtifacts).not.toContain(targetSourceExcerpt);
      expect(persistedArtifacts).toContain("<redacted>");
      expect(persistedArtifacts).toContain("<email>");
      expect(persistedArtifacts).toContain("<absolute-path>");
    } finally {
      await rm(out, { recursive: true, force: true });
      await rm(planDir, { recursive: true, force: true });
    }
  });

  test("plan-cases writes an AI case-plan artifact", async () => {
    const out = await tmp("awb-plan-cases-");
    try {
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "plan-cases",
          "--target",
          "minimal-directory-agent",
          "--runner",
          "fixture",
          "--max-cases",
          "2",
          "--out",
          out
        ],
        { cwd }
      );

      const plan = JSON.parse(await readFile(path.join(out, "ai-case-plan.json"), "utf8"));
      expect(plan.planner).toBe("fixture");
      expect(plan.coverageMode).toBe("smoke");
      expect(plan.targetUnderstanding).toContain("minimal-directory-agent");
      expect(plan.cases).toHaveLength(2);
      expect(plan.workflowUnderstanding.goal).toContain("minimal-directory-agent");
      expect(plan.cases[0].coverageTags.length).toBeGreaterThan(0);
      const validation = JSON.parse(await readFile(path.join(out, "ai-case-plan-validation.json"), "utf8"));
      expect(validation.coverageMode).toBe("smoke");
      expect(validation.recommendedCaseCount).toBeGreaterThan(8);
      expect(validation.invalidBindings).toEqual([]);
      const persistedPrompt = await readFile(path.join(out, "ai-case-planner-prompt.txt"), "utf8");
      const persistedResponse = JSON.parse(await readFile(path.join(out, "ai-case-planner-response.json"), "utf8"));
      expect(persistedPrompt).not.toContain("Owns triage and definition of done");
      expect(persistedResponse).toMatchObject({
        contentRedacted: true,
        contentHash: expect.stringMatching(/^sha256:/),
        planner: "fixture"
      });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("plan-cases redacts secrets, identity, local paths, and verbatim source excerpts returned by a live planner", async () => {
    const out = await tmp("awb-plan-private-");
    const fakeRoot = await tmp("awb-plan-runner-");
    try {
      const fakeCodex = path.join(fakeRoot, "codex");
      const planSecret = ["sk", "-proj-", "planner-private-value"].join("");
      const planEmail = ["planner", "@", "example", ".com"].join("");
      const planPathValue = ["/", "Users", "/", "example", "/", "private", "/", "source.md"].join("");
      const sourceExcerpt = ["Owns triage, orchestration,", " gates, and final DoD."].join("");
      const privateText = [planSecret, planEmail, planPathValue, sourceExcerpt].join(" ");
      const fakePlan = {
        targetUnderstanding: `Target summary ${privateText}`,
        workflowUnderstanding: {
          goal: `Goal ${privateText}`,
          stages: [`stage ${privateText}`],
          criticalInvariants: [`invariant ${privateText}`],
          scoringSignals: [`signal ${privateText}`]
        },
        cases: [
          {
            id: "private-plan-output",
            title: `Title ${privateText}`,
            riskFocus: `Risk ${privateText}`,
            operationSequence: [`operate ${privateText}`],
            oracleIds: ["oracle-private-plan"],
            expectedHardFailures: [],
            coverageTags: ["dimension:entrypoint"],
            scoringRubric: [`rubric ${privateText}`],
            bindings: { primaryRole: "orchestrator-agent" }
          }
        ]
      };
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const outIndex = process.argv.indexOf('-o');",
          `fs.writeFileSync(process.argv[outIndex + 1], ${JSON.stringify(JSON.stringify(fakePlan))});`
        ].join("\n"),
        { mode: 0o755 }
      );

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "plan-cases",
          "--target",
          "minimal-directory-agent",
          "--runner",
          "codex",
          "--max-cases",
          "1",
          "--out",
          out
        ],
        { cwd, env: { AWB_CODEX_EXECUTABLE: fakeCodex } }
      );

      const persistedPlan = await readFile(path.join(out, "ai-case-plan.json"), "utf8");
      for (const privateValue of [planSecret, planEmail, planPathValue, sourceExcerpt]) {
        expect(persistedPlan).not.toContain(privateValue);
      }
      expect(persistedPlan).toContain("<redacted>");
      expect(persistedPlan).toContain("<email>");
      expect(persistedPlan).toContain("<absolute-path>");
    } finally {
      await rm(out, { recursive: true, force: true });
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  test("plan-cases honors full coverage mode in planner artifacts", async () => {
    const out = await tmp("awb-plan-full-");
    try {
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "plan-cases",
          "--target",
          "minimal-directory-agent",
          "--runner",
          "fixture",
          "--coverage-mode",
          "full",
          "--max-cases",
          "80",
          "--out",
          out
        ],
        { cwd }
      );

      const plan = JSON.parse(await readFile(path.join(out, "ai-case-plan.json"), "utf8"));
      const validation = JSON.parse(await readFile(path.join(out, "ai-case-plan-validation.json"), "utf8"));
      expect(plan.coverageMode).toBe("full");
      expect(validation.coverageMode).toBe("full");
      expect(validation.recommendedCaseCount).toBeGreaterThanOrEqual(32);
      expect(validation.invalidBindings).toEqual([]);
      expect(plan.cases.length).toBeGreaterThan(3);
      expect(plan.cases.some((testCase: { id: string }) => testCase.id === "coverage-role-worker-agent")).toBe(true);
      expect(plan.cases.some((testCase: { id: string }) => testCase.id === "coverage-join-review-summary-return")).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("run executes materialized AI cases from a cases directory", async () => {
    const casesOut = await tmp("awb-ai-run-cases-");
    const planDir = await tmp("awb-ai-run-plan-");
    const runOut = await tmp("awb-ai-run-");
    try {
      const planPath = path.join(planDir, "plan.json");
      await writeFile(
        planPath,
        JSON.stringify(
          {
            planner: "fixture",
            targetUnderstanding: "The workflow has an owner-gated artifact path.",
            cases: [
              {
                id: "owner-artifact-gate",
                title: "Owner writes declared artifact before PASS gate",
                riskFocus: "owner routing and artifact/gate ordering",
                operationSequence: ["invoke primary role", "verify owner handoff", "verify artifact write"],
                oracleIds: ["oracle-ai-owner-artifact-gate"],
                expectedHardFailures: [],
                coverageTags: ["dimension:owner-routing", "dimension:artifacts", "role:orchestrator-agent"],
                scoringRubric: ["Owner and artifact evidence must match the contract."],
                bindings: { primaryRole: "orchestrator-agent", owner: "orchestrator-agent", artifactPath: "deliverables/implementation-plan.md" }
              }
            ]
          },
          null,
          2
        )
      );
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "materialize",
          "--target",
          "minimal-directory-agent",
          "--strategy",
          "ai",
          "--ai-plan",
          planPath,
          "--out",
          casesOut
        ],
        { cwd }
      );

      await execa(
        "npm",
        ["run", "benchmark", "--", "run", "--cases-dir", casesOut, "--runner", "codex", "--out", runOut],
        {
          cwd,
          env: { AWB_CODEX_EXECUTABLE: process.execPath }
        }
      );

      const manifest = JSON.parse(await readFile(path.join(runOut, "runtime-manifest.json"), "utf8"));
      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      await expectValidSchema("schemas/runtime-manifest.schema.json", manifest);
      expect(manifest.caseCount).toBe(1);
      expect(suite.caseResults[0].caseId).toBe("minimal-directory-agent-ai-001-owner-artifact-gate");
    } finally {
      await rm(casesOut, { recursive: true, force: true });
      await rm(planDir, { recursive: true, force: true });
      await rm(runOut, { recursive: true, force: true });
    }
  });

  test("run propagates AI plan validation warnings from a provided cases directory", async () => {
    const casesOut = await tmp("awb-ai-warn-cases-");
    const planDir = await tmp("awb-ai-warn-plan-");
    const runOut = await tmp("awb-ai-warn-run-");
    const dryRunOut = await tmp("awb-ai-warn-dry-run-");
    try {
      const planPath = path.join(planDir, "plan.json");
      await writeFile(
        planPath,
        JSON.stringify(
          {
            planner: "external",
            targetUnderstanding: "A legacy external plan with enough executable case data but weak harness evidence.",
            cases: [
              {
                id: "owner-artifact-gate",
                title: "Owner writes declared artifact before PASS gate",
                riskFocus: "owner routing and artifact/gate ordering",
                operationSequence: ["invoke primary role", "verify owner handoff", "verify artifact write"],
                oracleIds: ["oracle-ai-owner-artifact-gate"],
                expectedHardFailures: [],
                coverageTags: ["dimension:owner-routing", "dimension:artifacts", "role:orchestrator-agent"],
                scoringRubric: ["Owner and artifact evidence must match the contract."],
                bindings: {
                  primaryRole: "orchestrator-agent",
                  owner: "orchestrator-agent",
                  artifactPath: "deliverables/implementation-plan.md"
                }
              }
            ]
          },
          null,
          2
        )
      );
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "materialize",
          "--target",
          "minimal-directory-agent",
          "--strategy",
          "ai",
          "--ai-plan",
          planPath,
          "--out",
          casesOut
        ],
        { cwd }
      );

      const validation = JSON.parse(
        await readFile(path.join(casesOut, "ai-case-plan-validation.json"), "utf8")
      );
      expect(validation.status).toBe("WARN");

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--cases-dir",
          casesOut,
          "--runner",
          "simulated",
          "--out",
          runOut
        ],
        { cwd }
      );
      const suiteResult = JSON.parse(
        await readFile(path.join(runOut, "suite-result.json"), "utf8")
      );
      expect(suiteResult.harnessValidation.status).toBe("WARN");
      expect(suiteResult.harnessValidation.plan.status).toBe("WARN");
      expect(suiteResult.releaseDecision).toBe("DIAGNOSTIC_ONLY");
      expect(suiteResult.releaseRuleId).toBe("REL-HARNESS-VALIDATION-WARN");
      await expect(stat(path.join(runOut, "harness-validation.json"))).resolves.toBeTruthy();

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--cases-dir",
          casesOut,
          "--runner",
          "simulated",
          "--dry-run",
          "--out",
          dryRunOut
        ],
        { cwd }
      );
      const dryRunSuiteResult = JSON.parse(
        await readFile(path.join(dryRunOut, "suite-result.json"), "utf8")
      );
      expect(dryRunSuiteResult.harnessValidation.status).toBe("WARN");
      expect(dryRunSuiteResult.releaseRuleId).toBe("REL-HARNESS-VALIDATION-WARN");
    } finally {
      await rm(casesOut, { recursive: true, force: true });
      await rm(planDir, { recursive: true, force: true });
      await rm(runOut, { recursive: true, force: true });
      await rm(dryRunOut, { recursive: true, force: true });
    }
  });

  test("run and report produce readable suite artifacts", async () => {
    const out = await tmp("awb-run-");
    try {
      await execa(
        "npm",
        ["run", "benchmark", "--", "run", "--target", "minimal-directory-agent", "--suite", "smoke", "--runner", "codex", "--out", out],
        {
          cwd,
          env: { AWB_CODEX_EXECUTABLE: process.execPath }
        }
      );
      const suite = JSON.parse(await readFile(path.join(out, "suite-result.json"), "utf8"));
      expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");

      await execa("npm", ["run", "benchmark", "--", "report", "--run", out, "--format", "md,json"], { cwd });
      const report = await readFile(path.join(out, "report.md"), "utf8");
      expect(report).toContain("Benchmark Evidence Decision: DIAGNOSTIC_ONLY");
      expect(report).toContain("Decision Scope: collected benchmark evidence only");
      expect(report).toContain("Dimension Scores");
      expect(report).toContain("Agent Modification Recommendations");
      expect(report).toContain("debugHealth");

      const score = await execa("npm", ["run", "benchmark", "--", "score", "--run", out], { cwd });
      const scoreLines = score.stdout.trim().split("\n");
      const scoreJsonLine = [...scoreLines].reverse().find((line: string) => line.trim().startsWith("{"));
      expect(scoreJsonLine).toBeDefined();
      const scoreJson = JSON.parse(scoreJsonLine!) as { benchmarkEvidenceDecision: string; releaseDecision: string; scope: string };
      expect(scoreJson.benchmarkEvidenceDecision).toBe("DIAGNOSTIC_ONLY");
      expect(scoreJson.releaseDecision).toBe("DIAGNOSTIC_ONLY");
      expect(scoreJson.scope).toContain("collected benchmark evidence only");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("run writes portable, integrity-bound provenance with an honest simulated evidence boundary", async () => {
    const out = await tmp("awb-provenance-");
    try {
      await execa(
        "npm",
        ["run", "benchmark", "--", "run", "--target", "minimal-directory-agent", "--suite", "smoke", "--runner", "simulated", "--out", out],
        { cwd }
      );

      const provenance = JSON.parse(await readFile(path.join(out, "provenance.json"), "utf8"));
      await expectValidSchema("schemas/provenance.schema.json", provenance);
      expect(provenance.product).toBe("Agent Workflow Bench");
      expect(provenance.subject).toMatchObject({
        targetId: "minimal-directory-agent",
        contractHash: expect.stringMatching(/^sha256:/),
        contentHash: expect.stringMatching(/^sha256:/)
      });
      expect(provenance.conditions).toMatchObject({
        suite: "smoke",
        caseSetHash: expect.stringMatching(/^sha256:/),
        executionMode: "simulated",
        evidenceKind: "simulated",
        observationLevel: "synthetic_events"
      });
      expect(provenance.integrity.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ref: "suite-result.json",
            sha256: expect.stringMatching(/^sha256:/)
          })
        ])
      );

      const runtime = JSON.parse(await readFile(path.join(out, "runtime-manifest.json"), "utf8"));
      await expectValidSchema("schemas/runtime-manifest.schema.json", runtime);
      const persisted = JSON.stringify({ provenance, runtime });
      expect(persisted).not.toContain(cwd);
      expect(persisted).not.toContain(out);
      expect(persisted).not.toMatch(/\/(?:Users|home)\/[^/]+/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("run persists P0 case records locally when hard failures are observed", async () => {
    const casesOut = await tmp("awb-p0-cases-");
    const runOut = await tmp("awb-p0-run-");
    const p0Log = path.join(runOut, "persistent", "p0-cases.jsonl");
    try {
      await execa("npm", ["run", "benchmark", "--", "materialize", "--target", "minimal-directory-agent", "--suite", "smoke", "--out", casesOut], {
        cwd
      });
      const casePath = path.join(casesOut, "minimal-directory-agent-smoke-003-forbidden-route.yaml");

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--case",
          casePath,
          "--runner",
          "simulated",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--out",
          runOut,
          "--p0-case-log",
          p0Log
        ],
        { cwd }
      );

      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      expect(suite.p0CaseRecords).toHaveLength(1);
      expect(suite.p0CaseRecords[0].failureCode).toBe("TARGET_ROUTE_FORBIDDEN");
      const p0Cases = JSON.parse(await readFile(path.join(runOut, "p0-cases.json"), "utf8"));
      expect(p0Cases[0].caseId).toBe("minimal-directory-agent-smoke-003-forbidden-route");
      const p0Markdown = await readFile(path.join(runOut, "p0-cases.md"), "utf8");
      expect(p0Markdown).toContain("TARGET_ROUTE_FORBIDDEN");
      const recommendations = JSON.parse(await readFile(path.join(runOut, "recommendations.json"), "utf8"));
      expect(recommendations[0].category).toBe("routing");
      const recommendationMarkdown = await readFile(path.join(runOut, "recommendations.md"), "utf8");
      expect(recommendationMarkdown).toContain("Forbidden workflow route");
      const jsonl = await readFile(p0Log, "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(jsonl).caseId).toBe("minimal-directory-agent-smoke-003-forbidden-route");
    } finally {
      await rm(casesOut, { recursive: true, force: true });
      await rm(runOut, { recursive: true, force: true });
    }
  });

  test("run gate mode exits non-zero on blocked suite after writing artifacts", async () => {
    const casesOut = await tmp("awb-gate-cases-");
    const runOut = await tmp("awb-gate-run-");
    try {
      await execa("npm", ["run", "benchmark", "--", "materialize", "--target", "minimal-directory-agent", "--suite", "smoke", "--out", casesOut], {
        cwd
      });
      const casePath = path.join(casesOut, "minimal-directory-agent-smoke-003-forbidden-route.yaml");

      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--case",
          casePath,
          "--runner",
          "simulated",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--mode",
          "gate",
          "--out",
          runOut
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Gate mode blocked run");
      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      expect(suite.releaseDecision).toBe("BLOCK");
      expect(suite.releaseRuleId).toBe("REL-P0-WORKFLOW-HARD-FAIL");
      await expect(stat(path.join(runOut, "p0-cases.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(runOut, "recommendations.json"))).resolves.toBeTruthy();
    } finally {
      await rm(casesOut, { recursive: true, force: true });
      await rm(runOut, { recursive: true, force: true });
    }
  });

  test("run gate mode exits non-zero on diagnostic-only suites after writing artifacts", async () => {
    const runOut = await tmp("awb-gate-diagnostic-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--target",
          "minimal-directory-agent",
          "--suite",
          "smoke",
          "--runner",
          "simulated",
          "--mode",
          "gate",
          "--out",
          runOut
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Gate mode blocked run");
      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
      expect(suite.releaseRuleId).toBe("REL-EVIDENCE-SIMULATED");
    } finally {
      await rm(runOut, { recursive: true, force: true });
    }
  });

  test("run rejects mutation overlays for live execution", async () => {
    const out = await tmp("awb-live-mutation-run-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--target",
          "minimal-directory-agent",
          "--suite",
          "smoke",
          "--runner",
          "simulated",
          "--execution",
          "live",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("--mutation is only supported for simulated execution");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("evaluate runs the complete AI-first workflow and writes report, suggestions, and P0 log", async () => {
    const out = await tmp("awb-evaluate-");
    try {
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "evaluate",
          "--target",
          "minimal-directory-agent",
          "--planner-runner",
          "fixture",
          "--runner",
          "simulated",
          "--execution",
          "simulated",
          "--suite",
          "full-regression",
          "--max-cases",
          "2",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--out",
          out
        ],
        { cwd }
      );

      await expect(stat(path.join(out, "profile", "contract-model.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(out, "ai-plan", "ai-case-plan.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(out, "cases", "manifest.json"))).resolves.toBeTruthy();
      const manifest = JSON.parse(await readFile(path.join(out, "cases", "manifest.json"), "utf8"));
      expect(manifest.suite).toBe("full-regression");
      const firstCase = await readFile(path.join(out, "cases", `${manifest.caseIds[0]}.yaml`), "utf8");
      expect(firstCase).toContain("suite: full-regression");
      const suite = JSON.parse(await readFile(path.join(out, "run", "suite-result.json"), "utf8"));
      await expectValidSchema("schemas/suite-result.schema.json", suite);
      const missingContractDiagnostics = structuredClone(suite);
      delete missingContractDiagnostics.contractDiagnostics;
      await expectInvalidSchema(
        "schemas/suite-result.schema.json",
        missingContractDiagnostics
      );
      expect(suite.suite).toBe("full-regression");
      expect(suite.dimensionScores.length).toBeGreaterThan(3);
      expect(suite.recommendations.length).toBeGreaterThan(0);
      expect(suite.p0CaseRecords.length).toBeGreaterThan(0);
      expect(suite.p0CaseRecords[0].suite).toBe("full-regression");
      const report = await readFile(path.join(out, "run", "report.md"), "utf8");
      expect(report).toContain("Agent Modification Recommendations");
      expect(report).toContain("Harness Validation");
      await expect(stat(path.join(out, "run", "p0-cases.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(out, "run", "recommendations.json"))).resolves.toBeTruthy();
      const summary = JSON.parse(await readFile(path.join(out, "evaluation-summary.json"), "utf8"));
      expect(summary.targetId).toBe("minimal-directory-agent");
      expect(summary.suite).toBe("full-regression");
      expect(summary.harness.plan.status).toBeDefined();
      expect(summary.harness.plan.invalidBindingCount).toBe(0);
      expect(summary.harness.artifacts.harnessValidation).toBe("run/harness-validation.json");
      expect(summary.artifacts.report).toBe("run/report.md");
      expect(summary.artifacts.recommendations).toBe("run/recommendations.json");
      expect(summary.artifacts.provenance).toBe("run/provenance.json");
      expect(JSON.stringify(summary)).not.toContain(out);
      await expect(stat(path.join(out, summary.artifacts.provenance))).resolves.toBeTruthy();
      await expect(stat(path.join(out, "run", "harness-validation.json"))).resolves.toBeTruthy();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("evaluate rejects mutation overlays for live execution", async () => {
    const out = await tmp("awb-live-mutation-evaluate-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "evaluate",
          "--target",
          "minimal-directory-agent",
          "--planner-runner",
          "fixture",
          "--runner",
          "simulated",
          "--execution",
          "live",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("--mutation is only supported for simulated execution");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("debug reverse-validate writes killed mutation result", async () => {
    const casesOut = await tmp("awb-debug-cases-");
    const debugOut = await tmp("awb-debug-run-");
    const runOut = await tmp("awb-debug-suite-");
    try {
      await execa(
        "npm",
        ["run", "benchmark", "--", "run", "--target", "minimal-directory-agent", "--suite", "smoke", "--runner", "simulated", "--out", runOut],
        { cwd }
      );
      await execa("npm", ["run", "benchmark", "--", "materialize", "--target", "minimal-directory-agent", "--suite", "smoke", "--out", casesOut], {
        cwd
      });
      const casePath = path.join(casesOut, "minimal-directory-agent-smoke-006-required-join.yaml");
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--case",
          casePath,
          "--mutation",
          "fixtures/mutations/join-callback-drop.yaml",
          "--runner",
          "simulated",
          "--suite-result",
          path.join(runOut, "suite-result.json"),
          "--out",
          debugOut
        ],
        { cwd }
      );
      const result = JSON.parse(await readFile(path.join(debugOut, "reverse-validation-result.json"), "utf8"));
      expect(result.status).toBe("PASS");
      expect(result.runner).toBe("simulated");
      expect(result.mutationScope).toBe("overlay-only");
      expect(result.expectationMatched).toBe(true);
      expect(result.mutationKilled).toBe(true);
      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      expect(suite.debugHealth.status).toBe("PASS");
      expect(suite.debugHealth.mutationKillRate).toBe(1);

      const diagnosisOut = path.join(debugOut, "diagnosis");
      await execa("npm", ["run", "benchmark", "--", "debug", "diagnose", "--debug-run", debugOut, "--out", diagnosisOut], { cwd });
      const dossier = JSON.parse(await readFile(path.join(diagnosisOut, "debug-dossier.json"), "utf8"));
      expect(dossier.targetId).toBe("minimal-directory-agent");
      expect(dossier.caseId).toBe("minimal-directory-agent-smoke-006-required-join");
      expect(dossier.gapClassification).toBe("none");
      await expect(stat(path.join(diagnosisOut, "debug-dossier.md"))).resolves.toBeTruthy();

      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "propose-fix",
          "--dossier",
          path.join(diagnosisOut, "debug-dossier.json"),
          "--out",
          path.join(diagnosisOut, "repair-plan.md")
        ],
        { cwd }
      );
      const repairPlan = JSON.parse(await readFile(path.join(diagnosisOut, "repair-plan.json"), "utf8"));
      expect(repairPlan.allowedApplyScope).toBe("benchmark-repo-only");
      expect(repairPlan.targetWorkflowModificationAllowed).toBe(false);

      await execa("npm", ["run", "benchmark", "--", "debug", "repair", "--dossier", path.join(diagnosisOut, "debug-dossier.json"), "--apply", "--rerun"], {
        cwd
      });
      const repairResult = JSON.parse(await readFile(path.join(diagnosisOut, "repair-result.json"), "utf8"));
      expect(repairResult.status).toBe("NOOP");
      expect(repairResult.targetWorkflowModified).toBe(false);
    } finally {
      await rm(casesOut, { recursive: true, force: true });
      await rm(debugOut, { recursive: true, force: true });
      await rm(runOut, { recursive: true, force: true });
    }
  });

  test("debug diagnose supports mutation-set reverse validation output", async () => {
    const debugOut = await tmp("awb-debug-set-");
    try {
      await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation-set",
          "fixtures/mutations/core.yaml",
          "--runner",
          "simulated",
          "--out",
          debugOut
        ],
        { cwd }
      );

      const diagnosisOut = path.join(debugOut, "diagnosis");
      await execa("npm", ["run", "benchmark", "--", "debug", "diagnose", "--debug-run", debugOut, "--out", diagnosisOut], { cwd });

      const dossier = JSON.parse(await readFile(path.join(diagnosisOut, "debug-dossier.json"), "utf8"));
      expect(dossier.debugId).toBe(path.basename(debugOut));
      expect(dossier.targetId).toBe("minimal-directory-agent");
      expect(dossier.mutationId).toBe("aggregate");
      expect(dossier.gapClassification).toBe("none");
      expect(dossier.summary.mutationCount).toBe(5);
      expect(dossier.summary.mutationKillRate).toBe(1);
      await expect(stat(path.join(diagnosisOut, "debug-dossier.md"))).resolves.toBeTruthy();
    } finally {
      await rm(debugOut, { recursive: true, force: true });
    }
  });

  test("debug reverse-validate rejects non-overlay mutation scopes and empty mutation sets", async () => {
    const debugOut = await tmp("awb-debug-invalid-mutation-");
    const fixtureDir = await tmp("awb-debug-invalid-fixtures-");
    try {
      const liveScopeMutation = path.join(fixtureDir, "live-scope.yaml");
      const emptySet = path.join(fixtureDir, "empty-set.yaml");
      await writeFile(
        liveScopeMutation,
        [
          "schemaVersion: 0.1.0",
          "id: live-scope",
          "type: route-break",
          "description: invalid non-overlay scope",
          "scope: live",
          "expectedOutcome:",
          "  verdict: FAIL",
          "  hardFailureCode: TARGET_ROUTE_FORBIDDEN"
        ].join("\n")
      );
      await writeFile(emptySet, "mutations: []\n");

      const nonOverlay = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation",
          liveScopeMutation,
          "--runner",
          "simulated",
          "--out",
          path.join(debugOut, "non-overlay")
        ],
        { cwd, reject: false }
      );
      expect(nonOverlay.exitCode).not.toBe(0);
      expect(`${nonOverlay.stdout}\n${nonOverlay.stderr}`).toContain("scope: overlay-only");

      const empty = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation-set",
          emptySet,
          "--runner",
          "simulated",
          "--out",
          path.join(debugOut, "empty")
        ],
        { cwd, reject: false }
      );
      expect(empty.exitCode).not.toBe(0);
      expect(`${empty.stdout}\n${empty.stderr}`).toContain("must include at least one mutation");
    } finally {
      await rm(debugOut, { recursive: true, force: true });
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("debug reverse-validate kills the complete 18-family mutation set", async () => {
    const debugOut = await tmp("awb-debug-set-fail-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation-set",
          "fixtures/mutations/extended.yaml",
          "--runner",
          "simulated",
          "--out",
          debugOut
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).toBe(0);
      const summary = JSON.parse(await readFile(path.join(debugOut, "debug-summary.json"), "utf8"));
      expect(summary.status).toBe("PASS");
      expect(summary.mutationKillRate).toBe(1);
      expect(summary.results).toHaveLength(18);
      expect(summary.results.every((item: { status: string }) => item.status === "PASS")).toBe(true);
    } finally {
      await rm(debugOut, { recursive: true, force: true });
    }
  });

  test("debug reverse-validate fails when the declared expected hard failure code is not observed", async () => {
    const debugOut = await tmp("awb-debug-code-mismatch-");
    const fixtureDir = await tmp("awb-debug-code-fixtures-");
    try {
      const mutationPath = path.join(fixtureDir, "wrong-code.yaml");
      await writeFile(
        mutationPath,
        [
          "schemaVersion: 0.1.0",
          "id: wrong-code",
          "type: route-break",
          "description: declare the wrong expected hard failure code",
          "scope: overlay-only",
          "expectedOutcome:",
          "  verdict: FAIL",
          "  hardFailureCode: TARGET_OWNER_BYPASS"
        ].join("\n")
      );

      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation",
          mutationPath,
          "--runner",
          "simulated",
          "--out",
          debugOut
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      const reverse = JSON.parse(await readFile(path.join(debugOut, "reverse-validation-result.json"), "utf8"));
      expect(reverse.expectedHardFailureCode).toBe("TARGET_OWNER_BYPASS");
      expect(reverse.expectedHardFailureMatched).toBe(false);
      expect(reverse.mutationKilled).toBe(false);
      expect(reverse.status).toBe("FAIL");
    } finally {
      await rm(debugOut, { recursive: true, force: true });
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("debug mutation-set expectation mismatches fail the aggregate summary and diagnosis", async () => {
    const debugOut = await tmp("awb-debug-set-expect-");
    try {
      const result = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation-set",
          "fixtures/mutations/extended.yaml",
          "--runner",
          "simulated",
          "--expect",
          "fail",
          "--out",
          debugOut
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).not.toBe(0);
      const summary = JSON.parse(await readFile(path.join(debugOut, "debug-summary.json"), "utf8"));
      expect(summary.status).toBe("FAIL");
      expect(summary.mutationKillRate).toBe(1);

      const diagnosisOut = path.join(debugOut, "diagnosis");
      await execa("npm", ["run", "benchmark", "--", "debug", "diagnose", "--debug-run", debugOut, "--out", diagnosisOut], { cwd });
      const dossier = JSON.parse(await readFile(path.join(diagnosisOut, "debug-dossier.json"), "utf8"));
      expect(dossier.gapClassification).toBe("oracle_gap");
      expect(dossier.summary.falseNegativeCount).toBeGreaterThan(0);
    } finally {
      await rm(debugOut, { recursive: true, force: true });
    }
  });

  test("debug reverse-validate rejects non-simulated overlay runner and enforces explicit expectation", async () => {
    const debugOut = await tmp("awb-debug-expect-");
    const nonSimulatedOut = await tmp("awb-debug-non-sim-");
    try {
      const nonSimulated = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--runner",
          "codex",
          "--out",
          nonSimulatedOut
        ],
        { cwd, reject: false }
      );
      expect(nonSimulated.exitCode).not.toBe(0);
      expect(nonSimulated.stderr).toContain("overlay-only mutations with --runner simulated only");

      const mismatch = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reverse-validate",
          "--target",
          "minimal-directory-agent",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--runner",
          "simulated",
          "--expect",
          "pass",
          "--out",
          debugOut
        ],
        { cwd, reject: false }
      );
      expect(mismatch.exitCode).not.toBe(0);
      const result = JSON.parse(await readFile(path.join(debugOut, "reverse-validation-result.json"), "utf8"));
      expect(result.expectationMatched).toBe(false);
      expect(result.status).toBe("FAIL");
    } finally {
      await rm(debugOut, { recursive: true, force: true });
      await rm(nonSimulatedOut, { recursive: true, force: true });
    }
  });
});
