import { describe, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPath } from "../src/utils/hash.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { prepareDebugEnvironment, reverseValidate } from "../src/debug/debugWorkflow.js";

describe("self-debug workflow", () => {
  test("prepare-env creates isolated reproducible environment", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-debug-"));
    try {
      const target = await loadTargetPack("minimal-directory-agent");
      const profile = await profileTarget(target);
      const suite = materializeSmokeSuite(profile.contract);
      const env = await prepareDebugEnvironment(target, profile.contract, suite.cases[0], {
        runner: "codex",
        mockProfile: "strict",
        outDir: out
      });

      await expect(stat(env.sandboxRoot)).resolves.toBeTruthy();
      expect(env.contractHash).toBe(profile.contract.contractHash);
      expect(env.fakeTools.map((tool) => tool.name)).toContain("gh");
      expect(env.reproduceCommands[0]).toContain("debug prepare-env");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("reverse validation kills a join-callback mutation without modifying target source", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-reverse-"));
    try {
      const target = await loadTargetPack("minimal-directory-agent");
      const beforeHash = await hashPath(target.root);
      const profile = await profileTarget(target);
      const suite = materializeSmokeSuite(profile.contract);
      const requiredJoinCase = suite.cases.find((item) => item.templateId === "required-join");
      expect(requiredJoinCase).toBeDefined();

      const result = await reverseValidate(target, profile.contract, requiredJoinCase!, {
        mutation: { id: "join-callback-drop", type: "join-callback-drop", expectedHardFailureCode: "TARGET_JOIN_MISSING" },
        runner: "simulated",
        outDir: out
      });
      const afterHash = await hashPath(target.root);

      expect(result.status).toBe("PASS");
      expect(result.runner).toBe("simulated");
      expect(result.mutationScope).toBe("overlay-only");
      expect(result.expectationMatched).toBe(true);
      expect(result.baseline.verdict).toBe("PASS");
      expect(result.mutant.verdict).toBe("FAIL");
      expect(result.restore.verdict).toBe("PASS");
      expect(result.expectedHardFailureMatched).toBe(true);
      expect(afterHash).toBe(beforeHash);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("reverse validation kills telemetry and token degradation mutations", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-reverse-degrade-"));
    try {
      const target = await loadTargetPack("minimal-directory-agent");
      const profile = await profileTarget(target);
      const suite = materializeSmokeSuite(profile.contract);
      const tokenCase = suite.cases.find((item) => item.templateId === "efficiency-token");
      expect(tokenCase).toBeDefined();

      const telemetry = await reverseValidate(target, profile.contract, tokenCase!, {
        mutation: { id: "telemetry-drop", type: "telemetry-drop" },
        runner: "simulated",
        outDir: path.join(out, "telemetry")
      });
      const token = await reverseValidate(target, profile.contract, tokenCase!, {
        mutation: { id: "token-ledger-drop", type: "token-ledger-drop" },
        runner: "simulated",
        outDir: path.join(out, "token")
      });

      expect(telemetry.status).toBe("PASS");
      expect(telemetry.mutationKilled).toBe(true);
      expect(telemetry.mutant.telemetryCompleteness).toBeLessThan(telemetry.baseline.telemetryCompleteness);
      expect(token.status).toBe("PASS");
      expect(token.mutationKilled).toBe(true);
      expect(token.mutant.cappedScore).toBeLessThan(token.baseline.cappedScore);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
