import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { PRODUCT_NAME } from "../core/product.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { AdapterError, validateAdapterContract } from "./sdk.js";
export function createOpenCodeRunnerAdapter(contract, options) {
    validateAdapterContract(contract);
    if (contract.kind !== "runner" ||
        contract.capabilities.runnerName !== "opencode") {
        throw new AdapterError("ADAPTER_CONTRACT_INVALID", "OpenCode requires a runner Adapter contract with runnerName opencode.");
    }
    if (!options.executable) {
        throw new AdapterError("ADAPTER_EXECUTABLE_UNAVAILABLE", "OpenCode executable is required.");
    }
    return {
        contract,
        run: (context) => runLiveOpenCodeCase(context, contract, {
            executable: options.executable
        })
    };
}
export async function runLiveOpenCodeCase(context, adapterContract, options = {}) {
    if (context.capability.name !== "opencode") {
        throw new AdapterError("ADAPTER_CAPABILITY_UNSUPPORTED", `OpenCode Adapter cannot execute runner ${context.capability.name}.`);
    }
    const executable = options.executable ?? context.capability.executable;
    if (!executable) {
        throw new AdapterError("ADAPTER_EXECUTABLE_UNAVAILABLE", "OpenCode live execution requires an executable.");
    }
    assertRunnerEnvironment(context.env);
    await Promise.all([
        mkdir(context.sandboxRoot, { recursive: true }),
        mkdir(path.dirname(context.transcriptPath), { recursive: true }),
        mkdir(path.dirname(context.lastMessagePath), { recursive: true })
    ]);
    const args = [
        "run",
        "--format",
        "json",
        "--dir",
        context.sandboxRoot
    ];
    if (context.model) {
        args.push("--model", context.model);
    }
    args.push(buildPrompt(context.testCase, context.contract));
    const startedAt = Date.now();
    let result;
    try {
        result = await execa(executable, args, {
            cwd: context.sandboxRoot,
            timeout: context.timeoutMs,
            reject: false,
            input: "",
            env: filteredRunnerEnvironment(context.env)
        });
    }
    catch (error) {
        const code = errorCode(error);
        throw new AdapterError(code === "ENOENT"
            ? "ADAPTER_EXECUTABLE_UNAVAILABLE"
            : "ADAPTER_EXECUTION_FAILED", code === "ENOENT"
            ? "OpenCode executable could not be started."
            : "OpenCode execution failed before producing a result.", { cause: error });
    }
    if (result.timedOut) {
        throw new AdapterError("ADAPTER_TIMEOUT", "OpenCode execution exceeded the configured timeout.");
    }
    const rawStdout = result.stdout.trimEnd();
    const rawStderr = result.stderr.trimEnd();
    if (Buffer.byteLength(rawStdout) >
        adapterContract.evidenceLimits.maxTranscriptBytes ||
        Buffer.byteLength(rawStdout) + Buffer.byteLength(rawStderr) >
            adapterContract.evidenceLimits.maxTotalEvidenceBytes) {
        throw new AdapterError("ADAPTER_EVIDENCE_LIMIT_EXCEEDED", "OpenCode transcript exceeded the Adapter evidence limit.");
    }
    const redactionPaths = [
        context.sandboxRoot,
        path.dirname(context.transcriptPath),
        path.dirname(context.lastMessagePath)
    ];
    const transcript = redactSensitiveText(rawStdout, {
        paths: redactionPaths
    });
    const stderr = redactSensitiveText(rawStderr, {
        paths: redactionPaths
    });
    const parsedEvents = parseJsonLines(transcript);
    const nativeTokens = extractNativeTokens(parsedEvents);
    const normalizedResult = extractResult(parsedEvents, redactionPaths);
    if (!nativeTokens) {
        throw new AdapterError("ADAPTER_TOKEN_EVIDENCE_INVALID", "OpenCode JSON output did not contain native assistant token evidence.");
    }
    if (!normalizedResult.parsed) {
        throw new AdapterError("ADAPTER_OUTPUT_INVALID", "OpenCode JSON output did not contain a structured final verdict.");
    }
    const stderrPath = context.transcriptPath.replace(/\.jsonl$/u, ".stderr.log");
    await Promise.all([
        writeFile(context.transcriptPath, transcript ? `${transcript}\n` : ""),
        writeFile(stderrPath, stderr ? `${stderr}\n` : ""),
        writeFile(context.lastMessagePath, `${JSON.stringify(normalizedResult, null, 2)}\n`)
    ]);
    const events = [];
    let sequence = 0;
    const push = (type, actor, payload) => {
        sequence += 1;
        events.push({
            eventId: `event-${String(sequence).padStart(3, "0")}`,
            timestamp: new Date(startedAt + sequence).toISOString(),
            type,
            actor,
            payload
        });
    };
    push("case_start", "benchmark", {
        caseId: context.testCase.id,
        templateId: context.testCase.templateId
    });
    push("runner_start", "benchmark", {
        runner: "opencode",
        executionMode: "live",
        outputFormat: "jsonl",
        automaticPermissionApproval: false
    });
    push("runner_transcript", "opencode", {
        transcriptPath: artifactRef("transcripts", context.transcriptPath),
        stderrPath: artifactRef("transcripts", stderrPath),
        transcriptLines: parsedEvents.length,
        stderrBytes: Buffer.byteLength(stderr)
    });
    push("runner_result", "opencode", {
        lastMessagePath: artifactRef("last-messages", context.lastMessagePath),
        parsed: normalizedResult.parsed,
        verdict: normalizedResult.verdict,
        caveats: normalizedResult.caveats,
        hardFailureCodes: normalizedResult.hardFailureCodes
    });
    for (const code of normalizedResult.hardFailureCodes) {
        push("hard_failure", "opencode", {
            code,
            why: `OpenCode reported hard failure ${code}.`
        });
    }
    push("runner_exit", "opencode", {
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut ?? false,
        lastMessagePath: artifactRef("last-messages", context.lastMessagePath)
    });
    push("token_usage", "runner", {
        ...nativeTokens.usage,
        source: "native",
        aggregation: nativeTokens.detail.aggregation,
        native: nativeTokens.detail
    });
    push("case_end", "benchmark", {
        status: result.exitCode === 0 && !result.timedOut
            ? "completed"
            : "runner_failed"
    });
    return {
        runId: `live-${context.testCase.id}`,
        caseId: context.testCase.id,
        runner: {
            name: "opencode",
            comparability: context.capability.comparability
        },
        events,
        wallClockSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        tokens: {
            ...nativeTokens.usage,
            costEstimateConfidence: "high"
        },
        telemetryCompleteness: result.exitCode === 0 &&
            !result.timedOut &&
            normalizedResult.parsed &&
            parsedEvents.length > 0
            ? 0.9
            : 0.5
    };
}
function parseJsonLines(transcript) {
    if (!transcript) {
        throw new AdapterError("ADAPTER_OUTPUT_INVALID", "OpenCode did not emit JSONL output.");
    }
    const events = [];
    for (const [index, line] of transcript.split(/\r?\n/u).entries()) {
        if (!line.trim()) {
            continue;
        }
        let value;
        try {
            value = JSON.parse(line);
        }
        catch (error) {
            throw new AdapterError("ADAPTER_OUTPUT_INVALID", `OpenCode JSONL line ${index + 1} is invalid JSON.`, { cause: error });
        }
        if (!isRecord(value) || typeof value.type !== "string") {
            throw new AdapterError("ADAPTER_OUTPUT_INVALID", `OpenCode JSONL line ${index + 1} has no event type.`);
        }
        events.push(value);
    }
    return events;
}
function extractNativeTokens(events) {
    const steps = new Map();
    for (const [index, event] of events.entries()) {
        if (event.type !== "step_finish" || !isRecord(event.part)) {
            continue;
        }
        const tokens = isRecord(event.part.tokens)
            ? event.part.tokens
            : undefined;
        const normalized = nativeTokenRecord(tokens);
        if (!normalized) {
            return undefined;
        }
        const key = typeof event.part.id === "string" && event.part.id
            ? event.part.id
            : `step-${index}`;
        steps.set(key, normalized);
    }
    if (steps.size === 0) {
        return undefined;
    }
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reportedTotal = 0;
    let allReportedTotalsPresent = true;
    for (const step of steps.values()) {
        if (!step) {
            return undefined;
        }
        input += step.input;
        output += step.output;
        reasoning += step.reasoning;
        cacheRead += step.cacheRead;
        cacheWrite += step.cacheWrite;
        if (step.reportedTotal === undefined) {
            allReportedTotalsPresent = false;
        }
        else {
            reportedTotal += step.reportedTotal;
        }
    }
    const awbInput = input + cacheRead + cacheWrite;
    const awbOutput = output + reasoning;
    const total = awbInput + awbOutput;
    if (![
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        awbInput,
        awbOutput,
        total
    ].every(Number.isSafeInteger)) {
        return undefined;
    }
    return {
        usage: {
            input: awbInput,
            output: awbOutput,
            total,
            wasted: 0
        },
        detail: {
            aggregation: "step_sum",
            input,
            output,
            reasoning,
            cacheRead,
            cacheWrite,
            ...(allReportedTotalsPresent ? { reportedTotal } : {})
        }
    };
}
function nativeTokenRecord(tokens) {
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    if (!tokens ||
        !cache ||
        !isNonNegativeInteger(tokens.input) ||
        !isNonNegativeInteger(tokens.output) ||
        !isNonNegativeInteger(tokens.reasoning) ||
        !isNonNegativeInteger(cache.read) ||
        !isNonNegativeInteger(cache.write) ||
        (tokens.total !== undefined &&
            !isNonNegativeInteger(tokens.total))) {
        return undefined;
    }
    return {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: cache.read,
        cacheWrite: cache.write,
        ...(tokens.total === undefined
            ? {}
            : { reportedTotal: tokens.total })
    };
}
function extractResult(events, redactionPaths) {
    const structured = events
        .filter((event) => event.type === "message.updated")
        .map((event) => event.info)
        .filter(isRecord)
        .map((info) => info.structured)
        .filter(isRecord)
        .at(-1);
    const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.part)
        .filter(isRecord)
        .map((part) => part.text)
        .filter((value) => typeof value === "string")
        .join("\n");
    const parsed = structured ?? parseStructuredText(text);
    if (!isRecord(parsed)) {
        return {
            parsed: false,
            verdict: "UNVERIFIED",
            caveats: [],
            hardFailureCodes: []
        };
    }
    const verdict = normalizeVerdict(parsed.verdict);
    return {
        parsed: true,
        verdict,
        caveats: stringArray(parsed.caveats).map((value) => redactSensitiveText(value, { paths: redactionPaths })),
        hardFailureCodes: stringArray(parsed.hardFailureCodes).map((value) => redactSensitiveText(value.trim(), { paths: redactionPaths }))
    };
}
function parseStructuredText(value) {
    if (!value.trim()) {
        return undefined;
    }
    const candidates = [
        value.trim(),
        ...value
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .reverse()
    ];
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            // Try a narrower JSON event fragment.
        }
    }
    return undefined;
}
function normalizeVerdict(value) {
    const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (normalized === "PASS" ||
        normalized === "FAIL" ||
        normalized === "UNVERIFIED") {
        return normalized;
    }
    return "UNVERIFIED";
}
function buildPrompt(testCase, contract) {
    return [
        `You are running inside ${PRODUCT_NAME} OpenCode Adapter conformance.`,
        "Do not modify files, call external services, or approve permissions automatically.",
        "Return one JSON object with verdict, caveats, and hardFailureCodes.",
        `Target: ${contract.targetId}`,
        `Contract hash: ${contract.contractHash}`,
        `Case: ${testCase.id}`,
        `Template: ${testCase.templateId}`,
        `Prompt: ${testCase.prompt}`,
        `Oracle expectations: ${JSON.stringify({
            oracleIds: testCase.oracleIds,
            expectedHardFailures: testCase.expectedHardFailures,
            bindings: testCase.bindings,
            caseHash: testCase.caseHash
        })}`
    ].join("\n");
}
function filteredRunnerEnvironment(additions) {
    const merged = {
        ...process.env,
        ...additions
    };
    for (const key of Object.keys(merged)) {
        if (isObserverPrivateKeyVariable(key)) {
            delete merged[key];
        }
    }
    return merged;
}
function assertRunnerEnvironment(additions) {
    const blocked = Object.entries(additions ?? {}).filter(([key, value]) => isObserverPrivateKeyVariable(key) ||
        /BEGIN [A-Z ]*PRIVATE KEY/iu.test(value));
    if (blocked.length > 0) {
        throw new AdapterError("ADAPTER_PRIVATE_DATA_REJECTED", "Observer or qualification private-key variables cannot enter the Runner environment.");
    }
}
function isObserverPrivateKeyVariable(key) {
    return (/(OBSERVER|QUALIFICATION).*(KEY|PRIVATE|SIGNING|SECRET|CREDENTIAL)/iu.test(key) ||
        /(KEY|PRIVATE|SIGNING|SECRET|CREDENTIAL).*(OBSERVER|QUALIFICATION)/iu.test(key));
}
function artifactRef(directory, filePath) {
    return `${directory}/${path.basename(filePath)}`;
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];
}
function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function errorCode(error) {
    return error instanceof Error && "code" in error
        ? String(error.code)
        : undefined;
}
