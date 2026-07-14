import { describe, expect, test } from "vitest";
import { access, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";

const pluginRoot = path.join(process.cwd(), "plugins", "agent-workflow-benchmark");

async function expectValidPluginRuntimeSchema(pluginPath: string, schemaPath: string, value: unknown): Promise<void> {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(await readFile(path.join(pluginPath, "runtime", schemaPath), "utf8"));
  const validate = ajv.compile(schema);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

async function copyPluginInstall(): Promise<{ root: string; pluginPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "awb-plugin-install-"));
  const pluginPath = path.join(root, "agent-workflow-benchmark");
  await cp(pluginRoot, pluginPath, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}runtime${path.sep}node_modules`)
  });
  await rm(path.join(pluginPath, "runtime", "node_modules"), { recursive: true, force: true });
  return { root, pluginPath };
}

describe("agent workflow benchmark plugin package", () => {
  test("ships a Codex plugin manifest and shared skill", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));

    expect(manifest.name).toBe("agent-workflow-benchmark");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.interface.displayName).toBe("Agent Workflow Benchmark");
    await expect(stat(path.join(pluginRoot, "skills", "agent-workflow-benchmark", "SKILL.md"))).resolves.toBeTruthy();
  });

  test("ships a Claude Code plugin manifest, slash command, and executable wrapper", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));

    expect(manifest.name).toBe("agent-workflow-benchmark");
    expect(manifest.version).toMatch(/^0\.1\.0/);
    await expect(stat(path.join(pluginRoot, "commands", "agent-workflow-benchmark.md"))).resolves.toBeTruthy();
    await access(path.join(pluginRoot, "bin", "awb"));
    const command = await readFile(path.join(pluginRoot, "commands", "agent-workflow-benchmark.md"), "utf8");
    expect(command).toContain("plan-cases");
    expect(command).toContain("materialize --strategy ai");
    expect(command).toContain("run --execution live");
  });

  test("ships a self-contained plugin runtime for installs without a source checkout", async () => {
    const runtimeRoot = path.join(pluginRoot, "runtime");

    await expect(stat(path.join(runtimeRoot, "package.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "package-lock.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "dist", "src", "cli", "index.js"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "configs", "targets", "registry.yaml"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "schemas", "case.schema.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(runtimeRoot, "fixtures", "mutations", "core.yaml"))).resolves.toBeTruthy();

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
      await expect(stat(summary.artifacts.report)).resolves.toBeTruthy();
      await expect(stat(summary.artifacts.recommendations)).resolves.toBeTruthy();
      await expect(stat(summary.harness.artifacts.harnessValidation)).resolves.toBeTruthy();
    } finally {
      await rm(outsideCwd, { recursive: true, force: true });
      await rm(install.root, { recursive: true, force: true });
    }
  });

  test("ships a repo-local Codex marketplace entry", async () => {
    const marketplace = JSON.parse(await readFile(path.join(process.cwd(), ".agents", "plugins", "marketplace.json"), "utf8"));
    const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "agent-workflow-benchmark");

    expect(marketplace.name).toBe("agent-workflow-benchmark");
    expect(entry.source.path).toBe("./plugins/agent-workflow-benchmark");
    expect(entry.policy.installation).toBe("AVAILABLE");
    expect(entry.policy.authentication).toBe("ON_INSTALL");
  });

  test("ships a Claude Code marketplace entry for no-source installation", async () => {
    const marketplace = JSON.parse(await readFile(path.join(process.cwd(), ".claude-plugin", "marketplace.json"), "utf8"));
    const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "agent-workflow-benchmark");

    expect(marketplace.name).toBe("agent-workflow-benchmark");
    expect(entry.source).toBe("./plugins/agent-workflow-benchmark");
    expect(entry.version).toBe("0.1.0+codex.20260706202456");
    expect(entry.description).toContain("AI-generated cases");
  });
});
