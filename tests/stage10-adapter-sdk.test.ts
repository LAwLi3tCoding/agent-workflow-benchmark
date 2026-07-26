import { afterEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdapterError,
  loadAdapterContract,
  validateAdapterContract,
  type RunnerAdapter
} from "../src/adapters/sdk.js";
import {
  createOpenCodeRunnerAdapter
} from "../src/adapters/openCodeAdapter.js";
import {
  assertAdapterConformanceReportIntegrity,
  runAdapterDeclarationConformance,
  runRunnerAdapterConformance
} from "../src/adapters/conformance.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import type { CaseRun, RunnerCapability } from "../src/core/types.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { scoreCase } from "../src/scorer/score.js";
import { runnerCapabilityHash } from "../src/runner/runnerCapabilities.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("Stage 10 Adapter SDK and conformance", () => {
  test("validates canonical runner and Observer contracts with automation disabled", async () => {
    const opencode = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/opencode.json")
    );
    const observer = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/reference-observer.json")
    );

    expect(validateAdapterContract(opencode)).toBe(opencode);
    expect(validateAdapterContract(observer)).toBe(observer);
    expect(opencode.kind).toBe("runner");
    expect(observer.kind).toBe("observer");
    for (const contract of [opencode, observer]) {
      expect(contract.safety).toEqual({
        automaticTrustEnrollment: false,
        automaticWorkflowModification: false,
        automaticFixPullRequest: false,
        observerPrivateKeyAccessibleToRunner: false
      });
      expect(contract.evidenceLimits.maxEventsPerCase).toBeGreaterThan(0);
      expect(contract.compatibility.awb).toMatch(/^\^0\.1\.\d+$/u);
    }

    const declaration = runAdapterDeclarationConformance(observer, {
      generatedAt: "2026-07-25T00:00:00.000Z"
    });
    expect(declaration.decision).toBe("PASS");
    expect(declaration.releaseDisposition).toBe("DIAGNOSTIC_ONLY");
    expect(declaration.checks.every((check) => check.status === "PASS")).toBe(
      true
    );
    expect(() =>
      assertAdapterConformanceReportIntegrity(declaration)
    ).not.toThrow();
    const tampered = structuredClone(declaration);
    tampered.decision = "FAIL";
    expect(() =>
      assertAdapterConformanceReportIntegrity(tampered)
    ).toThrow(/integrity/u);
  });

  test("OpenCode emits canonical events, native tokens, and scores without scorer changes", async () => {
    const root = await temporaryRoot("awb-stage10-opencode-");
    const executable = path.join(root, "opencode");
    const argsFile = path.join(root, "args.json");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.AWB_FAKE_OPENCODE_ARGS, JSON.stringify(process.argv.slice(2)));",
        "console.log(JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'fixture', part: { text: JSON.stringify({ verdict: 'PASS', caveats: [], hardFailureCodes: [] }) } }));",
        "console.log(JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID: 'fixture', part: { id: 'step-1', type: 'step-finish', tokens: { input: 4, output: 3, reasoning: 1, cache: { read: 2, write: 0 }, total: 10 } } }));",
        "console.log(JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID: 'fixture', part: { id: 'step-2', type: 'step-finish', tokens: { input: 5, output: 2, reasoning: 2, cache: { read: 0, write: 1 }, total: 10 } } }));",
        "console.log(JSON.stringify({ type: 'message.updated', timestamp: 4, sessionID: 'fixture', info: { role: 'assistant', time: { created: 1, completed: 2 }, cost: 0.001, tokens: { input: 5, output: 2, reasoning: 2, cache: { read: 0, write: 1 }, total: 10 }, finish: 'stop' } }));"
      ].join("\n"),
      { mode: 0o755 }
    );

    const { contract, testCase } = await fixtureCase();
    const adapterContract = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/opencode.json")
    );
    const capability = opencodeCapability(executable);
    const adapter = createOpenCodeRunnerAdapter(adapterContract, {
      executable
    });
    const context = {
      testCase,
      contract,
      capability,
      sandboxRoot: root,
      transcriptPath: path.join(root, "transcript.jsonl"),
      lastMessagePath: path.join(root, "last-message.json"),
      timeoutMs: 10_000,
      model: "fixture/provider-model",
      env: { AWB_FAKE_OPENCODE_ARGS: argsFile }
    };
    const run = await adapter.run(context);
    const result = scoreCase(testCase, run);
    const report = await runRunnerAdapterConformance({
      adapter,
      context,
      generatedAt: "2026-07-25T00:00:00.000Z"
    });

    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(args[0]).toBe("run");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--dir");
    expect(args).toContain(root);
    expect(args).toContain("--model");
    expect(args).toContain("fixture/provider-model");
    expect(args).not.toContain("--auto");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(run.runner?.name).toBe("opencode");
    expect(run.tokens).toMatchObject({
      input: 12,
      output: 8,
      total: 20,
      costEstimateConfidence: "high"
    });
    expect(
      run.events.find((event) => event.type === "runner_result")?.payload
        .verdict
    ).toBe("PASS");
    expect(
      run.events.find((event) => event.type === "token_usage")?.payload.source
    ).toBe("native");
    expect(
      run.events.find((event) => event.type === "token_usage")?.payload
        .aggregation
    ).toBe("step_sum");
    expect(
      run.events.find((event) => event.type === "token_usage")?.payload.native
    ).toMatchObject({
      input: 9,
      output: 5,
      reasoning: 3,
      cacheRead: 2,
      cacheWrite: 1,
      reportedTotal: 20
    });
    expect(result.verdict).toBe("PASS");
    expect(report.decision).toBe("PASS");
    expect(report.checks.map((check) => check.id)).toContain(
      "scorer-compatibility"
    );
    expect(report.releaseDisposition).toBe("DIAGNOSTIC_ONLY");
  });

  test("rejects token mismatch and oversized evidence with stable failure codes", async () => {
    const root = await temporaryRoot("awb-stage10-adapter-bounds-");
    const { contract, testCase } = await fixtureCase();
    const adapterContract = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/opencode.json")
    );
    const baseRun = canonicalRun(testCase.id);
    const tokenMismatch: RunnerAdapter = {
      contract: adapterContract,
      async run() {
        return {
          ...baseRun,
          events: baseRun.events.map((event) =>
            event.type === "token_usage"
              ? {
                  ...event,
                  payload: {
                    input: 1,
                    output: 1,
                    total: 999,
                    wasted: 0,
                    source: "native"
                  }
                }
              : event
          )
        };
      }
    };
    const context = {
      testCase,
      contract,
      capability: opencodeCapability("/fixture/opencode"),
      sandboxRoot: path.join(root, "sandbox"),
      transcriptPath: path.join(root, "transcript.jsonl"),
      lastMessagePath: path.join(root, "last-message.json"),
      timeoutMs: 1000
    };
    await writeFile(context.transcriptPath, "{}\n");
    await writeFile(context.lastMessagePath, "{}\n");
    const mismatch = await runRunnerAdapterConformance({
      adapter: tokenMismatch,
      context,
      generatedAt: "2026-07-25T00:00:00.000Z"
    });
    expect(mismatch.decision).toBe("FAIL");
    expect(mismatch.reasonCodes).toContain(
      "ADAPTER_TOKEN_EVIDENCE_INVALID"
    );

    const oversized: RunnerAdapter = {
      contract: {
        ...adapterContract,
        evidenceLimits: {
          ...adapterContract.evidenceLimits,
          maxPayloadBytes: 16
        }
      },
      async run() {
        return baseRun;
      }
    };
    const overLimit = await runRunnerAdapterConformance({
      adapter: oversized,
      context,
      generatedAt: "2026-07-25T00:00:00.000Z"
    });
    expect(overLimit.decision).toBe("FAIL");
    expect(overLimit.reasonCodes).toContain(
      "ADAPTER_EVIDENCE_LIMIT_EXCEEDED"
    );

    await writeFile(context.transcriptPath, "x".repeat(32));
    const oversizedTranscript: RunnerAdapter = {
      contract: {
        ...adapterContract,
        evidenceLimits: {
          ...adapterContract.evidenceLimits,
          maxTranscriptBytes: 16
        }
      },
      async run() {
        return baseRun;
      }
    };
    const transcriptOverLimit = await runRunnerAdapterConformance({
      adapter: oversizedTranscript,
      context,
      generatedAt: "2026-07-25T00:00:00.000Z"
    });
    expect(transcriptOverLimit.reasonCodes).toContain(
      "ADAPTER_EVIDENCE_LIMIT_EXCEEDED"
    );
    await writeFile(context.transcriptPath, "{}\n");

    const failedExecution: RunnerAdapter = {
      contract: adapterContract,
      async run() {
        return {
          ...baseRun,
          events: baseRun.events.map((event) =>
            event.type === "runner_exit"
              ? {
                  ...event,
                  payload: { exitCode: 1, timedOut: false }
                }
              : event.type === "case_end"
                ? {
                    ...event,
                    payload: { status: "runner_failed" }
                  }
                : event
          )
        };
      }
    };
    const failed = await runRunnerAdapterConformance({
      adapter: failedExecution,
      context,
      generatedAt: "2026-07-25T00:00:00.000Z"
    });
    expect(failed.decision).toBe("FAIL");
    expect(failed.reasonCodes).toContain("ADAPTER_EXECUTION_FAILED");

    expect(
      () =>
        new AdapterError(
          "ADAPTER_OUTPUT_INVALID",
          "The adapter returned malformed JSONL."
        )
    ).not.toThrow();
  });

  test("uses stable timeout and Observer-key isolation errors", async () => {
    const root = await temporaryRoot("awb-stage10-opencode-errors-");
    const executable = path.join(root, "opencode");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {}, 10000);"
      ].join("\n"),
      { mode: 0o755 }
    );
    const { contract, testCase } = await fixtureCase();
    const adapterContract = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/opencode.json")
    );
    const adapter = createOpenCodeRunnerAdapter(adapterContract, {
      executable
    });
    const context = {
      testCase,
      contract,
      capability: opencodeCapability(executable),
      sandboxRoot: root,
      transcriptPath: path.join(root, "transcript.jsonl"),
      lastMessagePath: path.join(root, "last-message.json"),
      timeoutMs: 50
    };
    await expect(adapter.run(context)).rejects.toMatchObject({
      code: "ADAPTER_TIMEOUT"
    });
    await expect(
      adapter.run({
        ...context,
        env: {
          AWB_OBSERVER_PRIVATE_SIGNING_KEY: "forbidden"
        }
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_PRIVATE_DATA_REJECTED"
    });
    await expect(
      adapter.run({
        ...context,
        env: {
          OTHER_VALUE: [
            "-----BEGIN ",
            "PRIVATE",
            " KEY-----\nforbidden\n-----END ",
            "PRIVATE",
            " KEY-----"
          ].join("")
        }
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_PRIVATE_DATA_REJECTED"
    });
  });

  test("uses the final structured OpenCode result rather than an earlier update", async () => {
    const root = await temporaryRoot("awb-stage10-opencode-final-");
    const executable = path.join(root, "opencode");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'step_finish', timestamp: 1, sessionID: 'fixture', part: { id: 'step-1', type: 'step-finish', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 } } }));",
        "console.log(JSON.stringify({ type: 'message.updated', timestamp: 2, sessionID: 'fixture', info: { role: 'assistant', structured: { verdict: 'PASS', caveats: [], hardFailureCodes: [] } } }));",
        "console.log(JSON.stringify({ type: 'message.updated', timestamp: 3, sessionID: 'fixture', info: { role: 'assistant', structured: { verdict: 'FAIL', caveats: ['final'], hardFailureCodes: ['HF-FINAL'] } } }));"
      ].join("\n"),
      { mode: 0o755 }
    );
    const { contract, testCase } = await fixtureCase();
    const adapterContract = await loadAdapterContract(
      path.join(process.cwd(), "configs/adapters/opencode.json")
    );
    const run = await createOpenCodeRunnerAdapter(adapterContract, {
      executable
    }).run({
      testCase,
      contract,
      capability: opencodeCapability(executable),
      sandboxRoot: root,
      transcriptPath: path.join(root, "transcript.jsonl"),
      lastMessagePath: path.join(root, "last-message.json"),
      timeoutMs: 10_000
    });
    expect(
      run.events.find((event) => event.type === "runner_result")?.payload
    ).toMatchObject({
      verdict: "FAIL",
      caveats: ["final"],
      hardFailureCodes: ["HF-FINAL"]
    });
  });
});

async function fixtureCase() {
  const profile = await profileTarget(
    await loadTargetPack("minimal-directory-agent")
  );
  return {
    contract: profile.contract,
    testCase: materializeSmokeSuite(profile.contract).cases[0]!
  };
}

function opencodeCapability(executable: string): RunnerCapability {
  const capability = {
    schemaVersion: "0.1.0",
    name: "opencode",
    supported: true,
    executable,
    version: "fixture-opencode",
    adapterVersion: "1.0.0",
    executionMode: "live",
    supportsEntrypointKinds: ["file", "cli"],
    tokenSourceDetail: { source: "native", confidence: "high" },
    comparability: {
      workflowScore: "directional_only",
      efficiency: "comparable",
      tokenCost: "directional_only"
    }
  } satisfies Omit<RunnerCapability, "capabilitiesHash">;
  return { ...capability, capabilitiesHash: runnerCapabilityHash(capability) };
}

function canonicalRun(caseId: string): CaseRun {
  const timestamp = "2026-07-25T00:00:00.000Z";
  const event = (
    sequence: number,
    type: CaseRun["events"][number]["type"],
    payload: Record<string, unknown>
  ) => ({
    eventId: `event-${sequence}`,
    timestamp,
    type,
    actor: "fixture",
    payload
  });
  return {
    runId: `run-${caseId}`,
    caseId,
    runner: {
      name: "opencode",
      comparability: {
        workflowScore: "directional_only",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    },
    events: [
      event(1, "case_start", { caseId }),
      event(2, "runner_start", { runner: "opencode" }),
      event(3, "runner_transcript", { transcriptRef: "transcript.jsonl" }),
      event(4, "runner_result", {
        verdict: "PASS",
        caveats: [],
        hardFailureCodes: []
      }),
      event(5, "runner_exit", { exitCode: 0, timedOut: false }),
      event(6, "token_usage", {
        input: 10,
        output: 5,
        total: 15,
        wasted: 0,
        source: "native",
        aggregation: "step_sum"
      }),
      event(7, "case_end", { status: "completed" })
    ],
    wallClockSeconds: 1,
    tokens: {
      input: 10,
      output: 5,
      total: 15,
      wasted: 0,
      costEstimateConfidence: "high"
    },
    telemetryCompleteness: 0.9
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
