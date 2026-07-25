import { describe, expect, test } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { detectRunnerCapability, runnerCapabilityHash } from "../src/runner/runnerCapabilities.js";

const cwd = process.cwd();

describe("runner capabilities", () => {
  test("detects codex capability and unavailable runner reasons", async () => {
    const codex = await detectRunnerCapability("codex");
    const claude = await detectRunnerCapability("claude");
    const opencode = await detectRunnerCapability("opencode");

    expect(codex.name).toBe("codex");
    expect(codex.capabilitiesHash).toMatch(/^sha256:/);
    expect(codex.supportsEntrypointKinds).toContain("file");
    expect(claude.supported || claude.disabledReason).toBeTruthy();
    expect(opencode.supported || opencode.disabledReason).toBeTruthy();
    expect(runnerCapabilityHash(codex)).toBe(codex.capabilitiesHash);
  });

  test("run writes runtime manifest with runner capability detail", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-runner-cap-"));
    try {
      await execa(
        "npm",
        ["run", "benchmark", "--", "run", "--target", "minimal-directory-agent", "--suite", "smoke", "--runner", "codex", "--out", out],
        { cwd }
      );

      const runtime = JSON.parse(await readFile(path.join(out, "runtime-manifest.json"), "utf8"));
      expect(runtime.runner.name).toBe("codex");
      expect(runtime.runner.capabilitiesHash).toMatch(/^sha256:/);
      expect(runtime.runner.supportsEntrypointKinds).toContain("file");
      expect(runtime.runner.executionMode).toMatch(/simulated|live/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("unavailable runner dry-run records disabled capability without scoring target as pass", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-runner-disabled-"));
    const missingClaude = path.join(out, "missing-claude");
    try {
      await execa(
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
          "claude",
          "--dry-run",
          "--out",
          out
        ],
        {
          cwd,
          env: { AWB_CLAUDE_EXECUTABLE: missingClaude }
        }
      );

      const runtime = JSON.parse(await readFile(path.join(out, "runtime-manifest.json"), "utf8"));
      const suite = JSON.parse(await readFile(path.join(out, "suite-result.json"), "utf8"));
      const provenance = JSON.parse(await readFile(path.join(out, "provenance.json"), "utf8"));
      expect(runtime.runner.name).toBe("claude");
      expect(runtime.runner.supported).toBe(false);
      expect(runtime.runner.disabledReason).toContain("not found");
      expect(suite.releaseDecision).toBe("DIAGNOSTIC_ONLY");
      expect(suite.caseResults).toHaveLength(0);
      expect(provenance.conditions).toMatchObject({
        evidenceKind: "unknown",
        observationLevel: "capability_only",
        isolation: "unknown",
        permissionMode: "unknown"
      });
      expect(JSON.stringify({ runtime, suite, provenance })).not.toContain(out);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("missing executable override is reported as disabled", async () => {
    const missingExecutable = path.join(tmpdir(), "awb-missing-opencode");
    const previous = process.env.AWB_OPENCODE_EXECUTABLE;
    process.env.AWB_OPENCODE_EXECUTABLE = missingExecutable;
    try {
      const result = await detectRunnerCapability("opencode");

      expect(result.supported).toBe(false);
      expect(result.disabledReason).toContain("not found");
    } finally {
      if (previous === undefined) {
        delete process.env.AWB_OPENCODE_EXECUTABLE;
      } else {
        process.env.AWB_OPENCODE_EXECUTABLE = previous;
      }
    }
  });

  test("dry-run never invokes an available external runner", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-runner-dry-"));
    const fakeCodex = path.join(out, "codex");
    const invoked = path.join(out, "invoked");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo 'fake-codex 1.0'; exit 0; fi\ntouch \"$AWB_FAKE_RUNNER_INVOKED\"\nexit 99\n",
        { mode: 0o755 }
      );

      await execa(
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
          "codex",
          "--execution",
          "live",
          "--dry-run",
          "--out",
          out
        ],
        {
          cwd,
          env: {
            AWB_CODEX_EXECUTABLE: fakeCodex,
            AWB_FAKE_RUNNER_INVOKED: invoked
          }
        }
      );

      await expect(access(invoked)).rejects.toMatchObject({ code: "ENOENT" });
      const provenance = JSON.parse(await readFile(path.join(out, "provenance.json"), "utf8"));
      expect(provenance.conditions).toMatchObject({
        evidenceKind: "unknown",
        observationLevel: "capability_only"
      });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
