import { Command } from "commander";
import { Ajv2020 } from "ajv/dist/2020.js";
import { access, appendFile, copyFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { getBenchmarkRoot, listTargetIds, loadTargetPack } from "../core/targetRegistry.js";
import { profileTarget } from "../profiler/profileTarget.js";
import { inferTargetPackDraft } from "../profiler/targetPackInitializer.js";
import { materializeAiSuite, materializeSmokeSuite } from "../generator/materialize.js";
import { runAiCasePlanner } from "../generator/aiPlanner.js";
import { recommendedAiCaseCount, validateAiCasePlan } from "../generator/coverage.js";
import { runCase } from "../runner/simulatedRunner.js";
import { detectRunnerCapability } from "../runner/runnerCapabilities.js";
import { runLiveClaudeCase, runLiveCodexCase } from "../runner/liveCodexRunner.js";
import { scoreCase, scoreSuite } from "../scorer/score.js";
import { prepareDebugEnvironment, reverseValidate } from "../debug/debugWorkflow.js";
import { renderMarkdownReport } from "../report/report.js";
import { ensureDir, readJson, readYaml, writeJson, writeYaml } from "../utils/io.js";
import { AWB_VERSION, CLI_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "../core/product.js";
import { diagnoseWorkflow, renderDoctorReport } from "../doctor/doctor.js";
import { buildRunProvenance, publicRunnerCapability, semanticCaseSetHash } from "../regression/provenance.js";
import { verifyWorkflowTraceBundle } from "../observer/workflowTrace.js";
import { createComparisonBundle, renderComparisonReport, verifyComparisonBundle } from "../regression/compare.js";
import { evaluateGate, gateExitCode, renderGateReport } from "../regression/gate.js";
import { getEvaluationContract } from "../evaluation/evaluationContract.js";
import { profileEvidenceSensitiveValues, publicAiCasePlan, publicProfileEvidence } from "../utils/redaction.js";
const program = new Command();
program.name(CLI_NAME).description(`${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`).version(AWB_VERSION);
program
    .command("doctor")
    .description("Discover a target workflow and report runner/evidence readiness")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--runner <runner>", "codex, claude, opencode, or simulated", "codex")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const profile = await profileTarget(await loadTargetPack(options.target, { rootOverride: options.targetRoot }));
    const capability = await detectRunnerCapability(normalizeRunnerName(options.runner));
    const result = diagnoseWorkflow(profile, capability);
    await writeJson(path.join(options.out, "doctor-result.json"), result);
    await writeReportFile(path.join(options.out, "doctor-report.md"), renderDoctorReport(result));
    console.log(`doctor written: ${options.out}`);
});
program.command("validate-schema").action(async () => {
    await validateSchemasAndTargets();
    console.log("schemas valid");
    console.log("runner configs valid");
});
program
    .command("init-target")
    .requiredOption("--agent-root <path>")
    .requiredOption("--target-id <id>")
    .option("--name <name>")
    .option("--target-type <type>", "directory, cli, or hybrid", "directory")
    .requiredOption("--out <path>")
    .option("--gaps-out <path>")
    .action(async (options) => {
    const result = await inferTargetPackDraft({
        agentRoot: options.agentRoot,
        targetId: options.targetId,
        name: options.name,
        targetType: normalizeTargetType(options.targetType)
    });
    await writeYaml(options.out, result.targetPack);
    const gapsPath = options.gapsOut ?? options.out.replace(/(\.ya?ml)?$/u, ".gaps.md");
    await writeReportFile(gapsPath, result.gapsMarkdown);
    console.log(`target pack draft written: ${options.out}`);
    console.log(`review gaps written: ${gapsPath}`);
});
program
    .command("plan-cases")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--runner <runner>", "codex, claude, or fixture", "codex")
    .option("--coverage-mode <mode>", "smoke, full, or adaptive", "smoke")
    .option("--live-model <model>", "model for live Codex/Claude planning")
    .option("--timeout-ms <ms>", "AI planner timeout in milliseconds", "120000")
    .option("--max-cases <n>", "maximum AI cases to request")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const profile = await profileTarget(await loadTargetPack(options.target, { rootOverride: options.targetRoot }));
    const coverageMode = normalizeCoverageMode(options.coverageMode);
    const maxCases = options.maxCases
        ? parsePositiveInt(options.maxCases, "--max-cases")
        : recommendedAiCaseCount(profile.contract, { coverageMode });
    const run = await runAiCasePlanner(profile.contract, {
        runner: normalizeAiPlannerRunner(options.runner),
        model: options.liveModel,
        coverageMode,
        timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms"),
        maxCases,
        outDir: options.out,
        evidence: profile.evidence
    });
    await writeJson(path.join(options.out, "ai-case-plan-validation.json"), validateAiCasePlan(run.plan, profile.contract, { coverageMode }));
    await writeJson(path.join(options.out, "ai-case-plan.json"), run.plan);
    console.log(`AI case plan written: ${path.join(options.out, "ai-case-plan.json")}`);
});
program
    .command("profile")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const profile = await profileTarget(await loadTargetPack(options.target, { rootOverride: options.targetRoot }));
    await ensureDir(options.out);
    await writeJson(path.join(options.out, "profile-evidence.json"), publicProfileEvidence(profile.evidence));
    await writeJson(path.join(options.out, "contract-model.json"), profile.contract);
    await writeJson(path.join(options.out, "profile-summary.json"), {
        targetId: profile.contract.targetId,
        contractHash: profile.contract.contractHash,
        missingFiles: profile.evidence.missingFiles.length,
        roles: profile.contract.roles.length
    });
    console.log(`profile written: ${options.out}`);
});
program
    .command("materialize")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--suite <name>", "suite name", "smoke")
    .option("--coverage-mode <mode>", "smoke, full, or adaptive")
    .option("--strategy <strategy>", "template or ai", "template")
    .option("--ai-plan <path>", "AI planner JSON artifact for --strategy ai")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const profile = await profileTarget(await loadTargetPack(options.target, { rootOverride: options.targetRoot }));
    const strategy = normalizeMaterializeStrategy(options.strategy);
    const sensitiveValues = profileEvidenceSensitiveValues(profile.evidence);
    const rawAiPlan = strategy === "ai" ? await readRequiredAiPlan(options.aiPlan) : undefined;
    const aiPlan = rawAiPlan
        ? publicAiCasePlan(rawAiPlan, { values: sensitiveValues })
        : undefined;
    const suite = aiPlan
        ? materializeAiSuite(profile.contract, {
            planner: aiPlan.planner,
            model: aiPlan.model,
            plan: aiPlan,
            suite: options.suite,
            sensitiveValues
        })
        : materializeSmokeSuite(profile.contract, { suite: options.suite });
    await ensureDir(options.out);
    if (aiPlan) {
        const coverageMode = options.coverageMode ? normalizeCoverageMode(options.coverageMode) : aiPlan.coverageMode ?? "smoke";
        await writeJson(path.join(options.out, "ai-case-plan-validation.json"), validateAiCasePlan(aiPlan, profile.contract, { coverageMode }));
    }
    for (const testCase of suite.cases) {
        await writeYaml(path.join(options.out, `${testCase.id}.yaml`), testCase);
    }
    await writeJson(path.join(options.out, "manifest.json"), suite.manifest);
    await writeJson(path.join(options.out, "template-applicability.json"), suite.applicability);
    console.log(`materialized ${suite.cases.length} cases: ${options.out}`);
});
program
    .command("run")
    .option("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--suite <name>", "suite name", "smoke")
    .option("--case <path>")
    .option("--cases-dir <dir>")
    .option("--runner <id>", "runner id", "codex")
    .option("--execution <mode>", "simulated, live, or auto", "simulated")
    .option("--live-model <model>", "model for live Codex execution")
    .option("--timeout-ms <ms>", "live runner timeout in milliseconds", "120000")
    .option("--mode <mode>", "gate or diagnostic", "diagnostic")
    .option("--mutation <path>", "simulated mutation overlay to inject into each case")
    .option("--p0-case-log <path>", "append P0 case records to a local JSONL file")
    .option("--out <dir>", "output dir")
    .option("--dry-run", "prepare without external runner", false)
    .action(async (options) => {
    const runDir = options.out ?? path.join("reports/runs", `run-${Date.now()}`);
    await ensureDir(runDir);
    const { target, profile, contract, cases } = await resolveRunInputs(options);
    const runnerCapability = await detectRunnerCapability(normalizeRunnerName(options.runner));
    const executionMode = normalizeExecutionMode(options.execution);
    const mutation = options.mutation ? (await loadMutations({ mutation: options.mutation }))[0] : undefined;
    if (mutation && executionMode === "live") {
        throw new Error("--mutation is only supported for simulated execution");
    }
    if (!runnerCapability.supported && !options.dryRun) {
        throw new Error(`Runner ${runnerCapability.name} is unavailable: ${runnerCapability.disabledReason}`);
    }
    if (options.dryRun) {
        const suiteResult = scoreSuite(path.basename(runDir), contract, options.suite, [], runEvidenceContext(executionMode, true));
        await writeJson(path.join(runDir, "suite-result.json"), suiteResult);
        await writeRecommendationArtifacts(runDir, suiteResult);
        await writeP0CaseArtifacts(runDir, suiteResult, options.p0CaseLog);
        const runtimeManifestPath = path.join(runDir, "runtime-manifest.json");
        await writeJson(runtimeManifestPath, {
            runner: {
                ...publicRunnerCapability(runnerCapability),
                executionMode
            },
            mode: options.mode,
            dryRun: true,
            contractHash: contract.contractHash,
            caseCount: 0,
            skippedCaseCount: cases.length,
            caseSource: options.casesDir ? "cases://provided" : "target://materialized",
            mutation
        });
        await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
            profile,
            cases,
            suite: options.suite,
            runner: runnerCapability,
            executionMode,
            model: options.liveModel,
            mutation,
            artifacts: [
                { ref: "suite-result.json", path: path.join(runDir, "suite-result.json") },
                { ref: "runtime-manifest.json", path: runtimeManifestPath }
            ],
            targetRoot: target.root,
            dryRun: true
        }));
        console.log(`run written: ${runDir}`);
        enforceGateMode(options.mode, suiteResult);
        return;
    }
    const caseResults = [];
    let liveTranscriptCount = 0;
    for (const testCase of cases) {
        const run = executionMode === "live"
            ? await runLiveCase(testCase, contract, runnerCapability, runDir, {
                model: options.liveModel,
                timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms")
            })
            : runCase(testCase, contract, mutation);
        if (executionMode === "live") {
            liveTranscriptCount += 1;
        }
        const result = scoreCase(testCase, run);
        caseResults.push(result);
        await writeJson(path.join(runDir, "events", `${testCase.id}.json`), run.events);
        await writeJson(path.join(runDir, "case-results", `${testCase.id}.json`), result);
    }
    const suiteResult = scoreSuite(path.basename(runDir), contract, options.suite, caseResults, runEvidenceContext(executionMode));
    await writeJson(path.join(runDir, "suite-result.json"), suiteResult);
    await writeRecommendationArtifacts(runDir, suiteResult);
    await writeP0CaseArtifacts(runDir, suiteResult, options.p0CaseLog);
    const runtimeManifestPath = path.join(runDir, "runtime-manifest.json");
    await writeJson(runtimeManifestPath, {
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode
        },
        mode: options.mode,
        dryRun: options.dryRun,
        contractHash: contract.contractHash,
        caseCount: cases.length,
        liveTranscriptCount,
        caseSource: options.casesDir ? "cases://provided" : "target://materialized",
        mutation
    });
    await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
        profile,
        cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode,
        model: options.liveModel,
        mutation,
        artifacts: [
            { ref: "suite-result.json", path: path.join(runDir, "suite-result.json") },
            { ref: "runtime-manifest.json", path: runtimeManifestPath }
        ],
        targetRoot: target.root
    }));
    console.log(`run written: ${runDir}`);
    enforceGateMode(options.mode, suiteResult);
});
program
    .command("ingest-trace")
    .description("Verify and score a signed workflow trace (diagnostic until Observer qualification)")
    .option("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--suite <name>", "suite name", "smoke")
    .option("--case <path>")
    .option("--cases-dir <dir>")
    .requiredOption("--trace <path>", "signed workflow-trace JSON bundle")
    .requiredOption("--trusted-observer-key <path>", "trusted Ed25519 observer public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const { target, profile, contract, cases } = await resolveRunInputs(options);
    const tracePath = await resolveExistingPath(options.trace);
    const trustedObserverKeyPath = await resolveExistingPath(options.trustedObserverKey);
    const verifiedTrace = await verifyWorkflowTraceBundle(tracePath, trustedObserverKeyPath, {
        targetId: contract.targetId,
        contractHash: contract.contractHash,
        suite: options.suite,
        caseSetHash: semanticCaseSetHash(cases),
        caseIds: cases.map((testCase) => testCase.id),
        cases: cases.map((testCase) => ({ id: testCase.id, templateId: testCase.templateId }))
    });
    const runnerCapability = workflowTraceRunnerCapability(verifiedTrace.bundle.subject.runner);
    const runByCaseId = new Map(verifiedTrace.runs.map((run) => [run.caseId, run]));
    const caseResults = [];
    await ensureDir(options.out);
    for (const testCase of cases) {
        const run = runByCaseId.get(testCase.id);
        if (!run) {
            throw new Error(`Verified workflow trace is missing case ${testCase.id}.`);
        }
        const result = scoreCase(testCase, run);
        caseResults.push(result);
        await writeJson(path.join(options.out, "events", `${testCase.id}.json`), run.events);
        await writeJson(path.join(options.out, "case-results", `${testCase.id}.json`), result);
    }
    const suiteResult = scoreSuite(path.basename(options.out), contract, options.suite, caseResults, {
        evidenceKind: "live",
        observationLevel: "workflow_trace",
        observerQualification: "missing"
    });
    await writeJson(path.join(options.out, "suite-result.json"), suiteResult);
    await writeRecommendationArtifacts(options.out, suiteResult);
    await writeP0CaseArtifacts(options.out, suiteResult);
    await writeReport(path.join(options.out, "report.md"), suiteResult);
    const traceArtifactPath = path.join(options.out, "workflow-trace.json");
    await copyFile(tracePath, traceArtifactPath);
    const runtimeManifestPath = path.join(options.out, "runtime-manifest.json");
    await writeJson(runtimeManifestPath, {
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode: "live"
        },
        mode: "diagnostic",
        dryRun: false,
        contractHash: contract.contractHash,
        caseCount: cases.length,
        liveTranscriptCount: 0,
        caseSource: options.casesDir ? "cases://provided" : options.case ? "case://provided" : "target://materialized",
        workflowTrace: {
            verified: true,
            ref: "workflow-trace.json",
            sha256: verifiedTrace.traceHash,
            caseCount: verifiedTrace.runs.length,
            eventCount: verifiedTrace.eventCount,
            observer: {
                id: verifiedTrace.bundle.observer.id,
                version: verifiedTrace.bundle.observer.version,
                keyFingerprint: verifiedTrace.keyFingerprint,
                qualificationStatus: "missing"
            }
        }
    });
    await writeJson(path.join(options.out, "provenance.json"), await buildRunProvenance({
        profile,
        cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode: "live",
        verifiedTrace,
        artifacts: [
            { ref: "suite-result.json", path: path.join(options.out, "suite-result.json") },
            { ref: "runtime-manifest.json", path: runtimeManifestPath },
            { ref: "workflow-trace.json", path: traceArtifactPath }
        ],
        targetRoot: target.root
    }));
    console.log(`attested workflow trace ingested: ${options.out}`);
});
program
    .command("evaluate")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--planner-runner <runner>", "codex, claude, or fixture", "codex")
    .option("--runner <id>", "runner id", "codex")
    .option("--coverage-mode <mode>", "smoke, full, or adaptive", "full")
    .option("--suite <name>", "suite name", "smoke")
    .option("--execution <mode>", "simulated, live, or auto", "simulated")
    .option("--live-model <model>", "model for live Codex/Claude planning or execution")
    .option("--timeout-ms <ms>", "AI planner and live runner timeout in milliseconds", "120000")
    .option("--max-cases <n>", "maximum AI cases to request")
    .option("--mutation <path>", "simulated mutation overlay to inject into each case")
    .option("--p0-case-log <path>", "append P0 case records to a local JSONL file")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const outDir = options.out;
    const profileDir = path.join(outDir, "profile");
    const planDir = path.join(outDir, "ai-plan");
    const casesDir = path.join(outDir, "cases");
    const runDir = path.join(outDir, "run");
    const timeoutMs = parsePositiveInt(options.timeoutMs, "--timeout-ms");
    const coverageMode = normalizeCoverageMode(options.coverageMode);
    const executionMode = normalizeExecutionMode(options.execution);
    const mutation = options.mutation ? (await loadMutations({ mutation: options.mutation }))[0] : undefined;
    if (mutation && executionMode === "live") {
        throw new Error("--mutation is only supported for simulated execution");
    }
    const target = await loadTargetPack(options.target, { rootOverride: options.targetRoot });
    const profile = await profileTarget(target);
    await ensureDir(profileDir);
    await writeJson(path.join(profileDir, "profile-evidence.json"), publicProfileEvidence(profile.evidence));
    await writeJson(path.join(profileDir, "contract-model.json"), profile.contract);
    await writeJson(path.join(profileDir, "profile-summary.json"), {
        targetId: profile.contract.targetId,
        contractHash: profile.contract.contractHash,
        missingFiles: profile.evidence.missingFiles.length,
        roles: profile.contract.roles.length
    });
    const maxCases = options.maxCases
        ? parsePositiveInt(options.maxCases, "--max-cases")
        : recommendedAiCaseCount(profile.contract, { coverageMode });
    const aiPlanRun = await runAiCasePlanner(profile.contract, {
        runner: normalizeAiPlannerRunner(options.plannerRunner),
        model: options.liveModel,
        coverageMode,
        timeoutMs,
        maxCases,
        outDir: planDir,
        evidence: profile.evidence
    });
    const aiPlanValidation = validateAiCasePlan(aiPlanRun.plan, profile.contract, { coverageMode });
    await writeJson(path.join(planDir, "ai-case-plan-validation.json"), aiPlanValidation);
    await writeJson(path.join(planDir, "ai-case-plan.json"), aiPlanRun.plan);
    const suite = materializeAiSuite(profile.contract, {
        planner: aiPlanRun.plan.planner,
        model: aiPlanRun.plan.model,
        plan: aiPlanRun.plan,
        suite: options.suite,
        sensitiveValues: profileEvidenceSensitiveValues(profile.evidence)
    });
    await ensureDir(casesDir);
    await writeJson(path.join(casesDir, "ai-case-plan-validation.json"), aiPlanValidation);
    for (const testCase of suite.cases) {
        await writeYaml(path.join(casesDir, `${testCase.id}.yaml`), testCase);
    }
    await writeJson(path.join(casesDir, "manifest.json"), suite.manifest);
    await writeJson(path.join(casesDir, "template-applicability.json"), suite.applicability);
    await ensureDir(runDir);
    const runnerCapability = await detectRunnerCapability(normalizeRunnerName(options.runner));
    if (!runnerCapability.supported) {
        throw new Error(`Runner ${runnerCapability.name} is unavailable: ${runnerCapability.disabledReason}`);
    }
    const caseResults = [];
    let liveTranscriptCount = 0;
    for (const testCase of suite.cases) {
        const run = executionMode === "live"
            ? await runLiveCase(testCase, profile.contract, runnerCapability, runDir, {
                model: options.liveModel,
                timeoutMs
            })
            : runCase(testCase, profile.contract, mutation);
        if (executionMode === "live") {
            liveTranscriptCount += 1;
        }
        const result = scoreCase(testCase, run);
        caseResults.push(result);
        await writeJson(path.join(runDir, "events", `${testCase.id}.json`), run.events);
        await writeJson(path.join(runDir, "case-results", `${testCase.id}.json`), result);
    }
    const suiteResult = scoreSuite(path.basename(runDir), profile.contract, options.suite, caseResults, runEvidenceContext(executionMode));
    suiteResult.harnessValidation = buildHarnessValidation(profile, aiPlanRun.plan, aiPlanValidation, suite, suiteResult);
    applyHarnessGate(suiteResult);
    await writeJson(path.join(runDir, "suite-result.json"), suiteResult);
    await writeJson(path.join(runDir, "harness-validation.json"), suiteResult.harnessValidation);
    await writeRecommendationArtifacts(runDir, suiteResult);
    await writeP0CaseArtifacts(runDir, suiteResult, options.p0CaseLog ?? path.join(outDir, "p0-cases.jsonl"));
    const runtimeManifestPath = path.join(runDir, "runtime-manifest.json");
    await writeJson(runtimeManifestPath, {
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode
        },
        mode: "diagnostic",
        dryRun: false,
        contractHash: profile.contract.contractHash,
        caseCount: suite.cases.length,
        liveTranscriptCount,
        caseSource: "evaluation://cases",
        mutation
    });
    await writeReport(path.join(runDir, "report.md"), suiteResult);
    await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
        profile,
        cases: suite.cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode,
        model: options.liveModel,
        mutation,
        artifacts: [
            { ref: "suite-result.json", path: path.join(runDir, "suite-result.json") },
            { ref: "runtime-manifest.json", path: runtimeManifestPath }
        ],
        targetRoot: target.root
    }));
    await writeJson(path.join(outDir, "evaluation-summary.json"), {
        schemaVersion: "0.1.0",
        targetId: profile.contract.targetId,
        contractHash: profile.contract.contractHash,
        suite: options.suite,
        coverageMode,
        caseCount: suite.cases.length,
        releaseDecision: suiteResult.releaseDecision,
        score: suiteResult.cappedSuiteScore,
        p0CaseCount: suiteResult.p0CaseRecords.length,
        recommendationCount: suiteResult.recommendations.length,
        harness: {
            status: suiteResult.harnessValidation.status,
            plan: suiteResult.harnessValidation.plan,
            phases: suiteResult.harnessValidation.phases,
            artifacts: {
                harnessValidation: "run/harness-validation.json"
            }
        },
        artifacts: {
            profile: "profile/contract-model.json",
            aiPlan: "ai-plan/ai-case-plan.json",
            casesManifest: "cases/manifest.json",
            suiteResult: "run/suite-result.json",
            report: "run/report.md",
            harnessValidation: "run/harness-validation.json",
            recommendations: "run/recommendations.json",
            p0Cases: "run/p0-cases.json",
            p0CaseLog: options.p0CaseLog ? "external://p0-case-log" : "p0-cases.jsonl",
            provenance: "run/provenance.json"
        }
    });
    console.log(`evaluation written: ${outDir}`);
});
program
    .command("compare")
    .description("Compare matched baseline and candidate run artifacts")
    .requiredOption("--baseline <dir>", "baseline run or evaluation directory")
    .requiredOption("--candidate <dir>", "candidate run or evaluation directory")
    .option("--trusted-observer-key <path>", "trusted Ed25519 observer public key for workflow_trace evidence")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const result = await createComparisonBundle(options.baseline, options.candidate, options.out, {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined
    });
    await writeJson(path.join(options.out, "comparison-result.json"), result);
    await writeReportFile(path.join(options.out, "comparison-report.md"), renderComparisonReport(result));
    console.log(`comparison written: ${options.out}`);
});
program
    .command("gate")
    .description("Apply evidence-first CI policy; unqualified evidence remains diagnostic")
    .requiredOption("--comparison <path>", "comparison-result.json")
    .option("--trusted-observer-key <path>", "trusted Ed25519 observer public key for workflow_trace evidence")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const comparison = await readJson(options.comparison);
    const verification = await verifyComparisonBundle(options.comparison, comparison, {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined
    });
    const result = evaluateGate(comparison, verification);
    await writeJson(path.join(options.out, "gate-result.json"), result);
    await writeReportFile(path.join(options.out, "gate-report.md"), renderGateReport(result));
    console.log(`gate written: ${options.out}`);
    process.exitCode = gateExitCode(result.decision);
});
program
    .command("score")
    .option("--run <dir>")
    .action(async (options) => {
    if (!options.run) {
        throw new Error("--run is required for this implementation");
    }
    const suiteResult = await readJson(path.join(options.run, "suite-result.json"));
    console.log(JSON.stringify({
        benchmarkEvidenceDecision: suiteResult.releaseDecision,
        releaseDecision: suiteResult.releaseDecision,
        score: suiteResult.cappedSuiteScore,
        scope: "collected benchmark evidence only; not release approval unless real workflow trace events are emitted"
    }));
});
program
    .command("report")
    .requiredOption("--run <dir>")
    .option("--format <format>", "md,json", "md,json")
    .action(async (options) => {
    const suiteResult = await readJson(path.join(options.run, "suite-result.json"));
    if (options.format.includes("md")) {
        await writeReport(path.join(options.run, "report.md"), suiteResult);
    }
    if (options.format.includes("json")) {
        await writeJson(path.join(options.run, "suite-result.json"), suiteResult);
    }
    console.log(`report written: ${options.run}`);
});
const debug = program.command("debug");
debug
    .command("prepare-env")
    .option("--target <id>")
    .option("--suite <name>", "suite name", "smoke")
    .option("--case <path>")
    .option("--runner <id>", "runner id", "codex")
    .option("--mock-profile <profile>", "mock profile", "strict")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const { target, contract, cases } = await resolveDebugInputs(options);
    const env = await prepareDebugEnvironment(target, contract, cases[0], {
        runner: options.runner,
        mockProfile: options.mockProfile,
        outDir: options.out
    });
    console.log(`debug environment written: ${env.sandboxRoot}`);
});
debug
    .command("reverse-validate")
    .option("--target <id>")
    .option("--suite <name>", "suite name", "smoke")
    .option("--case <path>")
    .option("--mutation <path>")
    .option("--mutation-set <path>")
    .option("--runner <id>", "runner id", "simulated")
    .option("--expect <verdict>", "expected mutant verdict: fail, pass_with_warnings, diagnostic_only, or pass")
    .option("--suite-result <path>")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const { target, contract, cases } = await resolveDebugInputs(options);
    const mutations = await loadMutations(options);
    const results = [];
    for (const mutation of mutations) {
        const selectedCase = selectCaseForMutation(cases, mutation);
        results.push(await reverseValidate(target, contract, selectedCase, {
            mutation,
            runner: options.runner,
            expectedVerdict: normalizeExpectedVerdict(options.expect),
            outDir: mutations.length === 1 ? options.out : path.join(options.out, mutation.id)
        }));
    }
    if (mutations.length > 1) {
        const killRate = results.filter((result) => result.mutationKilled).length / results.length;
        const allResultsPassed = results.every((result) => result.status === "PASS");
        await writeJson(path.join(options.out, "debug-summary.json"), {
            status: killRate === 1 && allResultsPassed ? "PASS" : "FAIL",
            mutationKillRate: killRate,
            results: results.map((result) => ({ mutationId: result.mutationId, status: result.status, killed: result.mutationKilled }))
        });
    }
    if (options.suiteResult) {
        await updateSuiteDebugHealth(options.suiteResult, results, options.out);
    }
    console.log(`reverse validation written: ${options.out}`);
    if (options.expect && results.some((result) => !result.expectationMatched)) {
        throw new Error(`Reverse validation expectation ${options.expect} did not match all mutant verdicts`);
    }
    const failedResults = results.filter((result) => result.status === "FAIL");
    if (failedResults.length > 0) {
        throw new Error(`Reverse validation failed for mutation(s): ${failedResults.map((result) => result.mutationId).join(", ")}`);
    }
});
debug
    .command("diagnose")
    .requiredOption("--debug-run <dir>")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const dossier = await buildDebugDossier(options.debugRun);
    await writeJson(path.join(options.out, "debug-dossier.json"), dossier);
    await writeReportFile(path.join(options.out, "debug-dossier.md"), [
        "# Debug Dossier",
        "",
        `Debug: ${dossier.debugId}`,
        `Target: ${dossier.targetId}`,
        `Case: ${dossier.caseId}`,
        `Mutation: ${dossier.mutationId}`,
        `Gap Classification: ${dossier.gapClassification}`,
        "",
        "## Summary",
        "",
        `Mutation Count: ${dossier.summary.mutationCount}`,
        `Mutation Kill Rate: ${dossier.summary.mutationKillRate}`,
        `False Negatives: ${dossier.summary.falseNegativeCount}`,
        `False Positives: ${dossier.summary.falsePositiveCount}`
    ].join("\n"));
    console.log(`diagnosis written: ${options.out}`);
});
debug
    .command("propose-fix")
    .requiredOption("--dossier <path>")
    .requiredOption("--out <path>")
    .action(async (options) => {
    const dossier = await readJson(options.dossier);
    const repairPlan = {
        schemaVersion: "0.1.0",
        gapClassification: dossier.gapClassification,
        allowedApplyScope: "benchmark-repo-only",
        targetWorkflowModificationAllowed: false,
        proposedChanges: dossier.gapClassification === "none"
            ? []
            : [
                {
                    file: "cases/templates/smoke",
                    changeType: "strengthen-oracle-or-fixture",
                    reason: `Diagnosed benchmark gap: ${dossier.gapClassification}`,
                    tests: ["npm run validate"]
                }
            ]
    };
    await writeReportFile(options.out, [
        "# Benchmark Repair Plan",
        "",
        `Gap Classification: ${dossier.gapClassification}`,
        "",
        "- Allowed apply scope: benchmark-repo-only",
        "- Target workflow modification allowed: false"
    ].join("\n"));
    await writeJson(options.out.replace(/\.md$/u, ".json"), repairPlan);
    console.log(`repair plan written: ${options.out}`);
});
debug
    .command("repair")
    .requiredOption("--dossier <path>")
    .option("--apply", "apply benchmark-side safe repair", false)
    .option("--rerun", "rerun reverse validation", false)
    .action(async (options) => {
    const dossier = await readJson(options.dossier);
    const result = {
        schemaVersion: "0.1.0",
        status: dossier.gapClassification === "none" ? "NOOP" : options.apply ? "PROPOSAL_ONLY" : "PLAN_ONLY",
        applied: false,
        rerunRequested: options.rerun,
        targetWorkflowModified: false,
        reason: dossier.gapClassification === "none"
            ? "Reverse validation passed; no benchmark repair is needed."
            : "Automatic apply is limited to safe benchmark-side patches after a concrete repair plan is reviewed."
    };
    await writeJson(path.join(path.dirname(options.dossier), "repair-result.json"), result);
    console.log(`repair result written: ${path.dirname(options.dossier)}`);
});
program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
async function buildDebugDossier(debugRunDir) {
    const singleResult = await tryReadJson(path.join(debugRunDir, "reverse-validation-result.json"));
    if (singleResult) {
        return dossierFromSingleResult(singleResult);
    }
    const summary = await tryReadJson(path.join(debugRunDir, "debug-summary.json"));
    if (!summary) {
        throw new Error(`Debug run ${debugRunDir} is missing reverse-validation-result.json or debug-summary.json`);
    }
    const childResults = (await Promise.all(summary.results.map((result) => tryReadJson(path.join(debugRunDir, result.mutationId, "reverse-validation-result.json"))))).filter((result) => result !== undefined);
    const firstChild = childResults[0];
    const falseNegativeCount = childResults.filter((result) => result.falseNegative).length;
    const falsePositiveCount = childResults.filter((result) => result.falsePositive).length;
    return {
        schemaVersion: "0.1.0",
        debugId: path.basename(debugRunDir),
        targetId: firstChild?.baseline?.targetId ?? "unknown",
        caseId: "aggregate",
        mutationId: "aggregate",
        gapClassification: classifyDebugGap(summary.status, falseNegativeCount, falsePositiveCount),
        summary: {
            mutationCount: summary.results.length,
            mutationKillRate: summary.mutationKillRate,
            falseNegativeCount,
            falsePositiveCount
        }
    };
}
function dossierFromSingleResult(result) {
    return {
        schemaVersion: "0.1.0",
        debugId: result.debugId,
        targetId: result.baseline?.targetId ?? "unknown",
        caseId: result.baseline?.caseId ?? "unknown",
        mutationId: result.mutationId,
        gapClassification: classifyDebugGap(result.status, result.falseNegative ? 1 : 0, result.falsePositive ? 1 : 0),
        summary: {
            mutationCount: 1,
            mutationKillRate: result.mutationKilled ? 1 : 0,
            falseNegativeCount: result.falseNegative ? 1 : 0,
            falsePositiveCount: result.falsePositive ? 1 : 0
        }
    };
}
function classifyDebugGap(status, falseNegativeCount, falsePositiveCount) {
    if (falseNegativeCount > 0) {
        return "oracle_gap";
    }
    if (falsePositiveCount > 0) {
        return "fixture_gap";
    }
    if (status === "PASS") {
        return "none";
    }
    return "oracle_gap";
}
async function tryReadJson(filePath) {
    try {
        return await readJson(filePath);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
function normalizeRunnerName(value) {
    if (value === "codex" || value === "claude" || value === "opencode" || value === "simulated") {
        return value;
    }
    throw new Error(`Unsupported runner: ${value}`);
}
function workflowTraceRunnerCapability(runner) {
    return {
        schemaVersion: "0.1.0",
        name: runner.name,
        supported: true,
        ...(runner.version ? { version: runner.version } : {}),
        adapterVersion: runner.adapterVersion,
        executionMode: "live",
        supportsEntrypointKinds: ["file", "cli"],
        tokenSourceDetail: { source: "native", confidence: "high" },
        comparability: {
            workflowScore: "comparable",
            efficiency: "comparable",
            tokenCost: "comparable"
        },
        capabilitiesHash: runner.capabilitiesHash
    };
}
function normalizeAiPlannerRunner(value) {
    if (value === "codex" || value === "claude" || value === "fixture") {
        return value;
    }
    throw new Error(`Unsupported AI planner runner: ${value}`);
}
function buildHarnessValidation(profile, plan, planValidation, suite, suiteResult) {
    const planSummary = {
        status: planValidation.status,
        recommendedCaseCount: planValidation.recommendedCaseCount,
        coverageTargetCount: planValidation.coverageTargetCount,
        coveredCoverageTargetCount: planValidation.coveredCoverageTargetIds.length,
        missingCoverageTargetCount: planValidation.missingCoverageTargetIds.length,
        unknownCoverageTagCount: planValidation.unknownCoverageTags.length,
        invalidBindingCount: planValidation.invalidBindings.length,
        warnings: planValidation.warnings
    };
    const phases = [
        profile.evidence.missingFiles.length === 0
            ? { phase: "profile", status: "PASS", why: "Target pack files were found and hashed into a ContractModel." }
            : { phase: "profile", status: "FAIL", why: `${profile.evidence.missingFiles.length} declared target file(s) were missing.` },
        plan.workflowUnderstanding
            ? { phase: "understand", status: "PASS", why: "AI planner returned explicit workflow goal, stages, invariants, and scoring signals." }
            : { phase: "understand", status: "WARN", why: "AI planner did not return structured workflowUnderstanding." },
        {
            phase: "plan",
            status: planValidation.status,
            why: planValidation.status === "PASS"
                ? "AI case plan bindings and coverage tags match the ContractModel."
                : `${planValidation.invalidBindings.length} invalid binding(s), ${planValidation.unknownCoverageTags.length} unknown tag(s), and ${planValidation.missingCoverageTargetIds.length} missing coverage target(s) were recorded.`
        },
        suite.cases.length > 0
            ? { phase: "materialize", status: "PASS", why: `${suite.cases.length} executable benchmark case(s) were materialized with stable hashes.` }
            : { phase: "materialize", status: "FAIL", why: "No executable benchmark cases were materialized." },
        suiteResult.caseResults.length === suite.cases.length
            ? { phase: "execute", status: "PASS", why: "Every materialized case has a scored result." }
            : { phase: "execute", status: "FAIL", why: `${suiteResult.caseResults.length}/${suite.cases.length} materialized case(s) produced scored results.` },
        suiteResult.dimensionScores.length > 0
            ? { phase: "score", status: "PASS", why: "Suite result includes multi-dimensional scores and score provenance." }
            : { phase: "score", status: "FAIL", why: "Suite result does not include dimension scores." },
        {
            phase: "recommend",
            status: suiteResult.p0CaseRecords.length > 0 && suiteResult.recommendations.length === 0 ? "FAIL" : "PASS",
            why: suiteResult.p0CaseRecords.length > 0
                ? `${suiteResult.recommendations.length} recommendation(s) were generated for ${suiteResult.p0CaseRecords.length} P0 case record(s).`
                : "No P0 case records required target workflow repair recommendations."
        }
    ];
    const status = phases.some((phase) => phase.status === "FAIL") ? "FAIL" : phases.some((phase) => phase.status === "WARN") ? "WARN" : "PASS";
    return {
        schemaVersion: "0.1.0",
        status,
        plan: planSummary,
        phases
    };
}
function applyHarnessGate(suiteResult) {
    const harnessStatus = suiteResult.harnessValidation?.status;
    if (!harnessStatus || harnessStatus === "PASS") {
        return;
    }
    const hasTargetHardFailure = suiteResult.caseResults.some((result) => result.hardFailures.length > 0);
    if (hasTargetHardFailure) {
        return;
    }
    suiteResult.releaseDecision = "DIAGNOSTIC_ONLY";
    suiteResult.releaseRuleId = harnessStatus === "FAIL" ? "REL-HARNESS-VALIDATION-FAIL" : "REL-HARNESS-VALIDATION-WARN";
}
function runEvidenceContext(executionMode, dryRun = false) {
    if (dryRun) {
        return {
            evidenceKind: "unknown",
            observationLevel: "capability_only"
        };
    }
    return executionMode === "simulated"
        ? {
            evidenceKind: "simulated",
            observationLevel: "synthetic_events"
        }
        : {
            evidenceKind: "live",
            observationLevel: "contract_summary"
        };
}
function normalizeCoverageMode(value) {
    if (value === "smoke" || value === "full" || value === "adaptive") {
        return value;
    }
    throw new Error(`Unsupported coverage mode: ${value}`);
}
function normalizeExecutionMode(value) {
    if (value === "simulated" || value === "auto") {
        return "simulated";
    }
    if (value === "live") {
        return "live";
    }
    throw new Error(`Unsupported execution mode: ${value}`);
}
function normalizeMaterializeStrategy(value) {
    if (value === "template" || value === "ai") {
        return value;
    }
    throw new Error(`Unsupported materialize strategy: ${value}`);
}
function normalizeTargetType(value) {
    if (value === "directory" || value === "cli" || value === "hybrid") {
        return value;
    }
    throw new Error(`Unsupported target type: ${value}`);
}
async function readRequiredAiPlan(filePath) {
    if (!filePath) {
        throw new Error("--ai-plan is required when --strategy ai is used");
    }
    return readJson(filePath);
}
function parsePositiveInt(value, label) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}
async function validateSchemasAndTargets() {
    const ajv = new Ajv2020({ strict: false });
    const benchmarkRoot = getBenchmarkRoot();
    const schemaDir = path.join(benchmarkRoot, "schemas");
    const schemaFiles = (await readdir(schemaDir)).filter((file) => file.endsWith(".schema.json"));
    let validateTarget;
    let validateRunner;
    let validateEvaluationContract;
    let validateContractValidity;
    for (const file of schemaFiles) {
        const schema = JSON.parse(await readFile(path.join(schemaDir, file), "utf8"));
        const validate = ajv.compile(schema);
        if (file === "target-pack.schema.json") {
            validateTarget = validate;
        }
        if (file === "runner.schema.json") {
            validateRunner = validate;
        }
        if (file === "evaluation-contract.schema.json") {
            validateEvaluationContract = validate;
        }
        if (file === "contract-validity.schema.json") {
            validateContractValidity = validate;
        }
    }
    if (!validateTarget) {
        throw new Error("target-pack.schema.json missing");
    }
    if (!validateRunner) {
        throw new Error("runner.schema.json missing");
    }
    if (!validateEvaluationContract) {
        throw new Error("evaluation-contract.schema.json missing");
    }
    if (!validateContractValidity) {
        throw new Error("contract-validity.schema.json missing");
    }
    const evaluationContract = getEvaluationContract();
    if (!validateEvaluationContract(evaluationContract)) {
        throw new Error(`Canonical evaluation contract failed schema validation: ${ajv.errorsText(validateEvaluationContract.errors)}`);
    }
    for (const id of await listTargetIds()) {
        const target = await loadTargetPack(id);
        const { configPath: _configPath, ...declaredTarget } = target;
        if (!validateTarget(declaredTarget)) {
            throw new Error(`Target ${id} failed schema validation: ${ajv.errorsText(validateTarget.errors)}`);
        }
        if (target.contractReview.status !== "reviewed") {
            throw new Error(`Target ${id} is not owner-reviewed.`);
        }
        const contractValidity = await readJson(path.join(benchmarkRoot, target.contractReview.artifactPath));
        if (!validateContractValidity(contractValidity)) {
            throw new Error(`Target ${id} contract-validity artifact failed schema validation: ${ajv.errorsText(validateContractValidity.errors)}`);
        }
    }
    const runnerDir = path.join(benchmarkRoot, "configs/runners");
    for (const file of (await readdir(runnerDir)).filter((entry) => entry.endsWith(".yaml"))) {
        const runnerConfig = YAML.parse(await readFile(path.join(runnerDir, file), "utf8"));
        if (!validateRunner(runnerConfig)) {
            throw new Error(`Runner config ${file} failed schema validation: ${ajv.errorsText(validateRunner.errors)}`);
        }
    }
}
async function resolveRunInputs(options) {
    if (options.case) {
        const testCase = await readYaml(options.case);
        const target = await loadTargetPack(testCase.targetId, { rootOverride: options.targetRoot });
        const profile = await profileTarget(target);
        return { target, profile, contract: profile.contract, cases: [testCase] };
    }
    if (options.casesDir) {
        const caseFiles = (await readdir(options.casesDir))
            .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
            .sort();
        if (caseFiles.length === 0) {
            throw new Error(`No case YAML files found in ${options.casesDir}`);
        }
        const cases = await Promise.all(caseFiles.map((file) => readYaml(path.join(options.casesDir, file))));
        const target = await loadTargetPack(cases[0].targetId, { rootOverride: options.targetRoot });
        const profile = await profileTarget(target);
        return { target, profile, contract: profile.contract, cases };
    }
    if (!options.target) {
        throw new Error("--target, --case, or --cases-dir is required");
    }
    const target = await loadTargetPack(options.target, { rootOverride: options.targetRoot });
    const profile = await profileTarget(target);
    const suite = materializeSmokeSuite(profile.contract, { suite: options.suite });
    return { target, profile, contract: profile.contract, cases: suite.cases };
}
async function resolveDebugInputs(options) {
    if (options.case) {
        const testCase = await readYaml(options.case);
        const target = await loadTargetPack(testCase.targetId);
        const contract = (await profileTarget(target)).contract;
        return { target, contract, cases: [testCase] };
    }
    if (!options.target) {
        throw new Error("--target or --case is required");
    }
    const target = await loadTargetPack(options.target);
    const contract = (await profileTarget(target)).contract;
    const suite = materializeSmokeSuite(contract);
    return { target, contract, cases: suite.cases };
}
async function loadMutations(options) {
    if (options.mutation) {
        const mutationPath = await resolveExistingPath(options.mutation);
        return [normalizeMutationInput(await readYaml(mutationPath), mutationPath)];
    }
    if (options.mutationSet) {
        const mutationSetPath = await resolveExistingPath(options.mutationSet);
        const set = await readYaml(mutationSetPath);
        if (!Array.isArray(set.mutations) || set.mutations.length === 0) {
            throw new Error(`Mutation set ${mutationSetPath} must include at least one mutation.`);
        }
        const output = [];
        for (const mutationPath of set.mutations) {
            const resolvedMutationPath = await resolveExistingPath(mutationPath, path.dirname(mutationSetPath));
            output.push(normalizeMutationInput(await readYaml(resolvedMutationPath), resolvedMutationPath));
        }
        return output;
    }
    throw new Error("--mutation or --mutation-set is required");
}
function normalizeMutationInput(mutation, mutationPath) {
    if (!mutation.id || !mutation.type) {
        throw new Error(`Mutation ${mutationPath} must include id and type.`);
    }
    if (mutation.scope !== "overlay-only") {
        throw new Error(`Mutation ${mutation.id} must declare scope: overlay-only.`);
    }
    if (!mutation.expectedOutcome?.hardFailureCode) {
        throw new Error(`Mutation ${mutation.id} must declare expectedOutcome.hardFailureCode.`);
    }
    return {
        id: mutation.id,
        type: mutation.type,
        scope: "overlay-only",
        expectedVerdict: normalizeExpectedVerdict(mutation.expectedOutcome.verdict),
        expectedHardFailureCode: mutation.expectedOutcome.hardFailureCode
    };
}
function normalizeExpectedVerdict(value) {
    if (!value) {
        return undefined;
    }
    const normalized = value.trim().toUpperCase().replace(/-/gu, "_");
    if (normalized === "PASS" || normalized === "PASS_WITH_WARNINGS" || normalized === "FAIL" || normalized === "DIAGNOSTIC_ONLY") {
        return normalized;
    }
    throw new Error(`Invalid expected verdict: ${value}`);
}
function enforceGateMode(mode, suiteResult) {
    if (mode !== "gate") {
        return;
    }
    const failedCaseIds = suiteResult.caseResults.filter((result) => result.verdict === "FAIL").map((result) => result.caseId);
    if (suiteResult.releaseDecision !== "APPROVE" || failedCaseIds.length > 0) {
        throw new Error(`Gate mode blocked run: releaseDecision=${suiteResult.releaseDecision}${failedCaseIds.length > 0 ? ` failedCases=${failedCaseIds.join(",")}` : ""}`);
    }
}
async function resolveExistingPath(value, relativeTo) {
    const candidates = path.isAbsolute(value)
        ? [value]
        : [
            ...(relativeTo ? [path.resolve(relativeTo, value)] : []),
            path.resolve(process.cwd(), value),
            path.resolve(getBenchmarkRoot(), value)
        ];
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        }
        catch {
            // Try the next path candidate.
        }
    }
    return candidates[0];
}
function selectCaseForMutation(cases, mutation) {
    const templateByMutation = {
        "route-break": "forbidden-route",
        "owner-bypass": "required-owner",
        "gate-status-alias": "skip-not-pass",
        "artifact-path-drift": "static-contract",
        "join-callback-drop": "required-join",
        "side-effect-policy-weakening": "side-effect-deny",
        "telemetry-drop": "efficiency-token",
        "token-ledger-drop": "efficiency-token"
    };
    return cases.find((testCase) => testCase.templateId === templateByMutation[mutation.type]) ?? cases[0];
}
async function runLiveCase(testCase, contract, runnerCapability, runDir, options) {
    const optionsForRunner = {
        sandboxRoot: path.join(runDir, "live-sandbox", testCase.id),
        transcriptPath: path.join(runDir, "transcripts", `${testCase.id}.jsonl`),
        lastMessagePath: path.join(runDir, "last-messages", `${testCase.id}.json`),
        timeoutMs: options.timeoutMs,
        model: options.model
    };
    if (runnerCapability.name === "codex") {
        return runLiveCodexCase(testCase, contract, runnerCapability, optionsForRunner);
    }
    if (runnerCapability.name === "claude") {
        return runLiveClaudeCase(testCase, contract, runnerCapability, optionsForRunner);
    }
    throw new Error(`Live execution is currently implemented for codex and claude only, got ${runnerCapability.name}`);
}
async function writeReport(filePath, suiteResult) {
    await writeReportFile(filePath, renderMarkdownReport(suiteResult));
}
async function writeRecommendationArtifacts(runDir, suiteResult) {
    await writeJson(path.join(runDir, "recommendations.json"), suiteResult.recommendations);
    await writeReportFile(path.join(runDir, "recommendations.md"), [
        "# Agent Workflow Modification Recommendations",
        "",
        suiteResult.recommendations.length === 0
            ? "No agent workflow changes are recommended from this run."
            : suiteResult.recommendations
                .map((recommendation) => `- [${recommendation.priority}] ${recommendation.summary}\n  Category: ${recommendation.category}\n  Suggested change: ${recommendation.suggestedChange}\n  Evidence cases: ${recommendation.evidenceCaseIds.join(", ")}`)
                .join("\n")
    ].join("\n"));
}
async function writeP0CaseArtifacts(runDir, suiteResult, p0CaseLog) {
    await writeJson(path.join(runDir, "p0-cases.json"), suiteResult.p0CaseRecords);
    await writeReportFile(path.join(runDir, "p0-cases.md"), [
        "# P0 Case Records",
        "",
        suiteResult.p0CaseRecords.length === 0
            ? "No P0 cases were recorded."
            : suiteResult.p0CaseRecords
                .map((record) => `- ${record.caseId}: ${record.failureCode}\n  Why: ${record.why}\n  Recommended action: ${record.recommendedAction}`)
                .join("\n")
    ].join("\n"));
    if (p0CaseLog && suiteResult.p0CaseRecords.length > 0) {
        await ensureDir(path.dirname(p0CaseLog));
        await appendFile(p0CaseLog, suiteResult.p0CaseRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
}
async function writeReportFile(filePath, body) {
    await ensureDir(path.dirname(filePath));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, `${body.trimEnd()}\n`));
}
async function updateSuiteDebugHealth(suiteResultPath, results, debugRunDir) {
    const suiteResult = await readJson(suiteResultPath);
    const killed = results.filter((result) => result.mutationKilled).length;
    const falseNegativeCount = results.filter((result) => result.falseNegative).length;
    const falsePositiveCount = results.filter((result) => result.falsePositive).length;
    suiteResult.debugHealth = {
        status: falseNegativeCount === 0 && falsePositiveCount === 0 ? "PASS" : "FAIL",
        mutationKillRate: results.length === 0 ? 0 : killed / results.length,
        falseNegativeCount,
        falsePositiveCount,
        environmentReproducibility: 1,
        lastReverseValidationRunId: path.basename(debugRunDir),
        doesNotAffectTargetScore: true
    };
    await writeJson(suiteResultPath, suiteResult);
}
