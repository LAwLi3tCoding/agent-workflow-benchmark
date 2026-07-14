import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

describe("target profiling", () => {
  test("loads target pack from registry and emits a contract hash", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);

    expect(profile.contract.targetId).toBe("minimal-directory-agent");
    expect(profile.contract.contractHash).toMatch(/^sha256:/);
    expect(profile.contract.roles.map((role) => role.id)).toContain("orchestrator-agent");
    expect(profile.evidence.missingFiles).toEqual([]);
  });

  test("profiles generic fixture workflow contracts", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);

    expect(profile.contract.roles.map((role) => role.id)).toEqual(expect.arrayContaining(["orchestrator-agent", "worker-agent"]));
    expect(profile.evidence.missingFiles).toEqual([]);
    expect(profile.contract.joins.map((join) => join.id)).toEqual(expect.arrayContaining(["code-testdesign", "review-summary-return"]));
    expect(profile.contract.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining(["implementation-plan", "worker-summary"]));
    expect(profile.contract.states.map((state) => state.id)).toContain("blocked");
  });
});
