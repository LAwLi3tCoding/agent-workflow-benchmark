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

  test("every substantive contract surface changes contractHash while checkout root does not", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const baseline = await profileTarget(target);
    const rootOnly = structuredClone(target);
    rootOnly.root = `${target.root}-isolated-copy`;
    expect((await profileTarget(rootOnly)).contract.contractHash).toBe(
      baseline.contract.contractHash
    );

    const mutations: Array<[string, (copy: typeof target) => void]> = [
      ["entrypoint", (copy) => { copy.entrypoints[0]!.id = "changed-entrypoint"; }],
      ["role", (copy) => { copy.roles[0]!.ownerScopes = [...copy.roles[0]!.ownerScopes, "changed-scope"]; }],
      ["owner", (copy) => { copy.contracts.requiredOwners.design = "worker-agent"; }],
      ["join", (copy) => { copy.contracts.joins[0]!.artifact = "deliverables/changed.md"; }],
      ["artifact", (copy) => { copy.contracts.artifacts[0]!.path = "deliverables/changed.md"; }],
      ["state", (copy) => { copy.contracts.states[0]!.path = "process/changed.json"; }],
      ["status", (copy) => { copy.contracts.statuses = [...copy.contracts.statuses, "CHANGED"]; }],
      ["budget", (copy) => { copy.contracts.budgets.tokenTotal += 1; }],
      ["command policy", (copy) => { copy.commandPolicy.forbiddenArgs = [...copy.commandPolicy.forbiddenArgs, "--changed"]; }]
    ];

    for (const [label, mutate] of mutations) {
      const copy = structuredClone(target);
      mutate(copy);
      expect(
        (await profileTarget(copy)).contract.contractHash,
        `${label} must affect contractHash`
      ).not.toBe(baseline.contract.contractHash);
    }
  });
});
