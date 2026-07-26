import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  compareGatePolicyBindings,
  fitGatePolicy,
  gatePolicyBinding,
  reviseGatePolicy
} from "../src/calibration/gatePolicy.js";
import type { BenchmarkCase, ContractModel } from "../src/core/types.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { DEFAULT_GOLD_CORPUS_PATH } from "../src/evaluation/goldCorpus.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

describe("Stage 6 gate policy versioning", () => {
  test("canonical policy version is bumped when safety blocking rules change", async () => {
    const policy = JSON.parse(
      await readFile(path.join(process.cwd(), "configs/evaluation/gate-policy.json"), "utf8")
    );

    expect(policy.policyVersion).toBe("1.1.0");
    expect(policy.rules.telemetry.blockingFailureCodes).toEqual(
      expect.arrayContaining([
        "PROMPT_INJECTION",
        "OBJECTIVE_HIJACK",
        "TOOL_CHAIN_ESCALATION",
        "HANDOFF_DELAY_TRIGGER",
        "MEMORY_POISON",
        "UNSAFE_RECOVERY"
      ])
    );
    expect(policy.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(policy.rulesHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("rejects a rule change that keeps the same semantic policy version", async () => {
    const { policy } = await fitGatePolicy({
      ...(await targetInputs()),
      policyVersion: "1.0.0"
    });

    expect(() =>
      reviseGatePolicy(policy, {
        policyVersion: policy.policyVersion,
        rules: {
          ...policy.rules,
          telemetry: {
            ...policy.rules.telemetry,
            minimumCompleteness: 0.8
          }
        }
      })
    ).toThrow(/cannot change rules without a policyVersion bump/i);
  });

  test("changes the policy fingerprint when a rule change bumps the semantic version", async () => {
    const { policy } = await fitGatePolicy({
      ...(await targetInputs()),
      policyVersion: "1.0.0"
    });

    const revised = reviseGatePolicy(policy, {
      policyVersion: "1.1.0",
      rules: {
        ...policy.rules,
        telemetry: {
          ...policy.rules.telemetry,
          minimumCompleteness: 0.8
        }
      }
    });

    expect(revised.policyVersion).toBe("1.1.0");
    expect(revised.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(revised.policyHash).not.toBe(policy.policyHash);
    expect(revised.derivedFrom).toEqual(policy.derivedFrom);
  });

  test("marks a missing old policy binding explicitly incomparable", async () => {
    const { policy } = await fitGatePolicy({
      ...(await targetInputs()),
      policyVersion: "1.0.0"
    });

    expect(compareGatePolicyBindings(undefined, gatePolicyBinding(policy))).toEqual({
      status: "INCOMPARABLE",
      reasonCode: "GATE_POLICY_MISSING"
    });
  });

  test("marks mismatched policy fingerprints incomparable instead of silently recomputable", async () => {
    const { policy } = await fitGatePolicy({
      ...(await targetInputs()),
      policyVersion: "1.0.0"
    });
    const revised = reviseGatePolicy(policy, {
      policyVersion: "1.1.0",
      rules: {
        ...policy.rules,
        telemetry: {
          ...policy.rules.telemetry,
          minimumCompleteness: 0.8
        }
      }
    });

    expect(
      compareGatePolicyBindings(
        gatePolicyBinding(policy),
        gatePolicyBinding(revised)
      )
    ).toEqual({
      status: "INCOMPARABLE",
      reasonCode: "GATE_POLICY_VERSION_MISMATCH"
    });
  });

  test("allows recomputation only when policy version, fingerprint, and bindings match", async () => {
    const { policy } = await fitGatePolicy({
      ...(await targetInputs()),
      policyVersion: "1.0.0"
    });

    expect(
      compareGatePolicyBindings(
        gatePolicyBinding(policy),
        gatePolicyBinding(structuredClone(policy))
      )
    ).toEqual({ status: "RECOMPUTABLE" });
  });
});

async function targetInputs(): Promise<{
  corpusPath: string;
  contract: ContractModel;
  cases: BenchmarkCase[];
}> {
  const target = await loadTargetPack("minimal-directory-agent");
  const profile = await profileTarget(target);
  return {
    corpusPath: DEFAULT_GOLD_CORPUS_PATH,
    contract: profile.contract,
    cases: materializeSmokeSuite(profile.contract).cases
  };
}
