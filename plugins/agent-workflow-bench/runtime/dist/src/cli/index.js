import { Command } from "commander";
import { Ajv2020 } from "ajv/dist/2020.js";
import { access, appendFile, copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { getBenchmarkRoot, listTargetIds, loadTargetPack } from "../core/targetRegistry.js";
import { profileTarget } from "../profiler/profileTarget.js";
import { inferTargetPackDraft } from "../profiler/targetPackInitializer.js";
import { materializeAiSuite, materializeSmokeSuite } from "../generator/materialize.js";
import { runAiCasePlanner } from "../generator/aiPlanner.js";
import { recommendedAiCaseCount, validateAiCasePlan } from "../generator/coverage.js";
import { runCase } from "../runner/simulatedRunner.js";
import { detectRunnerCapability, runnerCapabilityHash } from "../runner/runnerCapabilities.js";
import { runLiveClaudeCase, runLiveCodexCase } from "../runner/liveCodexRunner.js";
import { loadAdapterContract } from "../adapters/sdk.js";
import { createOpenCodeRunnerAdapter } from "../adapters/openCodeAdapter.js";
import { assertAdapterConformanceReportIntegrity, runRunnerAdapterConformance } from "../adapters/conformance.js";
import { scoreCase, scoreSuite } from "../scorer/score.js";
import { prepareDebugEnvironment, reverseValidate } from "../debug/debugWorkflow.js";
import { renderMarkdownReport } from "../report/report.js";
import { ensureDir, readJson, readYaml, writeJson, writeYaml } from "../utils/io.js";
import { AWB_VERSION, CLI_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "../core/product.js";
import { diagnoseWorkflow, renderDoctorReport } from "../doctor/doctor.js";
import { buildRunProvenance, publicRunnerCapability, semanticCaseSetHash } from "../regression/provenance.js";
import { verifyWorkflowTraceBundle, workflowTraceAttemptId } from "../observer/workflowTrace.js";
import { assertQualifiedWorkflowTraceEvidence, runReferenceObserverQualification, verifyObserverQualificationArtifact } from "../observer/qualification.js";
import { observeWithReferenceObserver } from "../observer/referenceObserver.js";
import { createComparisonBundle, renderComparisonReport, verifyComparisonBundle } from "../regression/compare.js";
import { evaluateGate, gateExitCode, renderGateReport } from "../regression/gate.js";
import { getEvaluationContract, getReliabilityPolicy } from "../evaluation/evaluationContract.js";
import { DEFAULT_GOLD_CORPUS_PATH, evaluateGoldCorpus, loadGoldCorpus, loadGoldCorpusPlannerView } from "../evaluation/goldCorpus.js";
import { profileEvidenceSensitiveValues, publicAiCasePlan, publicProfileEvidence } from "../utils/redaction.js";
import { renderReliabilityMarkdown } from "../reliability/reliability.js";
import { runReliabilityStudy } from "../reliability/study.js";
import { analyzeExternalValidity, analyzeExternalValidityFromComparisons, createExternalValidityLabelingPackage, renderExternalValidityMarkdown } from "../validity/externalValidity.js";
import { loadExternalValidityHumanLabels, loadExternalValidityObservations, loadExternalValidityStudy, validateExternalValidityPackage, validateExternalValidityReport } from "../validity/io.js";
import { assertCalibrationReportIntegrity, fitGatePolicy, loadCanonicalGatePolicy, loadGatePolicy, renderCalibrationMarkdown, validateGatePolicyHoldout } from "../calibration/gatePolicy.js";
import { artifactMigrationExitCode, migrateArtifact, writeArtifactMigration } from "../artifacts/migration.js";
import { assertArtifactRegistryComplete } from "../artifacts/registry.js";
import { buildProductionCanaryReport } from "../ci/canary.js";
import { assessProductionCiGate, finalizeProductionBlockingAuthorization, prepareProductionBlockingAuthorization, PRODUCTION_CANARY_POLICY, validateProductionIsolationManifest } from "../ci/productionGate.js";
import { buildDecisionReport, renderDecisionReportMarkdown } from "../report/decisionReport.js";
import { buildTraceDiff } from "../report/traceDiff.js";
import { buildTrendReport } from "../report/trends.js";
import { buildHtmlViewerArtifacts } from "../report/htmlViewer.js";
import { assertBenchmarkHealthReportIntegrity, benchmarkHealthExitCode, buildBenchmarkHealthReport } from "../ci/benchmarkHealth.js";
import { assertRunnerRankingReportIntegrity, buildRunnerRankingReport } from "../report/runnerRanking.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
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
    console.log("adapter configs valid");
});
const artifactCommands = program.command("artifact");
artifactCommands
    .command("migrate")
    .description("Migrate a compatible 0.1.x artifact or emit a fail-closed compatibility result")
    .requiredOption("--input <path>", "JSON artifact to inspect and migrate")
    .option("--artifact-type <type>", "registered artifact type when filename/discriminator inference is unavailable")
    .requiredOption("--out <dir>", "migration output directory")
    .action(async (options) => {
    const migration = await migrateArtifact(await resolveExistingPath(options.input), {
        artifactType: options.artifactType
    });
    await writeArtifactMigration(options.out, migration);
    console.log(`artifact migration ${migration.result.status}: ${options.out}`);
    process.exitCode = artifactMigrationExitCode(migration.result);
});
const adapterCommands = program
    .command("adapter")
    .description("Validate evidence-bounded Runner and Observer Adapter contracts");
adapterCommands
    .command("conformance")
    .description("Run the built-in Adapter conformance suite; conformance is diagnostic and never workflow PASS evidence")
    .requiredOption("--adapter <id>", "built-in Adapter id (opencode)")
    .requiredOption("--target <id>", "owner-reviewed target used by the fixture case")
    .requiredOption("--adapter-executable <path>", "executable implementing the Adapter CLI contract")
    .option("--model <model>", "optional provider/model for OpenCode")
    .option("--timeout-ms <ms>", "Adapter execution timeout", "10000")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    if (options.adapter !== "opencode") {
        throw new Error(`Unsupported built-in Adapter: ${options.adapter}.`);
    }
    const profile = await profileTarget(await loadTargetPack(options.target));
    const testCase = materializeSmokeSuite(profile.contract).cases[0];
    if (!testCase) {
        throw new Error(`Target ${options.target} did not materialize a conformance case.`);
    }
    const adapterContract = await loadAdapterContract(path.join(getBenchmarkRoot(), "configs/adapters/opencode.json"));
    const executable = await resolveExistingPath(options.adapterExecutable);
    const capability = opencodeConformanceCapability(executable, adapterContract);
    const adapter = createOpenCodeRunnerAdapter(adapterContract, {
        executable
    });
    const outputDir = path.resolve(options.out);
    const report = await runRunnerAdapterConformance({
        adapter,
        context: {
            testCase,
            contract: profile.contract,
            capability,
            sandboxRoot: path.join(outputDir, "sandbox"),
            transcriptPath: path.join(outputDir, "transcripts", `${testCase.id}.jsonl`),
            lastMessagePath: path.join(outputDir, "last-messages", `${testCase.id}.json`),
            timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms"),
            model: options.model
        }
    });
    assertAdapterConformanceReportIntegrity(report);
    await assertJsonSchema(report, "adapter-conformance-report.schema.json", "Adapter conformance report");
    await writeJson(path.join(outputDir, "adapter-conformance-report.json"), report);
    console.log(`Adapter conformance ${report.decision}: ${outputDir}`);
    if (report.decision !== "PASS") {
        process.exitCode = 1;
    }
});
const observer = program.command("observer");
observer
    .command("observe")
    .description("Run the reference Observer around a child Runner and emit an Ed25519-signed workflow trace")
    .requiredOption("--request <path>", "reference Observer request JSON")
    .requiredOption("--observer-private-key <path>", "Ed25519 signing key kept outside the Runner environment")
    .requiredOption("--out <path>", "workflow-trace.json output path")
    .action(async (options) => {
    const request = await readJson(await resolveExistingPath(options.request));
    await observeWithReferenceObserver({
        request,
        privateKeyPath: await resolveExistingPath(options.observerPrivateKey),
        outputPath: path.resolve(options.out)
    });
    console.log(`reference Observer trace written: ${options.out}`);
});
observer
    .command("qualify")
    .description("Qualify the reference Observer without modifying any public-key trust root")
    .requiredOption("--target <id>")
    .option("--target-root <path>", "override the registered target root for this isolated checkout")
    .option("--suite <name>", "suite name", "smoke")
    .requiredOption("--observer-id <id>")
    .requiredOption("--observer-version <version>")
    .requiredOption("--observer-private-key <path>")
    .requiredOption("--qualification-authority-private-key <path>")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const { contract, cases } = await resolveRunInputs(options);
    const result = await runReferenceObserverQualification({
        contract,
        cases,
        observerId: options.observerId,
        observerVersion: options.observerVersion,
        observerPrivateKeyPath: await resolveExistingPath(options.observerPrivateKey),
        qualificationAuthorityPrivateKeyPath: await resolveExistingPath(options.qualificationAuthorityPrivateKey),
        outputDir: path.resolve(options.out)
    });
    console.log(`Observer qualification ${result.report.decision}: ${options.out}`);
    if (result.report.decision !== "valid") {
        process.exitCode = 1;
    }
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
    .option("--gold-corpus <path>", "optional versioned corpus; only its unlabeled development split enters planner context")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const profile = await profileTarget(await loadTargetPack(options.target, { rootOverride: options.targetRoot }));
    const coverageMode = normalizeCoverageMode(options.coverageMode);
    const maxCases = options.maxCases
        ? parsePositiveInt(options.maxCases, "--max-cases")
        : recommendedAiCaseCount(profile.contract, { coverageMode });
    const goldCorpusView = options.goldCorpus
        ? await loadGoldCorpusPlannerView(await resolveExistingPath(options.goldCorpus))
        : undefined;
    if (goldCorpusView && goldCorpusView.targetId !== profile.contract.targetId) {
        throw new Error(`Gold Corpus target ${goldCorpusView.targetId} does not match planner target ${profile.contract.targetId}.`);
    }
    const run = await runAiCasePlanner(profile.contract, {
        runner: normalizeAiPlannerRunner(options.runner),
        model: options.liveModel,
        coverageMode,
        timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms"),
        maxCases,
        outDir: options.out,
        evidence: profile.evidence,
        goldCorpusView
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
    .option("--seed <seed>", "recorded deterministic study seed", getReliabilityPolicy().defaultSeed)
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
            seed: options.seed,
            sensitiveValues
        })
        : materializeSmokeSuite(profile.contract, {
            suite: options.suite,
            seed: options.seed
        });
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
    .option("--seed <seed>", "recorded execution and reliability-study seed", getReliabilityPolicy().defaultSeed)
    .option("--timeout-ms <ms>", "live runner timeout in milliseconds", "120000")
    .option("--mode <mode>", "gate or diagnostic", "diagnostic")
    .option("--mutation <path>", "simulated mutation overlay to inject into each case")
    .option("--p0-case-log <path>", "append P0 case records to a local JSONL file")
    .option("--out <dir>", "output dir")
    .option("--dry-run", "prepare without external runner", false)
    .action(async (options) => {
    const runDir = options.out ?? path.join("reports/runs", `run-${Date.now()}`);
    const attemptId = `attempt-${randomUUID()}`;
    const mode = normalizeRunMode(options.mode);
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
            schemaVersion: "0.1.0",
            artifactType: "runtime_manifest",
            attemptId,
            runner: {
                ...publicRunnerCapability(runnerCapability),
                executionMode
            },
            mode,
            dryRun: true,
            seed: options.seed,
            contractHash: contract.contractHash,
            caseCount: 0,
            skippedCaseCount: cases.length,
            caseSource: options.casesDir ? "cases://provided" : "target://materialized",
            mutation
        });
        await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
            attemptId,
            profile,
            cases,
            suite: options.suite,
            runner: runnerCapability,
            executionMode,
            seed: options.seed,
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
        enforceGateMode(mode, suiteResult);
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
        schemaVersion: "0.1.0",
        artifactType: "runtime_manifest",
        attemptId,
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode
        },
        mode,
        dryRun: options.dryRun,
        seed: options.seed,
        contractHash: contract.contractHash,
        caseCount: cases.length,
        liveTranscriptCount,
        caseSource: options.casesDir ? "cases://provided" : "target://materialized",
        mutation
    });
    await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
        attemptId,
        profile,
        cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode,
        seed: options.seed,
        model: options.liveModel,
        mutation,
        artifacts: [
            { ref: "suite-result.json", path: path.join(runDir, "suite-result.json") },
            { ref: "runtime-manifest.json", path: runtimeManifestPath }
        ],
        targetRoot: target.root
    }));
    console.log(`run written: ${runDir}`);
    enforceGateMode(mode, suiteResult);
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
    .option("--observer-qualification <path>", "authority-signed Observer qualification artifact")
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification authority public key")
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
    const attemptId = workflowTraceAttemptId(verifiedTrace.traceHash);
    const verifiedQualification = await resolveObserverQualification(options, verifiedTrace, contract.contractHash, semanticCaseSetHash(cases));
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
        observerQualification: verifiedQualification ? "valid" : "missing"
    });
    await writeJson(path.join(options.out, "suite-result.json"), suiteResult);
    await writeRecommendationArtifacts(options.out, suiteResult);
    await writeP0CaseArtifacts(options.out, suiteResult);
    await writeReport(path.join(options.out, "report.md"), suiteResult);
    const traceArtifactPath = path.join(options.out, "workflow-trace.json");
    await copyFile(tracePath, traceArtifactPath);
    const qualificationArtifactPath = verifiedQualification
        ? path.join(options.out, "observer-qualification.json")
        : undefined;
    if (verifiedQualification && qualificationArtifactPath) {
        await copyFile(await resolveExistingPath(options.observerQualification), qualificationArtifactPath);
    }
    const runtimeManifestPath = path.join(options.out, "runtime-manifest.json");
    await writeJson(runtimeManifestPath, {
        schemaVersion: "0.1.0",
        artifactType: "runtime_manifest",
        attemptId,
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode: "live"
        },
        mode: "diagnostic",
        dryRun: false,
        seed: verifiedTrace.bundle.subject.seed,
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
                qualificationStatus: verifiedQualification ? "valid" : "missing",
                ...(verifiedQualification
                    ? {
                        qualificationRef: "observer-qualification.json",
                        qualificationArtifactHash: verifiedQualification.artifactHash,
                        qualificationAuthorityFingerprint: verifiedQualification.authorityFingerprint
                    }
                    : {})
            }
        }
    });
    await writeJson(path.join(options.out, "provenance.json"), await buildRunProvenance({
        attemptId,
        profile,
        cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode: "live",
        verifiedTrace,
        verifiedQualification,
        artifacts: [
            { ref: "suite-result.json", path: path.join(options.out, "suite-result.json") },
            { ref: "runtime-manifest.json", path: runtimeManifestPath },
            { ref: "workflow-trace.json", path: traceArtifactPath },
            ...(qualificationArtifactPath
                ? [
                    {
                        ref: "observer-qualification.json",
                        path: qualificationArtifactPath
                    }
                ]
                : [])
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
    .option("--seed <seed>", "recorded execution and reliability-study seed", getReliabilityPolicy().defaultSeed)
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
    const attemptId = `attempt-${randomUUID()}`;
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
        seed: options.seed,
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
        schemaVersion: "0.1.0",
        artifactType: "runtime_manifest",
        attemptId,
        runner: {
            ...publicRunnerCapability(runnerCapability),
            executionMode
        },
        mode: "diagnostic",
        dryRun: false,
        seed: options.seed,
        contractHash: profile.contract.contractHash,
        caseCount: suite.cases.length,
        liveTranscriptCount,
        caseSource: "evaluation://cases",
        mutation
    });
    await writeReport(path.join(runDir, "report.md"), suiteResult);
    await writeJson(path.join(runDir, "provenance.json"), await buildRunProvenance({
        attemptId,
        profile,
        cases: suite.cases,
        suite: options.suite,
        runner: runnerCapability,
        executionMode,
        seed: options.seed,
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
        seed: options.seed,
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
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification authority public key")
    .option("--gate-policy <path>", "gate-policy.json used to recompute the comparison; mismatched run policies remain incomparable")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const policy = options.gatePolicy
        ? loadGatePolicy(await resolveExistingPath(options.gatePolicy))
        : loadCanonicalGatePolicy();
    const result = await createComparisonBundle(options.baseline, options.candidate, options.out, {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined,
        trustedQualificationKeyPath: options.trustedQualificationKey
            ? await resolveExistingPath(options.trustedQualificationKey)
            : undefined,
        gatePolicy: policy
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
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification authority public key")
    .option("--gate-policy <path>", "gate-policy.json used to revalidate and gate this comparison")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const comparison = await readJson(options.comparison);
    const policy = options.gatePolicy
        ? loadGatePolicy(await resolveExistingPath(options.gatePolicy))
        : loadCanonicalGatePolicy();
    const verification = await verifyComparisonBundle(options.comparison, comparison, {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined,
        trustedQualificationKeyPath: options.trustedQualificationKey
            ? await resolveExistingPath(options.trustedQualificationKey)
            : undefined,
        gatePolicy: policy
    });
    const result = evaluateGate(comparison, verification, policy, options.gatePolicy
        ? `${policy.policyId}@${policy.policyVersion}#${policy.policyHash}`
        : "configs/evaluation/gate-policy.json");
    await writeJson(path.join(options.out, "gate-result.json"), result);
    await writeReportFile(path.join(options.out, "gate-report.md"), renderGateReport(result));
    console.log(`gate written: ${options.out}`);
    process.exitCode = gateExitCode(result.decision);
});
const ci = program.command("ci").description("Evaluate production CI readiness artifacts");
ci
    .command("evaluate-canary")
    .description("Evaluate observe-only canary samples against frozen production thresholds")
    .requiredOption("--samples <path>", "JSON array or { samples } of observe-only canary samples")
    .requiredOption("--isolation-manifest <path>", "production-isolation-manifest.json")
    .requiredOption("--gate-policy <path>", "gate-policy.json used by the observed gate")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const samplesInput = await readJson(await resolveExistingPath(options.samples));
    const samples = normalizeProductionCanarySamples(samplesInput);
    const isolationManifest = await readJsonWithSchema(await resolveExistingPath(options.isolationManifest), "production-isolation-manifest.schema.json", "Production isolation manifest");
    const gatePolicyPath = await resolveExistingPath(options.gatePolicy);
    await readJsonWithSchema(gatePolicyPath, "gate-policy.schema.json", "Gate policy");
    const gatePolicy = loadGatePolicy(gatePolicyPath);
    const isolationValidation = validateProductionIsolationManifest(isolationManifest);
    if (isolationValidation.status === "BLOCK") {
        throw new Error(isolationValidation.reasons[0]);
    }
    const report = buildProductionCanaryReport({
        samples,
        isolationManifestHash: stableArtifactHash(isolationManifest),
        gatePolicyHash: gatePolicy.policyHash
    });
    await assertJsonSchema(report, "production-canary-report.schema.json", "Production canary report");
    await writeJson(path.join(options.out, "production-canary-report.json"), report);
    console.log(`production canary ${report.status}: ${options.out}`);
    process.exitCode = productionCanaryExitCode(report.status);
});
ci
    .command("assess")
    .description("Assess whether qualified evidence may enable production blocking")
    .requiredOption("--gate-result <path>", "gate-result.json")
    .requiredOption("--runtime-manifest <path>", "runtime-manifest.json")
    .requiredOption("--provenance <path>", "provenance.json")
    .requiredOption("--isolation-manifest <path>", "production-isolation-manifest.json")
    .requiredOption("--canary-report <path>", "production-canary-report.json")
    .option("--authorization <path>", "signed production-blocking-authorization.json")
    .option("--trusted-authorization-key <path>", "trusted Ed25519 authorization public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    if (Boolean(options.authorization) !==
        Boolean(options.trustedAuthorizationKey)) {
        throw new Error("--authorization and --trusted-authorization-key must be provided together.");
    }
    const gate = await readJsonWithSchema(await resolveExistingPath(options.gateResult), "gate-result.schema.json", "Gate result");
    const runtimeManifest = await readJsonWithSchema(await resolveExistingPath(options.runtimeManifest), "runtime-manifest.schema.json", "Runtime manifest");
    const provenance = await readJsonWithSchema(await resolveExistingPath(options.provenance), "provenance.schema.json", "Provenance");
    const isolationManifest = await readJsonWithSchema(await resolveExistingPath(options.isolationManifest), "production-isolation-manifest.schema.json", "Production isolation manifest");
    const canary = await readJsonWithSchema(await resolveExistingPath(options.canaryReport), "production-canary-report.schema.json", "Production canary report");
    const authorization = options.authorization
        ? await readJsonWithSchema(await resolveExistingPath(options.authorization), "production-blocking-authorization.schema.json", "Production blocking authorization")
        : undefined;
    const trustedAuthorizationKey = options.trustedAuthorizationKey
        ? await readFile(await resolveExistingPath(options.trustedAuthorizationKey))
        : undefined;
    const result = assessProductionCiGate({
        gate,
        runtimeManifest,
        provenance,
        isolationManifest,
        canary,
        authorization,
        trustedAuthorizationKey
    });
    await assertJsonSchema(result, "production-ci-gate-result.schema.json", "Production CI gate result");
    await writeJson(path.join(options.out, "production-ci-gate-result.json"), result);
    console.log(`production CI assessment ${result.decision}: ${options.out}`);
    process.exitCode = productionCiGateExitCode(result);
});
ci
    .command("prepare-authorization")
    .description("Prepare an integrity-bound payload for external human authorization signing")
    .requiredOption("--gate-result <path>", "gate-result.json")
    .requiredOption("--runtime-manifest <path>", "runtime-manifest.json")
    .requiredOption("--provenance <path>", "provenance.json")
    .requiredOption("--isolation-manifest <path>", "production-isolation-manifest.json")
    .requiredOption("--canary-report <path>", "production-canary-report.json")
    .requiredOption("--authorized-by <authority>", "external authority identifier such as authority://workflow-owner")
    .requiredOption("--expires-at <timestamp>", "authorization expiry as an ISO-8601 UTC timestamp")
    .requiredOption("--authority-public-key <path>", "external Ed25519 authorization public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const gate = await readJsonWithSchema(await resolveExistingPath(options.gateResult), "gate-result.schema.json", "Gate result");
    const runtimeManifest = await readJsonWithSchema(await resolveExistingPath(options.runtimeManifest), "runtime-manifest.schema.json", "Runtime manifest");
    const provenance = await readJsonWithSchema(await resolveExistingPath(options.provenance), "provenance.schema.json", "Provenance");
    const isolationManifest = await readJsonWithSchema(await resolveExistingPath(options.isolationManifest), "production-isolation-manifest.schema.json", "Production isolation manifest");
    const canary = await readJsonWithSchema(await resolveExistingPath(options.canaryReport), "production-canary-report.schema.json", "Production canary report");
    const authorityPublicKey = await readFile(await resolveExistingPath(options.authorityPublicKey));
    const request = prepareProductionBlockingAuthorization({
        gate,
        runtimeManifest,
        provenance,
        isolationManifest,
        canary,
        authorizedBy: options.authorizedBy,
        authorizedAt: new Date().toISOString(),
        expiresAt: options.expiresAt,
        authorityPublicKey
    });
    await assertJsonSchema(request, "production-blocking-authorization-request.schema.json", "Production blocking authorization request");
    await ensureDir(options.out);
    await Promise.all([
        writeJson(path.join(options.out, "production-blocking-authorization-request.json"), request),
        writeFile(path.join(options.out, "production-blocking-authorization.signing-payload.txt"), stableJson(request.unsignedAuthorization))
    ]);
    console.log(`production authorization awaiting external signature: ${options.out}`);
});
ci
    .command("finalize-authorization")
    .description("Attach and verify an externally produced Ed25519 authorization signature")
    .requiredOption("--request <path>", "production-blocking-authorization-request.json")
    .requiredOption("--signature <path>", "file containing the external base64 signature")
    .requiredOption("--trusted-authorization-key <path>", "trusted external Ed25519 authorization public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const request = await readJsonWithSchema(await resolveExistingPath(options.request), "production-blocking-authorization-request.schema.json", "Production blocking authorization request");
    const signature = (await readFile(await resolveExistingPath(options.signature), "utf8")).trim();
    const trustedAuthorizationKey = await readFile(await resolveExistingPath(options.trustedAuthorizationKey));
    const authorization = finalizeProductionBlockingAuthorization(request, signature, trustedAuthorizationKey);
    await assertJsonSchema(authorization, "production-blocking-authorization.schema.json", "Production blocking authorization");
    await writeJson(path.join(options.out, "production-blocking-authorization.json"), authorization);
    console.log(`production authorization signature verified: ${options.out}`);
});
ci
    .command("benchmark-health")
    .description("Aggregate periodic Gold, P0, Observer, A/A, schema, plugin, and privacy checks into a fail-closed version disposition")
    .requiredOption("--input <path>", "benchmark-health-input.json")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const input = await readJsonWithSchema(await resolveExistingPath(options.input), "benchmark-health-input.schema.json", "Benchmark health input");
    const report = buildBenchmarkHealthReport(input);
    assertBenchmarkHealthReportIntegrity(report);
    await assertJsonSchema(report, "benchmark-health-report.schema.json", "Benchmark health report");
    await writeJson(path.join(options.out, "benchmark-health-report.json"), report);
    console.log(`benchmark health ${report.status}; version ${report.versionDisposition}: ${options.out}`);
    process.exitCode = benchmarkHealthExitCode(report);
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
const reportCommands = program
    .command("report")
    .description("Render legacy run reports or evidence-bound decision, trace, trend, and viewer artifacts")
    .option("--run <dir>", "legacy suite-result run directory")
    .option("--format <format>", "md,json", "md,json")
    .action(async (options) => {
    if (!options.run) {
        throw new Error("--run is required when report is used without a Stage 9 subcommand.");
    }
    const suiteResult = await readJson(path.join(options.run, "suite-result.json"));
    if (options.format.includes("md")) {
        await writeReport(path.join(options.run, "report.md"), suiteResult);
    }
    if (options.format.includes("json")) {
        await writeJson(path.join(options.run, "suite-result.json"), suiteResult);
    }
    console.log(`report written: ${options.run}`);
});
reportCommands
    .command("runner-ranking")
    .description("Rank runners only when task, cases, qualified Observer, budget, Telemetry, and all score axes are comparable")
    .requiredOption("--input <path>", "runner-ranking-input.json")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const input = await readJsonWithSchema(await resolveExistingPath(options.input), "runner-ranking-input.schema.json", "Runner ranking input");
    const report = buildRunnerRankingReport(input);
    assertRunnerRankingReportIntegrity(report);
    await assertJsonSchema(report, "runner-ranking-report.schema.json", "Runner ranking report");
    await writeJson(path.join(options.out, "runner-ranking-report.json"), report);
    console.log(`runner ranking ${report.status}: ${options.out}`);
});
reportCommands
    .command("decision")
    .description("Build a maintainer decision report from a revalidated comparison and matching gate result")
    .requiredOption("--comparison <path>", "comparison-result.json")
    .requiredOption("--gate-result <path>", "gate-result.json")
    .option("--reliability <path>", "optional reliability-report.json; statistics are omitted when absent")
    .option("--validity <path>", "optional validity-report.json; human truth is never inferred when absent")
    .option("--trusted-observer-key <path>", "trusted Ed25519 Observer public key for comparison revalidation")
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification-authority public key")
    .option("--gate-policy <path>", "gate-policy.json used to revalidate the comparison and gate result")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const comparisonPath = await resolveExistingPath(options.comparison);
    const comparison = await readJsonWithSchema(comparisonPath, "comparison-result.schema.json", "Comparison result");
    const policy = options.gatePolicy
        ? loadGatePolicy(await resolveExistingPath(options.gatePolicy))
        : loadCanonicalGatePolicy();
    const verification = await verifyComparisonBundle(comparisonPath, comparison, {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined,
        trustedQualificationKeyPath: options.trustedQualificationKey
            ? await resolveExistingPath(options.trustedQualificationKey)
            : undefined,
        gatePolicy: policy
    });
    const expectedGate = evaluateGate(comparison, verification, policy, options.gatePolicy
        ? `${policy.policyId}@${policy.policyVersion}#${policy.policyHash}`
        : "configs/evaluation/gate-policy.json");
    const gateResultPath = await resolveExistingPath(options.gateResult);
    const suppliedGate = await readJsonWithSchema(gateResultPath, "gate-result.schema.json", "Gate result");
    if (stableJson(suppliedGate) !== stableJson(expectedGate)) {
        throw new Error("Gate result does not match a fresh evaluation of the verified comparison and selected policy.");
    }
    const reliabilityPath = options.reliability
        ? await resolveExistingPath(options.reliability)
        : undefined;
    const reliability = reliabilityPath
        ? await readJsonWithSchema(reliabilityPath, "reliability-report.schema.json", "Reliability report")
        : undefined;
    const validityPath = options.validity
        ? await resolveExistingPath(options.validity)
        : undefined;
    const validity = validityPath
        ? await readJsonWithSchema(validityPath, "validity-report.schema.json", "Validity report")
        : undefined;
    const candidateSuite = verification.status === "VALID"
        ? await readJsonWithSchema(path.join(path.dirname(comparisonPath), "evidence", "candidate", "suite-result.json"), "suite-result.schema.json", "Candidate suite result")
        : undefined;
    const report = buildDecisionReport({
        comparison,
        gate: expectedGate,
        reliability,
        validity,
        sourceFileHashes: {
            comparison: await hashFile(comparisonPath),
            gate: await hashFile(gateResultPath),
            ...(reliabilityPath
                ? { reliability: await hashFile(reliabilityPath) }
                : {}),
            ...(validityPath ? { validity: await hashFile(validityPath) } : {})
        },
        ...(candidateSuite
            ? {
                caseEvidence: candidateSuite.caseResults.flatMap((caseResult) => caseResult.hardFailures.map((failure) => ({
                    caseId: caseResult.caseId,
                    failureCode: failure.code,
                    evidenceEventIds: failure.evidenceEventIds
                })))
            }
            : {})
    });
    await assertJsonSchema(report, "decision-report.schema.json", "Decision report");
    await writeJson(path.join(options.out, "decision-report.json"), report);
    await writeReportFile(path.join(options.out, "decision-report.md"), renderDecisionReportMarkdown(report));
    console.log(`decision report written: ${options.out}`);
});
reportCommands
    .command("trace-diff")
    .description("Diff redacted workflow traces; only independently qualified signed traces are marked verified_live")
    .requiredOption("--mode <mode>", "baseline-candidate or baseline-mutant-restore")
    .requiredOption("--baseline <path>", "baseline workflow-trace.json")
    .option("--candidate <path>", "candidate workflow-trace.json")
    .option("--mutant <path>", "mutant workflow-trace.json")
    .option("--restore <path>", "restored workflow-trace.json")
    .option("--trusted-observer-key <path>", "trusted Ed25519 Observer public key")
    .option("--observer-qualification <path>", "Observer qualification artifact; requires both trusted keys")
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification-authority public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const mode = normalizeTraceDiffMode(options.mode);
    assertTraceDiffModeInputs(mode, options);
    assertTraceDiffTrustInputs(options);
    const roles = mode === "baseline_candidate"
        ? [
            ["baseline", options.baseline],
            ["candidate", options.candidate]
        ]
        : [
            ["baseline", options.baseline],
            ["mutant", options.mutant],
            ["restore", options.restore]
        ];
    const loaded = [];
    for (const [role, tracePath] of roles) {
        loaded.push(await loadTraceForDiff(role, tracePath, {
            trustedObserverKey: options.trustedObserverKey,
            observerQualification: options.observerQualification,
            trustedQualificationKey: options.trustedQualificationKey
        }));
    }
    const baseline = loaded[0];
    const comparability = traceComparability(loaded.map((item) => item.bundle));
    const byRole = new Map(loaded.map((item) => [item.role, item.trace]));
    const report = buildTraceDiff({
        mode,
        targetId: baseline.bundle.subject.targetId,
        suite: baseline.bundle.subject.suite,
        comparability,
        evidenceLevel: loaded.every((item) => item.qualified)
            ? "verified_live"
            : "diagnostic_simulated",
        ...(loaded.every((item) => item.qualified)
            ? {
                verification: {
                    status: "QUALIFIED_SIGNED_TRACES",
                    sourceTraceHashes: loaded.map((item) => item.trace.traceHash),
                    observerKeyFingerprints: [
                        ...new Set(loaded.map((item) => item.observerKeyFingerprint))
                    ],
                    qualificationArtifacts: [
                        ...new Map(loaded.map((item) => [
                            item.qualificationArtifactHash,
                            {
                                ref: "observer:observer-qualification.json",
                                sha256: item.qualificationArtifactHash
                            }
                        ])).values()
                    ]
                }
            }
            : {}),
        baseline: byRole.get("baseline"),
        candidate: byRole.get("candidate"),
        mutant: byRole.get("mutant"),
        restore: byRole.get("restore")
    });
    await assertJsonSchema(report, "trace-diff.schema.json", "Trace diff");
    await writeJson(path.join(options.out, "trace-diff.json"), report);
    console.log(`trace diff written: ${options.out}`);
});
reportCommands
    .command("trend")
    .description("Build a bounded trend report that never connects incompatible historical points")
    .requiredOption("--input <path>", "JSON object containing seriesId and ordered points")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const input = await readJson(await resolveExistingPath(options.input));
    const report = buildTrendReport(input);
    await assertJsonSchema(report, "trend-report.schema.json", "Trend report");
    await writeJson(path.join(options.out, "trend-report.json"), report);
    console.log(`trend report written: ${options.out}`);
});
reportCommands
    .command("viewer")
    .description("Render a static read-only HTML viewer from already-redacted public artifacts")
    .option("--decision <path>", "decision-report.json")
    .option("--comparison <path>", "comparison-result.json")
    .option("--trace-diff <path>", "trace-diff.json")
    .option("--trend <path>", "trend-report.json")
    .option("--title <title>", "viewer title", "Agent Workflow Bench Report")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const { input, manifestInputs } = await loadHtmlViewerInputs(options);
    const artifacts = buildHtmlViewerArtifacts({ title: options.title, ...input }, {
        viewerRef: "viewer.html",
        inputs: manifestInputs
    });
    await assertJsonSchema(artifacts.manifest, "html-viewer-manifest.schema.json", "HTML viewer manifest");
    await ensureDir(options.out);
    const viewerPath = path.join(options.out, "viewer.html");
    await writeFile(viewerPath, artifacts.html);
    if ((await hashFile(viewerPath)) !==
        artifacts.manifest.integrity.viewerHash) {
        throw new Error("HTML viewer file hash does not match its manifest.");
    }
    await writeJson(path.join(options.out, "html-viewer-manifest.json"), artifacts.manifest);
    console.log(`read-only HTML viewer written: ${options.out}`);
});
const debug = program.command("debug");
debug
    .command("reliability")
    .description("Analyze repeated matched runs for diagnostic reliability and quarantine risk")
    .requiredOption("--study <path>", "reliability-study.json")
    .option("--trusted-observer-key <path>", "trusted Ed25519 observer public key for workflow_trace evidence")
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification authority public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const report = await runReliabilityStudy(await resolveExistingPath(options.study), {
        trustedObserverKeyPath: options.trustedObserverKey
            ? await resolveExistingPath(options.trustedObserverKey)
            : undefined,
        trustedQualificationKeyPath: options.trustedQualificationKey
            ? await resolveExistingPath(options.trustedQualificationKey)
            : undefined
    });
    await writeJson(path.join(options.out, "reliability-report.json"), report);
    await writeReportFile(path.join(options.out, "reliability-report.md"), renderReliabilityMarkdown(report));
    console.log(`reliability report written: ${options.out}`);
    process.exitCode = reliabilityExitCode(report);
});
const criterionValidity = program.command("criterion-validity");
criterionValidity
    .command("package")
    .description("Create a blinded public-safe package for independent human labeling")
    .requiredOption("--study <path>", "external-validity study YAML or JSON")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const study = await loadExternalValidityStudy(await resolveExistingPath(options.study));
    const artifacts = createExternalValidityLabelingPackage(study);
    await validateExternalValidityPackage(artifacts);
    await writeExternalValidityLabelingArtifacts(options.out, artifacts);
    console.log(`external validity labeling package written: ${options.out}`);
});
criterionValidity
    .command("analyze")
    .description("Compare qualified AWB observations with blinded independent human labels")
    .requiredOption("--study <path>", "external-validity study YAML or JSON")
    .option("--observations <path>", "completed AWB observations JSON or YAML")
    .option("--labels <path>", "completed blinded human labels and adjudications")
    .option("--trusted-observer-key <path>", "trusted Ed25519 Observer public key for comparison revalidation")
    .option("--trusted-qualification-key <path>", "trusted Ed25519 qualification-authority public key")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const study = await loadExternalValidityStudy(await resolveExistingPath(options.study));
    const observations = options.observations
        ? await loadExternalValidityObservations(await resolveExistingPath(options.observations))
        : undefined;
    const labels = options.labels
        ? await loadExternalValidityHumanLabels(await resolveExistingPath(options.labels))
        : undefined;
    const artifacts = createExternalValidityLabelingPackage(study);
    const report = observations
        ? await analyzeExternalValidityFromComparisons(study, observations, labels, {
            trustedObserverKeyPath: options.trustedObserverKey
                ? await resolveExistingPath(options.trustedObserverKey)
                : undefined,
            trustedQualificationKeyPath: options.trustedQualificationKey
                ? await resolveExistingPath(options.trustedQualificationKey)
                : undefined
        })
        : analyzeExternalValidity(study, undefined, labels);
    await Promise.all([
        validateExternalValidityPackage(artifacts),
        validateExternalValidityReport(report)
    ]);
    await writeExternalValidityLabelingArtifacts(options.out, artifacts);
    await writeJson(path.join(options.out, "validity-report.json"), report);
    await writeReportFile(path.join(options.out, "validity-report.md"), renderExternalValidityMarkdown(report));
    console.log(`external criterion validity report written: ${options.out}`);
    process.exitCode = externalValidityExitCode(report);
});
const goldCorpus = program.command("gold-corpus");
goldCorpus
    .command("validate")
    .requiredOption("--corpus <path>")
    .option("--out <dir>", "optional Gold Corpus report output directory")
    .action(async (options) => {
    const corpusPath = await resolveExistingPath(options.corpus);
    const corpus = await loadGoldCorpus(corpusPath);
    const target = await loadTargetPack(corpus.manifest.targetId);
    const contract = (await profileTarget(target)).contract;
    const suite = materializeSmokeSuite(contract);
    const report = evaluateGoldCorpus(corpus, contract, suite.cases);
    await assertJsonSchema(report, "gold-corpus-report.schema.json", "Gold Corpus report");
    if (options.out) {
        await writeJson(path.join(options.out, "gold-corpus-report.json"), report);
    }
    if (report.status !== "PASS") {
        throw new Error(`Gold Corpus validation failed with ${report.blindSpots.length} blind spot(s).`);
    }
    console.log(`gold corpus valid: corpusVersion=${corpus.manifest.corpusVersion} ${corpus.cases.length} trajectories`);
});
const gatePolicyCommands = program
    .command("gate-policy")
    .description("Calibrate a versioned evidence-first gate policy without using holdout labels during fit");
gatePolicyCommands
    .command("calibrate")
    .description("Fit policy candidates from development/calibration data and emit a pending holdout report")
    .requiredOption("--corpus <path>", "versioned Gold Corpus manifest")
    .requiredOption("--policy-version <semver>", "semantic gate-policy version")
    .option("--previous-policy <path>", "previous gate-policy.json; defaults to the canonical policy and enforces rule-version changes")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const inputs = await resolveCalibrationInputs(options.corpus);
    const previousPolicy = options.previousPolicy
        ? loadGatePolicy(await resolveExistingPath(options.previousPolicy))
        : loadCanonicalGatePolicy();
    const fitted = await fitGatePolicy({
        ...inputs,
        policyVersion: options.policyVersion,
        previousPolicy
    });
    await Promise.all([
        validateArtifactAgainstSchema("gate-policy.schema.json", fitted.policy),
        validateArtifactAgainstSchema("calibration-report.schema.json", fitted.report)
    ]);
    await Promise.all([
        writeJson(path.join(options.out, "gate-policy.json"), fitted.policy),
        writeJson(path.join(options.out, "calibration-report.json"), fitted.report),
        writeReportFile(path.join(options.out, "calibration-report.md"), renderCalibrationMarkdown(fitted.report))
    ]);
    console.log(`gate policy calibrated; holdout remains unopened: ${options.out}`);
    process.exitCode = calibrationExitCode(fitted.report);
});
gatePolicyCommands
    .command("validate-holdout")
    .description("Validate an immutable fitted policy on the separately loaded unseen holdout split")
    .requiredOption("--corpus <path>", "same versioned Gold Corpus manifest used during fit")
    .requiredOption("--policy <path>", "frozen gate-policy.json")
    .requiredOption("--calibration-report <path>", "untampered PENDING_HOLDOUT calibration-report.json")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    const inputs = await resolveCalibrationInputs(options.corpus);
    const policy = loadGatePolicy(await resolveExistingPath(options.policy));
    const calibrationReport = await readJson(await resolveExistingPath(options.calibrationReport));
    await validateArtifactAgainstSchema("calibration-report.schema.json", calibrationReport);
    const report = await validateGatePolicyHoldout({
        ...inputs,
        policy,
        calibrationReport
    });
    await validateArtifactAgainstSchema("calibration-report.schema.json", report);
    await Promise.all([
        writeJson(path.join(options.out, "calibration-report.json"), report),
        writeReportFile(path.join(options.out, "calibration-report.md"), renderCalibrationMarkdown(report))
    ]);
    console.log(`gate policy holdout ${report.status}: ${options.out}`);
    process.exitCode = calibrationExitCode(report);
});
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
    .option("--corpus <path>", "versioned Gold Corpus manifest")
    .option("--split <split>", "development, calibration, or holdout; omit to validate all splits")
    .option("--runner <id>", "runner id", "simulated")
    .option("--expect <verdict>", "expected mutant verdict: fail, pass_with_warnings, diagnostic_only, or pass")
    .option("--suite-result <path>")
    .requiredOption("--out <dir>")
    .action(async (options) => {
    if (options.corpus) {
        if (options.mutation || options.mutationSet || options.case || options.target) {
            throw new Error("--corpus cannot be combined with --mutation, --mutation-set, --case, or --target.");
        }
        if (options.runner !== "simulated") {
            throw new Error("Gold Corpus reverse validation is harness-diagnostic and requires --runner simulated.");
        }
        const corpus = await loadGoldCorpus(await resolveExistingPath(options.corpus));
        const target = await loadTargetPack(corpus.manifest.targetId);
        const contract = (await profileTarget(target)).contract;
        const suite = materializeSmokeSuite(contract);
        const split = options.split
            ? [normalizeGoldCorpusSplit(options.split)]
            : undefined;
        const report = evaluateGoldCorpus(corpus, contract, suite.cases, {
            splits: split
        });
        await writeJson(path.join(options.out, "gold-corpus-report.json"), report);
        console.log(`Gold Corpus reverse validation written: ${options.out}`);
        if (report.status !== "PASS") {
            throw new Error(`Gold Corpus reverse validation failed: falsePass=${report.metrics.falsePassCount} falseNegative=${report.metrics.falseNegativeCount} falsePositive=${report.metrics.falsePositiveCount}.`);
        }
        return;
    }
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
function opencodeConformanceCapability(executable, adapterContract) {
    const capability = {
        schemaVersion: "0.1.0",
        name: "opencode",
        supported: true,
        executable,
        adapterVersion: adapterContract.version,
        executionMode: "live",
        supportsEntrypointKinds: [
            ...adapterContract.capabilities.entrypointKinds
        ],
        tokenSourceDetail: {
            source: "native",
            confidence: "high"
        },
        comparability: adapterContract.comparability ?? {
            workflowScore: "directional_only",
            efficiency: "comparable",
            tokenCost: "comparable"
        }
    };
    return {
        ...capability,
        capabilitiesHash: runnerCapabilityHash(capability)
    };
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
function normalizeGoldCorpusSplit(value) {
    if (value === "development" ||
        value === "calibration" ||
        value === "holdout") {
        return value;
    }
    throw new Error(`Unsupported Gold Corpus split: ${value}`);
}
async function resolveCalibrationInputs(corpusValue) {
    const corpusPath = await resolveExistingPath(corpusValue);
    const manifest = await readYaml(corpusPath);
    if (!manifest.targetId) {
        throw new Error("Gold Corpus manifest is missing targetId.");
    }
    const target = await loadTargetPack(manifest.targetId);
    const profile = await profileTarget(target);
    return {
        corpusPath,
        contract: profile.contract,
        cases: materializeSmokeSuite(profile.contract).cases
    };
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
function normalizeRunMode(value) {
    if (value === "diagnostic" || value === "gate") {
        return value;
    }
    throw new Error(`Unsupported run mode: ${value}`);
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
async function resolveObserverQualification(options, verifiedTrace, contractHash, caseSetHash) {
    if (Boolean(options.observerQualification) !==
        Boolean(options.trustedQualificationKey)) {
        throw new Error("--observer-qualification and --trusted-qualification-key must be provided together.");
    }
    if (!options.observerQualification ||
        !options.trustedQualificationKey) {
        return undefined;
    }
    const implementationHash = verifiedTrace.bundle.observer.implementationHash;
    const evidenceCapabilities = verifiedTrace.bundle.observer.evidenceCapabilities;
    if (!implementationHash ||
        !Array.isArray(evidenceCapabilities) ||
        evidenceCapabilities.length === 0) {
        throw new Error("Qualified workflow trace is missing Observer implementation or evidence capability bindings.");
    }
    const verifiedQualification = await verifyObserverQualificationArtifact(await resolveExistingPath(options.observerQualification), await resolveExistingPath(options.trustedQualificationKey), {
        observer: {
            id: verifiedTrace.bundle.observer.id,
            version: verifiedTrace.bundle.observer.version,
            keyFingerprint: verifiedTrace.keyFingerprint,
            implementationHash,
            evidenceCapabilities: evidenceCapabilities
        },
        contractHash,
        caseSetHash
    });
    assertQualifiedWorkflowTraceEvidence(verifiedTrace, verifiedQualification.artifact.observer);
    return verifiedQualification;
}
async function validateSchemasAndTargets() {
    await assertArtifactRegistryComplete();
    const ajv = new Ajv2020({ strict: false });
    const benchmarkRoot = getBenchmarkRoot();
    const schemaDir = path.join(benchmarkRoot, "schemas");
    const schemaFiles = (await readdir(schemaDir)).filter((file) => file.endsWith(".schema.json"));
    let validateTarget;
    let validateRunner;
    let validateEvaluationContract;
    let validateContractValidity;
    let validateGoldCorpus;
    let validateGoldCorpusBase;
    let validateGoldCorpusTrajectories;
    let validateGoldCorpusLabels;
    let validateObserverQualification;
    let validateReliabilityStudy;
    let validateReliabilityReport;
    let validateGatePolicyArtifact;
    let validateCalibrationReportArtifact;
    let validateContractModel;
    let validateProfileEvidence;
    let validateGenerationManifest;
    let validateRuntimeManifest;
    let validateProductionCanaryPolicy;
    let validateAdapterContractSchema;
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
        if (file === "gold-corpus.schema.json") {
            validateGoldCorpus = validate;
        }
        if (file === "gold-corpus-base.schema.json") {
            validateGoldCorpusBase = validate;
        }
        if (file === "gold-corpus-trajectories.schema.json") {
            validateGoldCorpusTrajectories = validate;
        }
        if (file === "gold-corpus-labels.schema.json") {
            validateGoldCorpusLabels = validate;
        }
        if (file === "observer-qualification.schema.json") {
            validateObserverQualification = validate;
        }
        if (file === "reliability-study.schema.json") {
            validateReliabilityStudy = validate;
        }
        if (file === "reliability-report.schema.json") {
            validateReliabilityReport = validate;
        }
        if (file === "gate-policy.schema.json") {
            validateGatePolicyArtifact = validate;
        }
        if (file === "calibration-report.schema.json") {
            validateCalibrationReportArtifact = validate;
        }
        if (file === "contract-model.schema.json") {
            validateContractModel = validate;
        }
        if (file === "profile-evidence.schema.json") {
            validateProfileEvidence = validate;
        }
        if (file === "generation-manifest.schema.json") {
            validateGenerationManifest = validate;
        }
        if (file === "runtime-manifest.schema.json") {
            validateRuntimeManifest = validate;
        }
        if (file === "production-canary-policy.schema.json") {
            validateProductionCanaryPolicy = validate;
        }
        if (file === "adapter-contract.schema.json") {
            validateAdapterContractSchema = validate;
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
    if (!validateObserverQualification) {
        throw new Error("observer-qualification.schema.json missing");
    }
    if (!validateReliabilityStudy || !validateReliabilityReport) {
        throw new Error("Reliability schemas are missing.");
    }
    if (!validateGatePolicyArtifact || !validateCalibrationReportArtifact) {
        throw new Error("Gate-policy calibration schemas are missing.");
    }
    if (!validateContractModel ||
        !validateProfileEvidence ||
        !validateGenerationManifest ||
        !validateRuntimeManifest) {
        throw new Error("Core machine-artifact schemas are missing.");
    }
    const externalValiditySchemaFiles = [
        "external-validity-study.schema.json",
        "external-validity-labeling-package.schema.json",
        "external-validity-agent-prelabels.schema.json",
        "external-validity-observations.schema.json",
        "external-validity-human-labels.schema.json",
        "validity-report.schema.json"
    ];
    if (externalValiditySchemaFiles.some((schemaName) => !schemaFiles.includes(schemaName))) {
        throw new Error("External validity schemas are missing.");
    }
    if (!validateGoldCorpus ||
        !validateGoldCorpusBase ||
        !validateGoldCorpusTrajectories ||
        !validateGoldCorpusLabels) {
        throw new Error("Gold Corpus schemas are missing.");
    }
    const evaluationContract = getEvaluationContract();
    if (!validateEvaluationContract(evaluationContract)) {
        throw new Error(`Canonical evaluation contract failed schema validation: ${ajv.errorsText(validateEvaluationContract.errors)}`);
    }
    const canonicalGatePolicyPath = path.join(benchmarkRoot, "configs/evaluation/gate-policy.json");
    if (!existsSync(canonicalGatePolicyPath)) {
        throw new Error("Canonical gate policy is missing.");
    }
    const canonicalGatePolicy = await readJson(canonicalGatePolicyPath);
    if (!validateGatePolicyArtifact(canonicalGatePolicy)) {
        throw new Error(`Canonical gate policy failed schema validation: ${ajv.errorsText(validateGatePolicyArtifact.errors)}`);
    }
    loadGatePolicy(canonicalGatePolicyPath);
    if (!validateProductionCanaryPolicy) {
        throw new Error("Production canary policy schema is missing.");
    }
    if (!validateAdapterContractSchema) {
        throw new Error("Adapter contract schema is missing.");
    }
    const productionCanaryPolicyPath = path.join(benchmarkRoot, "configs", "ci", "production-canary-policy.json");
    if (!existsSync(productionCanaryPolicyPath)) {
        throw new Error("Production canary policy config is missing.");
    }
    const productionCanaryPolicy = await readJson(productionCanaryPolicyPath);
    if (!validateProductionCanaryPolicy(productionCanaryPolicy)) {
        throw new Error(`Production canary policy failed schema validation: ${ajv.errorsText(validateProductionCanaryPolicy.errors)}`);
    }
    if (stableJson(productionCanaryPolicy) !==
        stableJson({
            schemaVersion: "0.1.0",
            policyType: "production_canary",
            ...PRODUCTION_CANARY_POLICY
        })) {
        throw new Error("Production canary policy config does not match runtime thresholds.");
    }
    if (existsSync(DEFAULT_GOLD_CORPUS_PATH)) {
        const goldCorpusManifest = YAML.parse(await readFile(DEFAULT_GOLD_CORPUS_PATH, "utf8"));
        if (!validateGoldCorpus(goldCorpusManifest)) {
            throw new Error(`Gold Corpus manifest failed schema validation: ${ajv.errorsText(validateGoldCorpus.errors)}`);
        }
        const goldCorpusRoot = path.dirname(DEFAULT_GOLD_CORPUS_PATH);
        const goldCorpusBase = YAML.parse(await readFile(path.join(goldCorpusRoot, goldCorpusManifest.baseTrajectory.path), "utf8"));
        if (!validateGoldCorpusBase(goldCorpusBase)) {
            throw new Error(`Gold Corpus base trajectory failed schema validation: ${ajv.errorsText(validateGoldCorpusBase.errors)}`);
        }
        for (const split of goldCorpusManifest.splits) {
            const trajectories = YAML.parse(await readFile(path.join(goldCorpusRoot, split.trajectoriesPath), "utf8"));
            const labels = YAML.parse(await readFile(path.join(goldCorpusRoot, split.labelsPath), "utf8"));
            if (!validateGoldCorpusTrajectories(trajectories)) {
                throw new Error(`Gold Corpus ${split.id} trajectories failed schema validation: ${ajv.errorsText(validateGoldCorpusTrajectories.errors)}`);
            }
            if (!validateGoldCorpusLabels(labels)) {
                throw new Error(`Gold Corpus ${split.id} labels failed schema validation: ${ajv.errorsText(validateGoldCorpusLabels.errors)}`);
            }
        }
        await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    }
    const externalValidityStudyPath = path.join(benchmarkRoot, "fixtures", "external-validity", "v1", "study.yaml");
    if (existsSync(externalValidityStudyPath)) {
        const study = await loadExternalValidityStudy(externalValidityStudyPath);
        const artifacts = createExternalValidityLabelingPackage(study);
        const report = analyzeExternalValidity(study);
        await Promise.all([
            validateExternalValidityPackage(artifacts),
            validateExternalValidityReport(report)
        ]);
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
        const profile = await profileTarget(target);
        if (!validateContractModel(profile.contract)) {
            throw new Error(`Target ${id} ContractModel failed schema validation: ${ajv.errorsText(validateContractModel.errors)}`);
        }
        const publicEvidence = publicProfileEvidence(profile.evidence);
        if (!validateProfileEvidence(publicEvidence)) {
            throw new Error(`Target ${id} public profile evidence failed schema validation: ${ajv.errorsText(validateProfileEvidence.errors)}`);
        }
        const generationManifest = materializeSmokeSuite(profile.contract).manifest;
        if (!validateGenerationManifest(generationManifest)) {
            throw new Error(`Target ${id} generation manifest failed schema validation: ${ajv.errorsText(validateGenerationManifest.errors)}`);
        }
    }
    const runnerDir = path.join(benchmarkRoot, "configs/runners");
    for (const file of (await readdir(runnerDir)).filter((entry) => entry.endsWith(".yaml"))) {
        const runnerConfig = YAML.parse(await readFile(path.join(runnerDir, file), "utf8"));
        if (!validateRunner(runnerConfig)) {
            throw new Error(`Runner config ${file} failed schema validation: ${ajv.errorsText(validateRunner.errors)}`);
        }
    }
    const adapterDir = path.join(benchmarkRoot, "configs/adapters");
    for (const file of (await readdir(adapterDir)).filter((entry) => entry.endsWith(".json"))) {
        const adapterPath = path.join(adapterDir, file);
        const adapterConfig = await readJson(adapterPath);
        if (!validateAdapterContractSchema(adapterConfig)) {
            throw new Error(`Adapter config ${file} failed schema validation: ${ajv.errorsText(validateAdapterContractSchema.errors)}`);
        }
        await loadAdapterContract(adapterPath);
    }
    const calibrationArtifactRoot = path.join(benchmarkRoot, "fixtures/calibration/v1");
    const committedFitPolicyPath = path.join(calibrationArtifactRoot, "fit/gate-policy.json");
    const committedFitReportPath = path.join(calibrationArtifactRoot, "fit/calibration-report.json");
    const committedHoldoutReportPath = path.join(calibrationArtifactRoot, "holdout/calibration-report.json");
    for (const artifactPath of [
        committedFitPolicyPath,
        committedFitReportPath,
        committedHoldoutReportPath
    ]) {
        if (!existsSync(artifactPath)) {
            throw new Error(`Committed gate-policy calibration artifact is missing: ${path.relative(benchmarkRoot, artifactPath)}.`);
        }
    }
    const committedFitPolicy = loadGatePolicy(committedFitPolicyPath);
    if (committedFitPolicy.policyHash !== canonicalGatePolicy.policyHash ||
        committedFitPolicy.rulesHash !== canonicalGatePolicy.rulesHash) {
        throw new Error("Committed calibration policy does not match the canonical gate policy.");
    }
    const committedFitReport = await readJson(committedFitReportPath);
    const committedHoldoutReport = await readJson(committedHoldoutReportPath);
    for (const report of [committedFitReport, committedHoldoutReport]) {
        if (!validateCalibrationReportArtifact(report)) {
            throw new Error(`Committed calibration report failed schema validation: ${ajv.errorsText(validateCalibrationReportArtifact.errors)}`);
        }
        assertCalibrationReportIntegrity(report);
    }
    if (committedFitReport.status !== "PENDING_HOLDOUT" ||
        committedHoldoutReport.status !== "PASS" ||
        committedFitReport.releaseEligible !== false ||
        committedHoldoutReport.releaseEligible !== false) {
        throw new Error("Committed calibration reports do not preserve the harness-diagnostic fit/holdout boundary.");
    }
    if (!existsSync(DEFAULT_GOLD_CORPUS_PATH)) {
        throw new Error("Versioned Gold Corpus manifest is missing.");
    }
}
async function validateArtifactAgainstSchema(schemaName, value) {
    const schemaPath = path.join(getBenchmarkRoot(), "schemas", schemaName);
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) {
        throw new Error(`${schemaName} validation failed: ${ajv.errorsText(validate.errors)}`);
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
    const suite = materializeSmokeSuite(profile.contract, {
        suite: options.suite,
        seed: options.seed
    });
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
function reliabilityExitCode(report) {
    if (report.gateEligibility === "BLOCK" || report.conclusion === "INVALID") {
        return 1;
    }
    return report.strongConclusionAllowed ? 0 : 2;
}
function calibrationExitCode(report) {
    if (report.status === "FAIL") {
        return 1;
    }
    return report.status === "PASS" ? 0 : 2;
}
function productionCanaryExitCode(status) {
    if (status === "PASS") {
        return 0;
    }
    return status === "FAIL" ? 1 : 2;
}
function productionCiGateExitCode(result) {
    if (result.decision === "PASS") {
        return 0;
    }
    return result.decision === "BLOCK" ? 1 : 2;
}
function normalizeTraceDiffMode(value) {
    if (value === "baseline-candidate" || value === "baseline_candidate") {
        return "baseline_candidate";
    }
    if (value === "baseline-mutant-restore" ||
        value === "baseline_mutant_restore") {
        return "baseline_mutant_restore";
    }
    throw new Error("--mode must be baseline-candidate or baseline-mutant-restore.");
}
function assertTraceDiffModeInputs(mode, options) {
    if (mode === "baseline_candidate") {
        if (!options.candidate || options.mutant || options.restore) {
            throw new Error("baseline-candidate mode requires --candidate and forbids --mutant/--restore.");
        }
        return;
    }
    if (!options.mutant || !options.restore || options.candidate) {
        throw new Error("baseline-mutant-restore mode requires --mutant and --restore and forbids --candidate.");
    }
}
function assertTraceDiffTrustInputs(options) {
    const hasQualification = Boolean(options.observerQualification);
    const hasQualificationKey = Boolean(options.trustedQualificationKey);
    if (hasQualification !== hasQualificationKey) {
        throw new Error("--observer-qualification and --trusted-qualification-key must be provided together.");
    }
    if ((hasQualification || hasQualificationKey) &&
        !options.trustedObserverKey) {
        throw new Error("Qualified trace diffs also require --trusted-observer-key.");
    }
}
async function loadTraceForDiff(role, value, trust) {
    const tracePath = await resolveExistingPath(value);
    const bundle = await readJsonWithSchema(tracePath, "workflow-trace.schema.json", `${role} workflow trace`);
    let verified;
    let qualified = false;
    let qualificationArtifactHash;
    if (trust.trustedObserverKey) {
        verified = await verifyWorkflowTraceBundle(tracePath, await resolveExistingPath(trust.trustedObserverKey), {
            targetId: bundle.subject.targetId,
            contractHash: bundle.subject.contractHash,
            suite: bundle.subject.suite,
            seed: bundle.subject.seed,
            caseSetHash: bundle.subject.caseSetHash,
            caseIds: bundle.cases.map((item) => item.caseId),
            cases: bundle.cases.map((item) => ({
                id: item.caseId,
                templateId: item.templateId
            })),
            runner: bundle.subject.runner
        });
        const qualification = await resolveObserverQualification({
            observerQualification: trust.observerQualification,
            trustedQualificationKey: trust.trustedQualificationKey
        }, verified, bundle.subject.contractHash, bundle.subject.caseSetHash);
        qualified = Boolean(qualification);
        qualificationArtifactHash = qualification?.artifactHash;
    }
    return {
        role,
        bundle,
        trace: {
            ref: `${role}:workflow-trace.json`,
            traceHash: verified?.traceHash ?? (await hashFile(tracePath)),
            cases: bundle.cases.map((item) => ({
                caseId: item.caseId,
                templateId: item.templateId,
                events: item.events
            }))
        },
        qualified,
        ...(verified
            ? { observerKeyFingerprint: verified.keyFingerprint }
            : {}),
        ...(qualificationArtifactHash
            ? { qualificationArtifactHash }
            : {})
    };
}
function traceComparability(bundles) {
    const baseline = bundles[0];
    if (!baseline) {
        throw new Error("Trace diff requires a baseline workflow trace.");
    }
    const reasons = new Set();
    for (const candidate of bundles.slice(1)) {
        if (candidate.schemaVersion !== baseline.schemaVersion) {
            reasons.add("TRACE_SCHEMA_VERSION_MISMATCH");
        }
        if (candidate.subject.targetId !== baseline.subject.targetId) {
            reasons.add("TRACE_TARGET_MISMATCH");
        }
        if (candidate.subject.contractHash !== baseline.subject.contractHash) {
            reasons.add("TRACE_CONTRACT_MISMATCH");
        }
        if (candidate.subject.suite !== baseline.subject.suite) {
            reasons.add("TRACE_SUITE_MISMATCH");
        }
        if (candidate.subject.caseSetHash !== baseline.subject.caseSetHash) {
            reasons.add("TRACE_CASE_SET_MISMATCH");
        }
        if (stableJson(candidate.subject.runner) !==
            stableJson(baseline.subject.runner)) {
            reasons.add("TRACE_RUNNER_MISMATCH");
        }
        if (candidate.subject.isolation !== baseline.subject.isolation) {
            reasons.add("TRACE_ISOLATION_MISMATCH");
        }
        if (candidate.subject.permissionMode !== baseline.subject.permissionMode) {
            reasons.add("TRACE_PERMISSION_MISMATCH");
        }
        if (candidate.subject.model !== baseline.subject.model) {
            reasons.add("TRACE_MODEL_MISMATCH");
        }
        if (candidate.subject.seed !== baseline.subject.seed) {
            reasons.add("TRACE_SEED_MISMATCH");
        }
        if (candidate.observer.id !== baseline.observer.id ||
            candidate.observer.version !== baseline.observer.version ||
            candidate.observer.keyFingerprint !== baseline.observer.keyFingerprint ||
            candidate.observer.implementationHash !==
                baseline.observer.implementationHash ||
            stableJson(candidate.observer.evidenceCapabilities) !==
                stableJson(baseline.observer.evidenceCapabilities)) {
            reasons.add("TRACE_OBSERVER_MISMATCH");
        }
    }
    return {
        status: reasons.size === 0 ? "COMPARABLE" : "INCOMPARABLE",
        reasons: [...reasons].sort()
    };
}
async function loadHtmlViewerInputs(options) {
    const input = {};
    const manifestInputs = [];
    const specs = [
        {
            option: options.decision,
            key: "decisionReport",
            artifactType: "decision_report",
            ref: "decision-report.json",
            schema: "decision-report.schema.json",
            label: "Decision report"
        },
        {
            option: options.comparison,
            key: "comparison",
            artifactType: "comparison_result",
            ref: "comparison-result.json",
            schema: "comparison-result.schema.json",
            label: "Comparison result"
        },
        {
            option: options.traceDiff,
            key: "traceDiff",
            artifactType: "trace_diff",
            ref: "trace-diff.json",
            schema: "trace-diff.schema.json",
            label: "Trace diff"
        },
        {
            option: options.trend,
            key: "trends",
            artifactType: "trend_report",
            ref: "trend-report.json",
            schema: "trend-report.schema.json",
            label: "Trend report"
        }
    ];
    for (const spec of specs) {
        if (!spec.option) {
            continue;
        }
        const filePath = await resolveExistingPath(spec.option);
        const value = await readJsonWithSchema(filePath, spec.schema, spec.label);
        input[spec.key] = value;
        manifestInputs.push({
            artifactType: spec.artifactType,
            ref: spec.ref,
            schemaVersion: "0.1.0",
            value
        });
    }
    if (manifestInputs.length === 0) {
        throw new Error("HTML viewer requires at least one of --decision, --comparison, --trace-diff, or --trend.");
    }
    return { input, manifestInputs };
}
function normalizeProductionCanarySamples(input) {
    if (Array.isArray(input)) {
        return input;
    }
    if (isObjectRecord(input) && Array.isArray(input.samples)) {
        return input.samples;
    }
    throw new Error("Production canary samples must be a JSON array or an object with a samples array.");
}
function stableArtifactHash(value) {
    return sha256Text(stableJson(value));
}
async function readJsonWithSchema(filePath, schemaName, label) {
    const value = await readJson(filePath);
    await assertJsonSchema(value, schemaName, label);
    return value;
}
async function assertJsonSchema(value, schemaName, label) {
    const schema = JSON.parse(await readFile(path.join(getBenchmarkRoot(), "schemas", schemaName), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) {
        throw new Error(`${label} failed schema validation: ${ajv.errorsText(validate.errors)}`);
    }
}
function isObjectRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function writeExternalValidityLabelingArtifacts(outDir, artifacts) {
    await Promise.all([
        writeJson(path.join(outDir, "external-validity-labeling-package.json"), artifacts.package),
        writeJson(path.join(outDir, "external-validity-observations.template.json"), artifacts.observationsTemplate),
        writeJson(path.join(outDir, "external-validity-human-labels.template.json"), artifacts.labelsTemplate),
        ...artifacts.agentPrelabelTemplates.map((template) => writeJson(path.join(outDir, `external-validity-agent-prelabels.${template.laneId}.template.json`), template))
    ]);
}
function externalValidityExitCode(report) {
    if (report.status === "FAIL" || report.gateEligibility === "BLOCK") {
        return 1;
    }
    return report.strongConclusionAllowed ? 0 : 2;
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
        "token-ledger-drop": "efficiency-token",
        "event-missing": "static-contract",
        "event-order-invalid": "static-contract",
        "observer-event-forged": "static-contract",
        "secret-leak": "static-contract"
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
    if (runnerCapability.name === "opencode") {
        const adapterContract = await loadAdapterContract(path.join(getBenchmarkRoot(), "configs/adapters/opencode.json"));
        return createOpenCodeRunnerAdapter(adapterContract, {
            executable: runnerCapability.executable ?? ""
        }).run({
            testCase,
            contract,
            capability: runnerCapability,
            ...optionsForRunner
        });
    }
    throw new Error(`Live execution is implemented for codex, claude, and opencode, got ${runnerCapability.name}`);
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
