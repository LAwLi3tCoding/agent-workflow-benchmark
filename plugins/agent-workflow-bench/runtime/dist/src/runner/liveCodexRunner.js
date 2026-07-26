import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { redactSensitiveText } from "../utils/redaction.js";
import { PRODUCT_NAME } from "../core/product.js";
export async function runLiveCodexCase(testCase, contract, capability, options) {
    if (!capability.executable) {
        throw new Error("Codex live runner requires an executable path");
    }
    await mkdir(options.sandboxRoot, { recursive: true });
    await mkdir(path.dirname(options.transcriptPath), { recursive: true });
    await mkdir(path.dirname(options.lastMessagePath), { recursive: true });
    const prompt = buildPrompt(testCase, contract);
    const args = [
        "exec",
        "-m",
        options.model ?? process.env.AWB_CODEX_MODEL ?? "gpt-5.3-codex-spark",
        "--json",
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--ignore-user-config",
        "-C",
        options.sandboxRoot,
        "-o",
        options.lastMessagePath,
        prompt
    ];
    const startedAt = Date.now();
    const events = [];
    let seq = 0;
    const push = (type, actor, payload) => {
        seq += 1;
        events.push({
            eventId: `event-${String(seq).padStart(3, "0")}`,
            timestamp: new Date(startedAt + seq * 1000).toISOString(),
            type,
            actor,
            payload
        });
    };
    push("case_start", "benchmark", { caseId: testCase.id, templateId: testCase.templateId });
    push("runner_start", "benchmark", {
        runner: "codex",
        executionMode: "live",
        sandbox: "read-only",
        approval: "never"
    });
    const result = await execa(capability.executable, args, {
        timeout: options.timeoutMs,
        reject: false,
        input: "",
        env: {
            ...process.env,
            ...options.env
        }
    });
    const redactionPaths = [options.sandboxRoot, path.dirname(options.transcriptPath), path.dirname(options.lastMessagePath)];
    const transcript = redactSensitiveText(result.stdout.trimEnd(), { paths: redactionPaths });
    await writeFile(options.transcriptPath, transcript ? `${transcript}\n` : "");
    const stderrPath = options.transcriptPath.replace(/\.jsonl$/u, ".stderr.log");
    const stderr = redactSensitiveText(result.stderr.trimEnd(), { paths: redactionPaths });
    await writeFile(stderrPath, stderr ? `${stderr}\n` : "");
    const transcriptLines = transcript ? transcript.split(/\r?\n/u).length : 0;
    push("runner_transcript", "codex", {
        transcriptPath: artifactRef("transcripts", options.transcriptPath),
        stderrPath: artifactRef("transcripts", stderrPath),
        transcriptLines,
        stderrBytes: Buffer.byteLength(stderr)
    });
    const liveResult = await readLiveResult(options.lastMessagePath, redactionPaths);
    await redactArtifactFile(options.lastMessagePath, redactionPaths);
    push("runner_result", "codex", {
        lastMessagePath: artifactRef("last-messages", options.lastMessagePath),
        parsed: liveResult.parsed,
        verdict: liveResult.verdict,
        caveats: liveResult.caveats,
        hardFailureCodes: liveResult.hardFailureCodes,
        observationLevel: "contract_summary",
        authoritative: false
    });
    push("runner_exit", "codex", {
        exitCode: result.exitCode ?? null,
        timedOut: result.timedOut ?? false,
        lastMessagePath: artifactRef("last-messages", options.lastMessagePath)
    });
    push("token_usage", "runner", { input: 0, output: 0, total: 0, wasted: 0, source: "unavailable" });
    push("case_end", "benchmark", { status: result.exitCode === 0 ? "completed" : "runner_failed" });
    return {
        runId: `live-${testCase.id}`,
        caseId: testCase.id,
        runner: {
            name: "codex",
            comparability: capability.comparability
        },
        events,
        wallClockSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        tokens: {
            input: 0,
            output: 0,
            total: 0,
            wasted: 0,
            costEstimateConfidence: "unavailable"
        },
        telemetryCompleteness: result.exitCode === 0 && transcriptLines > 0 ? 0.82 : 0.5
    };
}
export async function runLiveClaudeCase(testCase, contract, capability, options) {
    if (!capability.executable) {
        throw new Error("Claude live runner requires an executable path");
    }
    await mkdir(options.sandboxRoot, { recursive: true });
    await mkdir(path.dirname(options.transcriptPath), { recursive: true });
    await mkdir(path.dirname(options.lastMessagePath), { recursive: true });
    const prompt = buildPrompt(testCase, contract);
    const args = ["-p", prompt, "--output-format", "json"];
    if (options.model) {
        args.push("--model", options.model);
    }
    const startedAt = Date.now();
    const events = [];
    let seq = 0;
    const push = (type, actor, payload) => {
        seq += 1;
        events.push({
            eventId: `event-${String(seq).padStart(3, "0")}`,
            timestamp: new Date(startedAt + seq * 1000).toISOString(),
            type,
            actor,
            payload
        });
    };
    push("case_start", "benchmark", { caseId: testCase.id, templateId: testCase.templateId });
    push("runner_start", "benchmark", {
        runner: "claude",
        executionMode: "live",
        sandbox: "claude-code-default",
        approval: "runner-default"
    });
    const result = await execa(capability.executable, args, {
        cwd: options.sandboxRoot,
        timeout: options.timeoutMs,
        reject: false,
        input: "",
        env: {
            ...process.env,
            ...options.env
        }
    });
    const redactionPaths = [options.sandboxRoot, path.dirname(options.transcriptPath), path.dirname(options.lastMessagePath)];
    const transcript = redactSensitiveText(result.stdout.trimEnd(), { paths: redactionPaths });
    await writeFile(options.transcriptPath, transcript ? `${transcript}\n` : "");
    const stderrPath = options.transcriptPath.replace(/\.jsonl$/u, ".stderr.log");
    const stderr = redactSensitiveText(result.stderr.trimEnd(), { paths: redactionPaths });
    await writeFile(stderrPath, stderr ? `${stderr}\n` : "");
    const transcriptLines = transcript ? transcript.split(/\r?\n/u).length : 0;
    const normalizedLastMessage = normalizeClaudeLastMessage(transcript);
    await writeFile(options.lastMessagePath, `${redactSensitiveText(JSON.stringify(normalizedLastMessage, null, 2), { paths: redactionPaths })}\n`);
    push("runner_transcript", "claude", {
        transcriptPath: artifactRef("transcripts", options.transcriptPath),
        stderrPath: artifactRef("transcripts", stderrPath),
        transcriptLines,
        stderrBytes: Buffer.byteLength(stderr)
    });
    const liveResult = await readLiveResult(options.lastMessagePath, redactionPaths);
    push("runner_result", "claude", {
        lastMessagePath: artifactRef("last-messages", options.lastMessagePath),
        parsed: liveResult.parsed,
        verdict: liveResult.verdict,
        caveats: liveResult.caveats,
        hardFailureCodes: liveResult.hardFailureCodes,
        observationLevel: "contract_summary",
        authoritative: false
    });
    push("runner_exit", "claude", {
        exitCode: result.exitCode ?? null,
        timedOut: result.timedOut ?? false,
        lastMessagePath: artifactRef("last-messages", options.lastMessagePath)
    });
    push("token_usage", "runner", { input: 0, output: 0, total: 0, wasted: 0, source: "unavailable" });
    push("case_end", "benchmark", { status: result.exitCode === 0 ? "completed" : "runner_failed" });
    return {
        runId: `live-${testCase.id}`,
        caseId: testCase.id,
        runner: {
            name: "claude",
            comparability: capability.comparability
        },
        events,
        wallClockSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        tokens: {
            input: 0,
            output: 0,
            total: 0,
            wasted: 0,
            costEstimateConfidence: "unavailable"
        },
        telemetryCompleteness: result.exitCode === 0 && transcriptLines > 0 ? 0.78 : 0.5
    };
}
function artifactRef(directory, filePath) {
    return `${directory}/${path.basename(filePath)}`;
}
async function redactArtifactFile(filePath, paths) {
    try {
        const raw = await readFile(filePath, "utf8");
        await writeFile(filePath, redactSensitiveText(raw, { paths }));
    }
    catch {
        // readLiveResult already records missing or unreadable last-message evidence.
    }
}
async function readLiveResult(lastMessagePath, redactionPaths) {
    try {
        const raw = await readFile(lastMessagePath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            parsed: true,
            verdict: typeof parsed.verdict === "string" ? redactSensitiveText(parsed.verdict, { paths: redactionPaths }) : "unknown",
            caveats: Array.isArray(parsed.caveats)
                ? parsed.caveats
                    .filter((item) => typeof item === "string")
                    .map((item) => redactSensitiveText(item, { paths: redactionPaths }))
                : [],
            hardFailureCodes: Array.isArray(parsed.hardFailureCodes)
                ? parsed.hardFailureCodes
                    .filter((item) => typeof item === "string" && item.trim().length > 0)
                    .map((item) => redactSensitiveText(item.trim(), { paths: redactionPaths }))
                : []
        };
    }
    catch {
        return { parsed: false, verdict: "unparsed", caveats: [], hardFailureCodes: [] };
    }
}
function buildPrompt(testCase, contract) {
    const contractExcerpt = {
        targetId: contract.targetId,
        targetType: contract.targetType,
        roles: contract.roles.map((role) => ({ id: role.id, ownerScopes: role.ownerScopes, path: role.path })),
        statuses: contract.statuses,
        statusSemantics: contract.statusSemantics,
        requiredOwners: contract.requiredOwners,
        routingForbidden: contract.routing.forbidden,
        joins: contract.joins,
        artifacts: contract.artifacts,
        states: contract.states,
        budgets: contract.budgets,
        contractHash: contract.contractHash
    };
    const oracleExpectations = {
        oracleIds: testCase.oracleIds,
        expectedHardFailures: testCase.expectedHardFailures,
        caseContractHash: testCase.contractHash,
        bindings: testCase.bindings,
        caseHash: testCase.caseHash
    };
    return [
        `You are running inside ${PRODUCT_NAME} live-runner verification.`,
        "Do not modify files. Do not call external services. Do not execute production writes.",
        "Do not run shell commands. Use only the case summary in this prompt.",
        "Return a concise JSON object with verdict, evidence, caveats, and hardFailureCodes.",
        "Use PASS only when the provided ContractModel excerpt and case bindings are internally consistent for the named template.",
        "Use FAIL when the provided evidence contradicts the oracle.",
        "Use UNVERIFIED only when the prompt lacks a field required by the Verdict rules.",
        "",
        `Target: ${contract.targetId}`,
        `Case: ${testCase.id}`,
        `Template: ${testCase.templateId}`,
        `Title: ${testCase.title}`,
        `Contract hash: ${contract.contractHash}`,
        `Prompt: ${testCase.prompt}`,
        "",
        "ContractModel excerpt:",
        JSON.stringify(contractExcerpt, null, 2),
        "",
        "Oracle expectations:",
        JSON.stringify(oracleExpectations, null, 2),
        "expectedHardFailures names the failure type this case is designed to detect. It is not an observed failure by itself.",
        "",
        "Required evidence:",
        "- roles: at least one declared role and every binding role should exist in ContractModel roles.",
        "- artifacts: every present case artifact binding should map to a declared artifact or state path; an omitted binding is not applicable.",
        "- statuses: target status codes are raw vocabulary and may use arbitrary names; never require canonical literals.",
        "- statusSemantics: interpret a raw status only through its owner-reviewed semanticClass and scope. Missing or ambiguous mappings are UNVERIFIED.",
        "- contractHash: the caseContractHash must equal the ContractModel contractHash.",
        "- caseHash: caseHash is a case identity hash and must not be compared to the ContractModel contractHash.",
        "",
        "Verdict rules:",
        "- PASS: the AWB runner verdict is PASS when all Required evidence bullets can be verified and no concrete contradiction is observed; it is not a target status code.",
        "- FAIL: a Required evidence bullet is contradicted, or the prompt evidence shows a concrete violation matching an expectedHardFailures item.",
        "- UNVERIFIED: a Required evidence bullet cannot be checked from this prompt.",
        "- hardFailureCodes: include an expectedHardFailures code only when FAIL is based on observed contradictory evidence for that failure type; never copy codes from expectedHardFailures just because they are declared.",
        "- This prompt is contract_summary evidence, not a workflow trace. It cannot by itself prove a gate transition or authorize an event-derived P0.",
        "Allowed hardFailureCodes are TARGET_ROUTE_FORBIDDEN, TARGET_OWNER_BYPASS, GATE_FALSE_PASS, ARTIFACT_PATH_DRIFT, TARGET_JOIN_MISSING, and PRODUCTION_SIDE_EFFECT.",
        "",
        "Return only JSON."
    ].join("\n");
}
function normalizeClaudeLastMessage(raw) {
    try {
        const parsed = JSON.parse(extractJsonText(raw));
        if (isRecord(parsed) && typeof parsed.result === "string") {
            return JSON.parse(extractJsonText(parsed.result));
        }
        if (isRecord(parsed) && typeof parsed.content === "string") {
            return JSON.parse(extractJsonText(parsed.content));
        }
        return parsed;
    }
    catch {
        return { verdict: "unparsed", raw: raw.slice(0, 4000), caveats: ["Claude output was not parseable JSON."] };
    }
}
function extractJsonText(raw) {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1);
    }
    return trimmed;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
