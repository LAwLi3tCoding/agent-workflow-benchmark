import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { runLiveClaudeCase, runLiveCodexCase } from "../src/runner/liveCodexRunner.js";
import type { RunnerCapability } from "../src/core/types.js";

const cwd = process.cwd();

describe("live Codex runner", () => {
  test("captures JSONL transcript and uses read-only sandbox args", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-live-runner-"));
    try {
      const fakeCodex = path.join(root, "codex");
      const argsFile = path.join(root, "args.json");
      const fakeSecret = ["sk", "-proj-", "private-live-secret"].join("");
      const fakeBearer = ["Bearer", " private-live-token"].join("");
      const fakePath = ["/", "opt", "/", "private-workflow", "/", "secret.txt"].join("");
      const fakeResult = JSON.stringify({
        verdict: "PASS",
        summary: fakeSecret,
        caveats: [`inspect ${fakePath}`],
        hardFailureCodes: []
      });
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "fs.writeFileSync(process.env.AWB_FAKE_CODEX_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
          "const outIndex = process.argv.indexOf('-o');",
          `if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], ${JSON.stringify(fakeResult)});`,
          "console.log(JSON.stringify({ type: 'session.created', session_id: 'fake-session' }));",
          `console.log(JSON.stringify({ type: 'message', role: 'assistant', content: ${JSON.stringify(fakeBearer)} }));`,
          "console.error('workspace ' + process.env.AWB_FAKE_PRIVATE_PATH);"
        ].join("\n"),
        { mode: 0o755 }
      );

      const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
      const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
      const capability: RunnerCapability = {
        schemaVersion: "0.1.0",
        name: "codex",
        supported: true,
        executable: fakeCodex,
        version: "fake-codex",
        adapterVersion: "0.1.0",
        executionMode: "live",
        supportsEntrypointKinds: ["file", "cli"],
        tokenSourceDetail: { source: "estimated", confidence: "low" },
        comparability: {
          workflowScore: "directional_only",
          efficiency: "directional_only",
          tokenCost: "directional_only"
        },
        capabilitiesHash: "sha256:fake"
      };

      const run = await runLiveCodexCase(testCase, profile.contract, capability, {
        sandboxRoot: root,
        transcriptPath: path.join(root, "transcript.jsonl"),
        lastMessagePath: path.join(root, "last-message.json"),
        timeoutMs: 10000,
        model: "gpt-5.3-codex-spark",
        env: { AWB_FAKE_CODEX_ARGS_FILE: argsFile, AWB_FAKE_PRIVATE_PATH: root }
      });

      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args).toContain("exec");
      expect(args).toContain("-m");
      expect(args).toContain("gpt-5.3-codex-spark");
      expect(args).toContain("--json");
      expect(args).toContain("--sandbox");
      expect(args).toContain("read-only");
      expect(args).toContain("-c");
      expect(args).toContain('approval_policy="never"');
      expect(args).toContain("--skip-git-repo-check");
      expect(args).toContain("--ephemeral");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("-C");
      const prompt = args.at(-1) ?? "";
      expect(prompt).toContain("ContractModel excerpt");
      expect(prompt).toContain("Oracle expectations");
      expect(prompt).toContain("Required evidence");
      expect(prompt).toContain("roles");
      expect(prompt).toContain("artifacts");
      expect(prompt).toContain("Verdict rules");
      expect(prompt).toContain("hardFailureCodes");
      expect(prompt).toContain("caseContractHash");
      expect(prompt).toContain("caseHash is a case identity hash");
      expect(prompt).not.toContain("caseHash must equal");
      expect(prompt).toContain("expectedHardFailures names the failure type this case is designed to detect");
      expect(prompt).toContain("never copy codes from expectedHardFailures just because they are declared");
      expect(prompt).not.toContain("no expected hard failure is present");
      const persistedArtifacts = [
        await readFile(path.join(root, "transcript.jsonl"), "utf8"),
        await readFile(path.join(root, "transcript.stderr.log"), "utf8"),
        await readFile(path.join(root, "last-message.json"), "utf8")
      ].join("\n");
      expect(persistedArtifacts).toContain("session.created");
      expect(persistedArtifacts).not.toContain(fakeBearer.replace("Bearer ", ""));
      expect(persistedArtifacts).not.toContain(fakeSecret);
      expect(persistedArtifacts).not.toContain(root);
      expect(run.events.map((event) => event.type)).toContain("runner_transcript");
      expect(run.events.map((event) => event.type)).toContain("runner_exit");
      expect(run.events.find((event) => event.type === "runner_result")?.payload.verdict).toBe("PASS");
      expect(JSON.stringify(run.events)).not.toContain(root);
      expect(JSON.stringify(run.events)).not.toContain(fakePath);
      expect(run.telemetryCompleteness).toBeGreaterThan(0.7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps live hardFailureCodes into hard_failure events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-live-hard-failure-"));
    try {
      const fakeCodex = path.join(root, "codex");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const outIndex = process.argv.indexOf('-o');",
          "if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], JSON.stringify({ verdict: 'FAIL', hardFailureCodes: ['TARGET_ROUTE_FORBIDDEN'], caveats: [] }));",
          "console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'FAIL' }));"
        ].join("\n"),
        { mode: 0o755 }
      );
      const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
      const testCase = materializeSmokeSuite(profile.contract).cases.find((item) => item.templateId === "forbidden-route")!;
      const capability: RunnerCapability = {
        schemaVersion: "0.1.0",
        name: "codex",
        supported: true,
        executable: fakeCodex,
        version: "fake-codex",
        adapterVersion: "0.1.0",
        executionMode: "live",
        supportsEntrypointKinds: ["file", "cli"],
        tokenSourceDetail: { source: "estimated", confidence: "low" },
        comparability: {
          workflowScore: "directional_only",
          efficiency: "directional_only",
          tokenCost: "directional_only"
        },
        capabilitiesHash: "sha256:fake"
      };

      const run = await runLiveCodexCase(testCase, profile.contract, capability, {
        sandboxRoot: root,
        transcriptPath: path.join(root, "transcript.jsonl"),
        lastMessagePath: path.join(root, "last-message.json"),
        timeoutMs: 10000
      });

      expect(run.events.find((event) => event.type === "runner_result")?.payload.hardFailureCodes).toEqual(["TARGET_ROUTE_FORBIDDEN"]);
      expect(run.events.find((event) => event.type === "hard_failure")?.payload.code).toBe("TARGET_ROUTE_FORBIDDEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI live execution writes transcript artifacts using executable override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-live-cli-"));
    try {
      const fakeCodex = path.join(root, "codex");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const outIndex = process.argv.indexOf('-o');",
          "if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], '{\"verdict\":\"PASS\",\"summary\":\"fake live cli\",\"caveats\":[\"inspect /opt/private-live/workflow.txt\"],\"hardFailureCodes\":[]}');",
          "console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'PASS' }));"
        ].join("\n"),
        { mode: 0o755 }
      );
      const casesOut = path.join(root, "cases");
      const runOut = path.join(root, "run");
      await execa("npm", ["run", "benchmark", "--", "materialize", "--target", "minimal-directory-agent", "--suite", "smoke", "--out", casesOut], {
        cwd
      });
      const execution = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "run",
          "--case",
          path.join(casesOut, "minimal-directory-agent-smoke-001-static-contract.yaml"),
          "--runner",
          "codex",
          "--execution",
          "live",
          "--live-model",
          "gpt-5.3-codex-spark",
          "--timeout-ms",
          "10000",
          "--mode",
          "gate",
          "--out",
          runOut
        ],
        {
          cwd,
          env: { AWB_CODEX_EXECUTABLE: fakeCodex },
          reject: false
        }
      );

      const runtime = JSON.parse(await readFile(path.join(runOut, "runtime-manifest.json"), "utf8"));
      const provenance = JSON.parse(await readFile(path.join(runOut, "provenance.json"), "utf8"));
      const suite = JSON.parse(await readFile(path.join(runOut, "suite-result.json"), "utf8"));
      const events = JSON.parse(
        await readFile(path.join(runOut, "events", "minimal-directory-agent-smoke-001-static-contract.json"), "utf8")
      );
      const caseResult = JSON.parse(
        await readFile(path.join(runOut, "case-results", "minimal-directory-agent-smoke-001-static-contract.json"), "utf8")
      );
      await execa("npm", ["run", "benchmark", "--", "report", "--run", runOut, "--format", "md,json"], { cwd });
      const report = await readFile(path.join(runOut, "report.md"), "utf8");
      expect(execution.exitCode).not.toBe(0);
      expect(`${execution.stdout}\n${execution.stderr}`).toContain("Gate mode blocked run");
      expect(suite).toMatchObject({
        releaseDecision: "DIAGNOSTIC_ONLY",
        releaseRuleId: "REL-EVIDENCE-CONTRACT-SUMMARY"
      });
      expect(runtime.runner.executionMode).toBe("live");
      expect(runtime.liveTranscriptCount).toBe(1);
      expect(provenance.conditions.evidenceKind).toBe("live");
      expect(provenance.conditions.observationLevel).toBe("contract_summary");
      expect(provenance.conditions.isolation).toBe("read_only_sandbox");
      expect(provenance.conditions.permissionMode).toBe("read_only_no_approval");
      expect(JSON.stringify({ runtime, provenance, events, caseResult })).not.toContain(root);
      expect(JSON.stringify({ events, caseResult })).not.toContain("/opt/private-live/workflow.txt");
      expect(report).not.toContain("/opt/private-live/workflow.txt");
      expect(await readFile(path.join(runOut, "transcripts", "minimal-directory-agent-smoke-001-static-contract.jsonl"), "utf8")).toContain("assistant");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures Claude live output through the Claude runner adapter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-live-claude-"));
    try {
      const fakeClaude = path.join(root, "claude");
      const argsFile = path.join(root, "claude-args.json");
      await writeFile(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "fs.writeFileSync(process.env.AWB_FAKE_CLAUDE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
          "console.log(JSON.stringify({ verdict: 'PASS', evidence: { source: 'fake-claude' }, caveats: [], hardFailureCodes: [] }));"
        ].join("\n"),
        { mode: 0o755 }
      );

      const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
      const testCase = materializeSmokeSuite(profile.contract).cases[0]!;
      const capability: RunnerCapability = {
        schemaVersion: "0.1.0",
        name: "claude",
        supported: true,
        executable: fakeClaude,
        version: "fake-claude",
        adapterVersion: "0.1.0",
        executionMode: "live",
        supportsEntrypointKinds: ["file", "cli"],
        tokenSourceDetail: { source: "estimated", confidence: "low" },
        comparability: {
          workflowScore: "directional_only",
          efficiency: "directional_only",
          tokenCost: "directional_only"
        },
        capabilitiesHash: "sha256:fake"
      };

      const run = await runLiveClaudeCase(testCase, profile.contract, capability, {
        sandboxRoot: root,
        transcriptPath: path.join(root, "claude-transcript.jsonl"),
        lastMessagePath: path.join(root, "claude-last-message.json"),
        timeoutMs: 10000,
        model: "claude-fixture",
        env: { AWB_FAKE_CLAUDE_ARGS_FILE: argsFile }
      });

      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("json");
      expect(args).toContain("--model");
      expect(args).toContain("claude-fixture");
      expect(run.events.find((event) => event.type === "runner_result")?.payload.verdict).toBe("PASS");
      expect(await readFile(path.join(root, "claude-last-message.json"), "utf8")).toContain("fake-claude");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
