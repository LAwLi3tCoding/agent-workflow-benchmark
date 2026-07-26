import { describe, expect, test } from "vitest";
import { access, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  hashFile,
  sha256Text,
  stableJson
} from "../src/utils/hash.js";

const pluginRoot = path.join(process.cwd(), "plugins", "agent-workflow-bench");

async function expectValidPluginRuntimeSchema(pluginPath: string, schemaPath: string, value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(pluginPath, "runtime", schemaPath), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

async function copyPluginInstall(): Promise<{ root: string; pluginPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "awb-plugin-install-"));
  const pluginPath = path.join(root, "agent-workflow-bench");
  await cp(pluginRoot, pluginPath, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}runtime${path.sep}node_modules`)
  });
  await rm(path.join(pluginPath, "runtime", "node_modules"), { recursive: true, force: true });
  return { root, pluginPath };
}

describe("agent workflow bench plugin package", () => {
  test("ships a Codex plugin manifest and shared skill", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));

    expect(manifest.name).toBe("agent-workflow-bench");
    expect(manifest.license).toBe("MIT");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.interface.displayName).toBe("Agent Workflow Bench");
    expect(
      [
        manifest.description,
        manifest.interface.shortDescription,
        manifest.interface.longDescription,
        ...(manifest.interface.defaultPrompt ?? [])
      ].join("\n")
    ).toMatch(/CI.*regression|regression.*CI/u);
    await expect(stat(path.join(pluginRoot, "skills", "agent-workflow-bench", "SKILL.md"))).resolves.toBeTruthy();
  });

  test("ships a Claude Code plugin manifest, slash command, and executable wrapper", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));

    expect(manifest.name).toBe("agent-workflow-bench");
    expect(manifest.license).toBe("MIT");
    expect(manifest.version).toMatch(/^0\.1\.0/);
    await expect(stat(path.join(pluginRoot, "commands", "agent-workflow-bench.md"))).resolves.toBeTruthy();
    await access(path.join(pluginRoot, "bin", "awb"));
    const command = await readFile(path.join(pluginRoot, "commands", "agent-workflow-bench.md"), "utf8");
    expect(command).toContain("doctor");
    expect(command).toContain("plan-cases");
    expect(command).toContain("materialize --strategy ai");
    expect(command).toContain("run --execution live");
    expect(command).toContain("ingest-trace");
    expect(command).toContain("observer qualify");
    expect(command).toContain("--trusted-qualification-key");
    expect(command).toContain("compare");
    expect(command).toContain("gate");
    expect(command).toContain("gate-policy calibrate");
    expect(command).toContain("gate-policy validate-holdout");
    expect(command).toContain("artifact migrate");
    expect(command).toContain("adapter conformance");
    expect(command).toContain("ci benchmark-health");
    expect(command).toContain("ci prepare-authorization");
    expect(command).toContain("ci finalize-authorization");
    expect(command).toContain("report runner-ranking");
  });

  test("ships a self-contained plugin runtime for installs without a source checkout", async () => {
    const runtimeRoot = path.join(pluginRoot, "runtime");

    await expect(stat(path.join(runtimeRoot, "package.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "package-lock.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "dist", "src", "cli", "index.js"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "configs", "targets", "registry.yaml"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "case.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "doctor-result.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "provenance.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "workflow-trace.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "observer-qualification.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "comparison-result.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "gate-result.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "reliability-study.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "reliability-report.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "gold-corpus.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "gold-corpus-report.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "external-validity-study.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "external-validity-labeling-package.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "external-validity-agent-prelabels.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "external-validity-observations.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "external-validity-human-labels.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "production-blocking-authorization-request.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "validity-report.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "gate-policy.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "calibration-report.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "contract-model.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "profile-evidence.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "generation-manifest.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "runtime-manifest.schema.json"))).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "artifact-schema-registry.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "artifact-compatibility-matrix.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "artifact-migration-result.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "decision-report.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "trace-diff.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "trend-report.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "html-viewer-manifest.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "adapter-contract.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "adapter-conformance-report.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "benchmark-health-report.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "schemas", "runner-ranking-report.schema.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "configs", "artifacts", "schema-registry.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "configs", "artifacts", "compatibility-matrix.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "configs", "evaluation", "gate-policy.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "configs", "adapters", "opencode.json"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "configs", "adapters", "reference-observer.json"))
    ).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "fixtures", "mutations", "core.yaml"))).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "fixtures", "gold-corpus", "v1", "manifest.yaml"))
    ).resolves.toBeTruthy();
    await expect(
      stat(
        path.join(
          runtimeRoot,
          "fixtures",
          "calibration",
          "v1",
          "fit",
          "calibration-report.json"
        )
      )
    ).resolves.toBeTruthy();
    await expect(
      stat(
        path.join(
          runtimeRoot,
          "fixtures",
          "calibration",
          "v1",
          "holdout",
          "calibration-report.json"
        )
      )
    ).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "fixtures", "regression", "scenarios.yaml"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "dist", "src", "observer", "workflowTrace.js"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "dist", "src", "observer", "referenceObserver.js"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "dist", "src", "observer", "qualification.js"))).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "calibration", "gatePolicy.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "calibration", "policyArtifact.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "artifacts", "migration.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "artifacts", "registry.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "report", "decisionReport.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "report", "traceDiff.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "report", "trends.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "report", "htmlViewer.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "adapters", "sdk.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "adapters", "conformance.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "adapters", "openCodeAdapter.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "ci", "benchmarkHealth.js"))
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(runtimeRoot, "dist", "src", "report", "runnerRanking.js"))
    ).resolves.toBeTruthy();

    const wrapper = await readFile(path.join(pluginRoot, "bin", "awb"), "utf8");
    expect(wrapper).toContain("RUNTIME_DIR");
    expect(wrapper).not.toMatch(/\/(?:Users|home)\/[^/]+/);
  });

  test("plugin wrapper can run bundled runtime from an arbitrary working directory", async () => {
    const outsideCwd = await mkdtemp(path.join(tmpdir(), "awb-wrapper-cwd-"));
    const install = await copyPluginInstall();
    try {
      const result = await execa(path.join(install.pluginPath, "bin", "awb"), ["validate-schema"], {
        cwd: outsideCwd,
        env: { ...process.env, AWB_PROJECT_ROOT: "" }
      });

      expect(result.stdout).toContain("schemas valid");
      expect(result.stdout).toContain("runner configs valid");
      expect(result.stdout).toContain("adapter configs valid");
      const artifactHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["artifact", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(artifactHelp.stdout).toContain("migrate");
      const reportHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["report", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(reportHelp.stdout).toContain("decision");
      expect(reportHelp.stdout).toContain("trace-diff");
      expect(reportHelp.stdout).toContain("trend");
      expect(reportHelp.stdout).toContain("viewer");
      const legacyRuntimePath = path.join(
        outsideCwd,
        "runtime-manifest.json"
      );
      await writeFile(
        legacyRuntimePath,
        `${JSON.stringify(
          {
            attemptId: "attempt-plugin-stage7",
            runner: {
              schemaVersion: "0.1.0",
              name: "simulated",
              supported: true,
              adapterVersion: "0.1.0",
              executionMode: "simulated",
              supportsEntrypointKinds: ["file", "cli"],
              tokenSourceDetail: {
                source: "estimated",
                confidence: "medium"
              },
              comparability: {
                workflowScore: "comparable",
                efficiency: "directional_only",
                tokenCost: "directional_only"
              },
              capabilitiesHash:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            mode: "diagnostic",
            dryRun: false,
            seed: "plugin-stage7-seed",
            contractHash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            caseCount: 1,
            liveTranscriptCount: 0,
            caseSource: "target://materialized"
          },
          null,
          2
        )}\n`
      );
      const migrationOut = path.join(outsideCwd, "artifact-migration");
      const migration = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "artifact",
          "migrate",
          "--input",
          legacyRuntimePath,
          "--out",
          migrationOut
        ],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(migration.stdout).toContain("artifact migration MIGRATED");
      const migrationResult = JSON.parse(
        await readFile(
          path.join(migrationOut, "migration-result.json"),
          "utf8"
        )
      );
      const migratedRuntime = JSON.parse(
        await readFile(
          path.join(migrationOut, "migrated-artifact.json"),
          "utf8"
        )
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/artifact-migration-result.schema.json",
        migrationResult
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/runtime-manifest.schema.json",
        migratedRuntime
      );
      const corpus = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "gold-corpus",
          "validate",
          "--corpus",
          "fixtures/gold-corpus/v1/manifest.yaml"
        ],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(corpus.stdout).toContain("36 trajectories");
      const reliabilityHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["debug", "reliability", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(reliabilityHelp.stdout).toContain("--study");
      expect(reliabilityHelp.stdout).toContain("--out");
      const criterionValidityHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["criterion-validity", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(criterionValidityHelp.stdout).toContain("package");
      expect(criterionValidityHelp.stdout).toContain("analyze");
      const criterionAnalyzeHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["criterion-validity", "analyze", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(criterionAnalyzeHelp.stdout).toContain(
        "--trusted-observer-key"
      );
      expect(criterionAnalyzeHelp.stdout).toContain(
        "--trusted-qualification-key"
      );
      const gatePolicyHelp = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        ["gate-policy", "--help"],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(gatePolicyHelp.stdout).toContain("calibrate");
      expect(gatePolicyHelp.stdout).toContain("validate-holdout");
      const fitOut = path.join(outsideCwd, "gate-policy-fit");
      const fit = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "gate-policy",
          "calibrate",
          "--corpus",
          "fixtures/gold-corpus/v1/manifest.yaml",
          "--policy-version",
          "1.0.0",
          "--out",
          fitOut
        ],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" },
          reject: false
        }
      );
      expect(fit.exitCode).toBe(2);
      const calibratedPolicy = JSON.parse(
        await readFile(path.join(fitOut, "gate-policy.json"), "utf8")
      );
      const calibrationReport = JSON.parse(
        await readFile(
          path.join(fitOut, "calibration-report.json"),
          "utf8"
        )
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/gate-policy.schema.json",
        calibratedPolicy
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/calibration-report.schema.json",
        calibrationReport
      );
      const holdoutOut = path.join(outsideCwd, "gate-policy-holdout");
      const holdout = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "gate-policy",
          "validate-holdout",
          "--corpus",
          "fixtures/gold-corpus/v1/manifest.yaml",
          "--policy",
          path.join(fitOut, "gate-policy.json"),
          "--calibration-report",
          path.join(fitOut, "calibration-report.json"),
          "--out",
          holdoutOut
        ],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(holdout.stdout).toContain("holdout PASS");
      const holdoutReport = JSON.parse(
        await readFile(
          path.join(holdoutOut, "calibration-report.json"),
          "utf8"
        )
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/calibration-report.schema.json",
        holdoutReport
      );

      const observerKeys = generateKeyPairSync("ed25519");
      const authorityKeys = generateKeyPairSync("ed25519");
      const observerPrivateKey = path.join(outsideCwd, "observer-private.pem");
      const authorityPrivateKey = path.join(outsideCwd, "authority-private.pem");
      const qualificationOut = path.join(outsideCwd, "observer-qualification");
      await writeFile(
        observerPrivateKey,
        observerKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 }
      );
      await writeFile(
        authorityPrivateKey,
        authorityKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 }
      );
      const qualification = await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "observer",
          "qualify",
          "--target",
          "minimal-directory-agent",
          "--suite",
          "smoke",
          "--observer-id",
          "plugin-reference-observer",
          "--observer-version",
          "1.0.0",
          "--observer-private-key",
          observerPrivateKey,
          "--qualification-authority-private-key",
          authorityPrivateKey,
          "--out",
          qualificationOut
        ],
        {
          cwd: outsideCwd,
          env: { ...process.env, AWB_PROJECT_ROOT: "" }
        }
      );
      expect(qualification.stdout).toContain("Observer qualification valid");
      const artifact = JSON.parse(
        await readFile(
          path.join(qualificationOut, "observer-qualification.json"),
          "utf8"
        )
      );
      const runtimeSourceRoot = path.join(
        install.pluginPath,
        "runtime",
        "dist",
        "src"
      );
      const implementationComponents = [
        ["observer/referenceObserver", "observer/referenceObserver.js"],
        ["observer/workflowTrace", "observer/workflowTrace.js"],
        ["observer/qualification", "observer/qualification.js"],
        ["evaluation/evaluationContract", "evaluation/evaluationContract.js"],
        ["utils/hash", "utils/hash.js"],
        ["utils/redaction", "utils/redaction.js"]
      ] as const;
      expect(artifact.observer.implementationHash).toBe(
        sha256Text(
          stableJson({
            protocol: "awb-reference-observer-content/1",
            components: await Promise.all(
              implementationComponents.map(async ([id, relativePath]) => ({
                id,
                sha256: await hashFile(
                  path.join(runtimeSourceRoot, relativePath)
                )
              }))
            )
          })
        )
      );
      await expectValidPluginRuntimeSchema(
        install.pluginPath,
        "schemas/observer-qualification.schema.json",
        artifact
      );
    } finally {
      await rm(outsideCwd, { recursive: true, force: true });
      await rm(install.root, { recursive: true, force: true });
    }
  });

  test("plugin wrapper can run a bundled evaluate smoke and produce decision artifacts", async () => {
    const outsideCwd = await mkdtemp(path.join(tmpdir(), "awb-wrapper-eval-cwd-"));
    const install = await copyPluginInstall();
    const out = path.join(outsideCwd, "eval");
    try {
      await execa(
        path.join(install.pluginPath, "bin", "awb"),
        [
          "evaluate",
          "--target",
          "minimal-directory-agent",
          "--planner-runner",
          "fixture",
          "--runner",
          "simulated",
          "--execution",
          "simulated",
          "--max-cases",
          "1",
          "--mutation",
          "fixtures/mutations/route-break.yaml",
          "--out",
          out
        ],
        { cwd: outsideCwd, env: { ...process.env, AWB_PROJECT_ROOT: "" } }
      );

      const suite = JSON.parse(await readFile(path.join(out, "run", "suite-result.json"), "utf8"));
      await expectValidPluginRuntimeSchema(install.pluginPath, "schemas/suite-result.schema.json", suite);
      expect(suite.caseResults.length).toBeGreaterThan(0);
      expect(suite.p0CaseRecords.length).toBeGreaterThan(0);
      expect(suite.recommendations.length).toBeGreaterThan(0);
      const p0Cases = JSON.parse(await readFile(path.join(out, "run", "p0-cases.json"), "utf8"));
      const recommendations = JSON.parse(await readFile(path.join(out, "run", "recommendations.json"), "utf8"));
      expect(p0Cases).toEqual(suite.p0CaseRecords);
      expect(recommendations).toEqual(suite.recommendations);
      expect((await readFile(path.join(out, "run", "p0-cases.md"), "utf8")).trim().length).toBeGreaterThan(0);
      expect((await readFile(path.join(out, "run", "recommendations.md"), "utf8")).trim().length).toBeGreaterThan(0);
      const summary = JSON.parse(await readFile(path.join(out, "evaluation-summary.json"), "utf8"));
      expect(path.isAbsolute(summary.artifacts.report)).toBe(false);
      expect(path.isAbsolute(summary.artifacts.recommendations)).toBe(false);
      expect(path.isAbsolute(summary.harness.artifacts.harnessValidation)).toBe(false);
      await expect(stat(path.join(out, summary.artifacts.report))).resolves.toBeTruthy();
      await expect(stat(path.join(out, summary.artifacts.recommendations))).resolves.toBeTruthy();
      await expect(stat(path.join(out, summary.harness.artifacts.harnessValidation))).resolves.toBeTruthy();
    } finally {
      await rm(outsideCwd, { recursive: true, force: true });
      await rm(install.root, { recursive: true, force: true });
    }
  });

  test("plugin wrapper can run a copied CI regression core flow without source checkout discovery", async () => {
    const outsideCwd = await mkdtemp(path.join(tmpdir(), "awb-wrapper-ci-flow-cwd-"));
    const install = await copyPluginInstall();
    const awb = path.join(install.pluginPath, "bin", "awb");
    const env = { ...process.env, AWB_PROJECT_ROOT: "" };
    const doctorOut = path.join(outsideCwd, "doctor");
    const baselineOut = path.join(outsideCwd, "baseline");
    const candidateOut = path.join(outsideCwd, "candidate");
    const comparisonOut = path.join(outsideCwd, "comparison");
    const gateOut = path.join(outsideCwd, "gate");

    try {
      await execa(
        awb,
        ["doctor", "--target", "minimal-directory-agent", "--runner", "simulated", "--out", doctorOut],
        { cwd: outsideCwd, env }
      );
      await execa(
        awb,
        ["run", "--target", "minimal-directory-agent", "--runner", "simulated", "--execution", "simulated", "--out", baselineOut],
        { cwd: outsideCwd, env }
      );
      await execa(
        awb,
        ["run", "--target", "minimal-directory-agent", "--runner", "simulated", "--execution", "simulated", "--out", candidateOut],
        { cwd: outsideCwd, env }
      );
      await execa(
        awb,
        ["compare", "--baseline", baselineOut, "--candidate", candidateOut, "--out", comparisonOut],
        { cwd: outsideCwd, env }
      );
      const gate = await execa(awb, ["gate", "--comparison", path.join(comparisonOut, "comparison-result.json"), "--out", gateOut], {
        cwd: outsideCwd,
        env,
        reject: false
      });

      const doctor = JSON.parse(await readFile(path.join(doctorOut, "doctor-result.json"), "utf8"));
      await expectValidPluginRuntimeSchema(install.pluginPath, "schemas/doctor-result.schema.json", doctor);
      const comparison = JSON.parse(await readFile(path.join(comparisonOut, "comparison-result.json"), "utf8"));
      await expectValidPluginRuntimeSchema(install.pluginPath, "schemas/comparison-result.schema.json", comparison);
      const gateResult = JSON.parse(await readFile(path.join(gateOut, "gate-result.json"), "utf8"));
      await expectValidPluginRuntimeSchema(install.pluginPath, "schemas/gate-result.schema.json", gateResult);
      expect(gate.exitCode).toBe(2);
      expect(gateResult.decision).toBe("DIAGNOSTIC_ONLY");
    } finally {
      await rm(outsideCwd, { recursive: true, force: true });
      await rm(install.root, { recursive: true, force: true });
    }
  });

  test("ships a repo-local Codex marketplace entry", async () => {
    const marketplace = JSON.parse(await readFile(path.join(process.cwd(), ".agents", "plugins", "marketplace.json"), "utf8"));
    const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "agent-workflow-bench");

    expect(marketplace.name).toBe("agent-workflow-bench");
    expect(entry.source.path).toBe("./plugins/agent-workflow-bench");
    expect(entry.policy.installation).toBe("AVAILABLE");
    expect(entry.policy.authentication).toBe("ON_INSTALL");
  });

  test("ships a Claude Code marketplace entry for no-source installation", async () => {
    const marketplace = JSON.parse(await readFile(path.join(process.cwd(), ".claude-plugin", "marketplace.json"), "utf8"));
    const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "agent-workflow-bench");

    expect(marketplace.name).toBe("agent-workflow-bench");
    expect(entry.source).toBe("./plugins/agent-workflow-bench");
    expect(entry.version).toBe("0.1.0+codex.20260726094559");
    expect(entry.description).toContain("AI-generated cases");
  });
});
