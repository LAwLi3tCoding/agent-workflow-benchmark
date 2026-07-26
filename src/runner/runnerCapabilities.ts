import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execa } from "execa";
import type { RunnerCapability } from "../core/types.js";
import { sha256Text, stableJson } from "../utils/hash.js";

type RunnerName = RunnerCapability["name"];

const commandByRunner: Record<Exclude<RunnerName, "simulated">, string> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode"
};

export async function detectRunnerCapability(name: RunnerName): Promise<RunnerCapability> {
  if (name === "simulated") {
    return withHash({
      schemaVersion: "0.1.0",
      name,
      supported: true,
      adapterVersion: "0.1.0",
      executionMode: "simulated",
      supportsEntrypointKinds: ["file", "cli"],
      tokenSourceDetail: { source: "estimated", confidence: "medium" },
      comparability: {
        workflowScore: "comparable",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    });
  }

  const override = overrideExecutable(name);
  const executable = override ?? commandByRunner[name];
  const which = override ? await checkExecutableOverride(override) : await tryCommand("which", [executable]);
  if (!which.ok) {
    return withHash({
      schemaVersion: "0.1.0",
      name,
      supported: false,
      disabledReason: override ? `${override} executable not found or not executable` : `${executable} executable not found in PATH`,
      adapterVersion: name === "opencode" ? "1.0.0" : "0.1.0",
      executionMode: "disabled",
      supportsEntrypointKinds: [],
      tokenSourceDetail: { source: "unavailable", confidence: "unavailable" },
      comparability: {
        workflowScore: "not_comparable",
        efficiency: "not_comparable",
        tokenCost: "not_comparable"
      }
    });
  }

  const version = await detectVersion(executable);
  const tokenSourceDetail =
    name === "opencode"
      ? ({ source: "native", confidence: "high" } as const)
      : ({ source: "estimated", confidence: "medium" } as const);
  const comparability =
    name === "opencode"
      ? ({
          workflowScore: "directional_only",
          efficiency: "comparable",
          tokenCost: "directional_only"
        } as const)
      : ({
          workflowScore: "directional_only",
          efficiency: "directional_only",
          tokenCost: "directional_only"
        } as const);
  return withHash({
    schemaVersion: "0.1.0",
    name,
    supported: true,
    executable: which.stdout.trim(),
    version,
    adapterVersion: name === "opencode" ? "1.0.0" : "0.1.0",
    executionMode: "live",
    supportsEntrypointKinds: ["file", "cli"],
    tokenSourceDetail,
    comparability
  });
}

async function checkExecutableOverride(executable: string): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string }> {
  try {
    await access(executable, constants.X_OK);
    return { ok: true, stdout: executable };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function overrideExecutable(name: RunnerName): string | undefined {
  if (name === "codex") {
    return process.env.AWB_CODEX_EXECUTABLE;
  }
  if (name === "claude") {
    return process.env.AWB_CLAUDE_EXECUTABLE;
  }
  if (name === "opencode") {
    return process.env.AWB_OPENCODE_EXECUTABLE;
  }
  return undefined;
}

export function runnerCapabilityHash(capability: Omit<RunnerCapability, "capabilitiesHash"> | RunnerCapability): string {
  const { capabilitiesHash: _ignored, ...hashable } = capability as RunnerCapability;
  return sha256Text(stableJson(hashable));
}

function withHash(capability: Omit<RunnerCapability, "capabilitiesHash">): RunnerCapability {
  return {
    ...capability,
    capabilitiesHash: runnerCapabilityHash(capability)
  };
}

async function detectVersion(executable: string): Promise<string | undefined> {
  for (const args of [["--version"], ["-v"]]) {
    const result = await tryCommand(executable, args);
    if (result.ok && result.stdout.trim()) {
      return firstLine(result.stdout.trim());
    }
  }
  return undefined;
}

async function tryCommand(command: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string }> {
  try {
    const result = await execa(command, args, { timeout: 3000, reject: false });
    if (result.exitCode === 0) {
      return { ok: true, stdout: result.stdout };
    }
    return { ok: false, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0] ?? value;
}
