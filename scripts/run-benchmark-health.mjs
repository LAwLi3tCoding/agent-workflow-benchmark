#!/usr/bin/env node
import {
  createHash,
  generateKeyPairSync
} from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  normalizeHealthGateEligibility,
  portableCommandValue,
  redactPublicCommandText
} from "../dist/src/ci/benchmarkHealthWorkflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.env.BENCHMARK_HEALTH_OUT ?? "reports/benchmark-health");
const healthDir = path.join(outDir, "health");
const tempRoots = [];
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const cli = path.join(repoRoot, "dist", "src", "cli", "index.js");

await mkdir(healthDir, { recursive: true });

const checkResults = new Map();
const commandResults = [];

try {
  await assertBuiltCli();

  await runGoldCorpus();
  await runP0Mutations();
  await runObserverQualification();
  await runAaReliability();
  await runSchemaCompatibility();
  await runPluginInstall();
  await runPrivacyScan();

  const input = await buildBenchmarkHealthInput();
  const inputPath = path.join(outDir, "benchmark-health-input.json");
  await writeJson(inputPath, input);

  const aggregate = await runCommand("node", [
    cli,
    "ci",
    "benchmark-health",
    "--input",
    inputPath,
    "--out",
    outDir
  ]);
  const reportPath = path.join(outDir, "benchmark-health-report.json");
  const report = await readJsonIfExists(reportPath);
  await writeEvidenceManifest(report);
  await writeMarker(report);

  process.exitCode =
    aggregate.exitCode === 0 && report?.versionDisposition === "RELEASE_ELIGIBLE"
      ? 0
      : 2;
} finally {
  for (const tempRoot of tempRoots.reverse()) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runGoldCorpus() {
  const dir = path.join(healthDir, "gold-corpus");
  await mkdir(dir, { recursive: true });
  const result = await runCommand("node", [
    cli,
    "gold-corpus",
    "validate",
    "--corpus",
    path.join(repoRoot, "fixtures", "gold-corpus", "v1", "manifest.yaml"),
    "--out",
    dir
  ]);
  const report = await readJsonIfExists(path.join(dir, "gold-corpus-report.json"));
  checkResults.set("goldCorpus", {
    status: result.exitCode === 0 && report?.status === "PASS" ? "PASS" : "FAIL",
    evidenceRef: "health/gold-corpus/gold-corpus-report.json",
    metrics: {
      p0MutationKillRate: numberOrZero(report?.metrics?.p0MutationKillRate),
      falseNegativeCount: integerOrZero(report?.metrics?.falseNegativeCount),
      falsePassCount: integerOrZero(report?.metrics?.falsePassCount),
      knownGoodBlockedCount: integerOrZero(report?.metrics?.knownGoodBlockedCount)
    }
  });
}

async function runP0Mutations() {
  const dir = path.join(healthDir, "p0-mutation");
  await mkdir(dir, { recursive: true });
  const result = await runCommand("node", [
    cli,
    "debug",
    "reverse-validate",
    "--target",
    "minimal-directory-agent",
    "--suite",
    "smoke",
    "--mutation-set",
    path.join(repoRoot, "fixtures", "mutations", "extended.yaml"),
    "--runner",
    "simulated",
    "--out",
    dir
  ]);
  const summary = await readJsonIfExists(path.join(dir, "debug-summary.json"));
  const mutationCount = Array.isArray(summary?.results) ? summary.results.length : 0;
  const killedCount = Array.isArray(summary?.results)
    ? summary.results.filter((item) => item.killed === true && item.status === "PASS").length
    : 0;
  const falseNegativeCount = Array.isArray(summary?.results)
    ? summary.results.filter((item) => item.killed !== true || item.status !== "PASS").length
    : result.exitCode === 0
      ? 0
      : 1;
  const report = {
    schemaVersion: "0.1.0",
    artifactType: "p0_mutation_health",
    generatedAt: new Date().toISOString(),
    commandExitCode: result.exitCode,
    mutationCount,
    killedCount,
    detectionRate: mutationCount === 0 ? 0 : killedCount / mutationCount,
    falseNegativeCount,
    falsePassCount: 0,
    summaryRef: summary ? "debug-summary.json" : null
  };
  await writeJson(path.join(dir, "p0-mutation-report.json"), withIntegrity(report));
  checkResults.set("p0Mutation", {
    status: result.exitCode === 0 && falseNegativeCount === 0 ? "PASS" : "FAIL",
    evidenceRef: "health/p0-mutation/p0-mutation-report.json",
    metrics: {
      detectionRate: report.detectionRate,
      falseNegativeCount,
      falsePassCount: 0
    }
  });
}

async function runObserverQualification() {
  const dir = path.join(healthDir, "observer-qualification");
  await mkdir(dir, { recursive: true });
  const keyRoot = await makeTempRoot("awb-health-keys-");
  const observerPrivate = path.join(keyRoot, "observer-private.pem");
  const authorityPrivate = path.join(keyRoot, "authority-private.pem");
  await writePrivateKey(observerPrivate);
  await writePrivateKey(authorityPrivate);

  const result = await runCommand("node", [
    cli,
    "observer",
    "qualify",
    "--target",
    "minimal-directory-agent",
    "--suite",
    "smoke",
    "--observer-id",
    "benchmark-health-reference-observer",
    "--observer-version",
    packageJson.version,
    "--observer-private-key",
    observerPrivate,
    "--qualification-authority-private-key",
    authorityPrivate,
    "--out",
    dir
  ]);
  const artifact = await readJsonIfExists(path.join(dir, "observer-qualification.json"));
  const report = await readJsonIfExists(path.join(dir, "observer-qualification-report.json"));
  const source = report ?? artifact;
  const privateKeyVisible = source?.results?.privateKeyVisibleToRunner ?? source?.privateKeyVisibleToRunner ?? true;
  checkResults.set("observerQualification", {
    status:
      result.exitCode === 0 &&
      (source?.decision === "valid" || source?.results?.decision === "valid") &&
      privateKeyVisible === false
        ? "PASS"
        : "FAIL",
    evidenceRef: "health/observer-qualification/observer-qualification.json",
    metrics: {
      decision: source?.decision ?? source?.results?.decision ?? "invalid",
      p0DetectionRate: numberOrZero(source?.p0DetectionRate ?? source?.results?.p0DetectionRate),
      falsePassCount: integerOrZero(source?.falsePassCount ?? source?.results?.falsePassCount),
      privateKeyVisibleToRunner: Boolean(privateKeyVisible)
    }
  });
}

async function runAaReliability() {
  const root = path.join(healthDir, "aa-reliability");
  await mkdir(root, { recursive: true });
  const seed = "benchmark-health-aa-fixed-seed";
  const baseline = path.join(root, "baseline");
  await runSimulatedRun(baseline, seed);
  const pairs = [];
  for (let index = 0; index < 5; index += 1) {
    const candidate = path.join(root, `candidate-${index + 1}`);
    await runSimulatedRun(candidate, seed);
    pairs.push({
      sampleId: `aa-repeat-${index + 1}`,
      baseline: path.relative(root, baseline).split(path.sep).join("/"),
      candidate: path.relative(root, candidate).split(path.sep).join("/")
    });
  }
  const study = {
    schemaVersion: "0.1.0",
    studyId: "benchmark-health-aa-reliability",
    kind: "deterministic_repeat",
    seed,
    pairs
  };
  const studyPath = path.join(root, "reliability-study.json");
  await writeJson(studyPath, study);
  const result = await runCommand("node", [
    cli,
    "debug",
    "reliability",
    "--study",
    studyPath,
    "--out",
    root
  ]);
  const report = await readJsonIfExists(path.join(root, "reliability-report.json"));
  const observed = integerOrZero(report?.metrics?.sampleSize?.observed);
  const minimum = integerOrZero(report?.metrics?.sampleSize?.minimum);
  checkResults.set("aaReliability", {
    status:
      result.exitCode === 0 || result.exitCode === 2
        ? observed >= 5 &&
          observed >= minimum &&
          numberOrZero(report?.metrics?.deterministicAgreement) === 1
          ? "PASS"
          : "FAIL"
        : "FAIL",
    evidenceRef: "health/aa-reliability/reliability-report.json",
    metrics: {
      gateEligibility: normalizeHealthGateEligibility(report?.gateEligibility),
      deterministicAgreement: numberOrZero(report?.metrics?.deterministicAgreement),
      stableGateAgreement: numberOrZero(report?.metrics?.gateConsistency?.pointEstimate),
      p0FalsePassCount: integerOrZero(report?.metrics?.p0FalsePassCount),
      sampleSufficient: observed >= 5 && observed >= minimum
    }
  });
}

async function runSchemaCompatibility() {
  const dir = path.join(healthDir, "schema-compatibility");
  await mkdir(dir, { recursive: true });
  const validation = await runCommand("node", [cli, "validate-schema"]);
  const migration = await runCommand("node", [
    cli,
    "artifact",
    "migrate",
    "--input",
    path.join(healthDir, "observer-qualification", "observer-qualification.json"),
    "--artifact-type",
    "observer-qualification",
    "--out",
    dir
  ]);
  const report = withIntegrity({
    schemaVersion: "0.1.0",
    artifactType: "schema_compatibility_health",
    generatedAt: new Date().toISOString(),
    validateSchemaExitCode: validation.exitCode,
    migrationExitCode: migration.exitCode,
    compatible: validation.exitCode === 0 && migration.exitCode === 0,
    incompatibleArtifactCount: validation.exitCode === 0 && migration.exitCode === 0 ? 0 : 1
  });
  await writeJson(path.join(dir, "schema-compatibility.json"), report);
  checkResults.set("schemaCompatibility", {
    status: report.compatible ? "PASS" : "FAIL",
    evidenceRef: "health/schema-compatibility/schema-compatibility.json",
    metrics: {
      compatible: report.compatible,
      incompatibleArtifactCount: report.incompatibleArtifactCount
    }
  });
}

async function runPluginInstall() {
  const dir = path.join(healthDir, "plugin-install");
  await mkdir(dir, { recursive: true });
  const expectedRuntime = await materializeExpectedRuntime();
  const expectedDigest = await digestDirectory(expectedRuntime);
  const actualDigest = await runtimeDigest();
  const runtimeParity = actualDigest === expectedDigest;
  const tempRoot = await makeTempRoot("awb-health-plugin-");
  const pluginCopy = path.join(tempRoot, "plugin", "agent-workflow-bench");
  await mkdir(path.dirname(pluginCopy), { recursive: true });
  await cp(path.join(repoRoot, "plugins", "agent-workflow-bench"), pluginCopy, {
    recursive: true
  });
  await rm(path.join(pluginCopy, "runtime", "node_modules"), {
    recursive: true,
    force: true
  });
  const fresh = await runCommand(
    path.join(pluginCopy, "bin", "awb"),
    ["validate-schema"],
    { cwd: tempRoot }
  );
  const report = withIntegrity({
    schemaVersion: "0.1.0",
    artifactType: "plugin_install_health",
    generatedAt: new Date().toISOString(),
    expectedRuntimeDigest: expectedDigest,
    actualRuntimeDigest: actualDigest,
    freshInstallExitCode: fresh.exitCode,
    freshInstall: fresh.exitCode === 0,
    runtimeParity
  });
  await writeJson(path.join(dir, "plugin-install.json"), report);
  checkResults.set("pluginInstall", {
    status: report.freshInstall && report.runtimeParity ? "PASS" : "FAIL",
    evidenceRef: "health/plugin-install/plugin-install.json",
    metrics: {
      freshInstall: report.freshInstall,
      runtimeParity: report.runtimeParity
    }
  });
}

async function runPrivacyScan() {
  const dir = path.join(healthDir, "privacy-scan");
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "privacy-scan.json");
  const result = await runCommand("node", [
    path.join(repoRoot, "scripts", "privacy-scan.mjs"),
    "--out",
    reportPath
  ]);
  const report = await readJsonIfExists(reportPath);
  checkResults.set("privacyScan", {
    status: result.exitCode === 0 && integerOrZero(report?.findingCount) === 0 ? "PASS" : "FAIL",
    evidenceRef: "health/privacy-scan/privacy-scan.json",
    metrics: {
      findingCount: integerOrZero(report?.findingCount)
    }
  });
}

async function runSimulatedRun(out, seed) {
  await runCommand("node", [
    cli,
    "run",
    "--target",
    "minimal-directory-agent",
    "--suite",
    "smoke",
    "--runner",
    "simulated",
    "--execution",
    "simulated",
    "--seed",
    seed,
    "--out",
    out
  ]);
}

async function buildBenchmarkHealthInput() {
  const generatedAt = new Date().toISOString();
  const goldCorpus = await healthCheck("goldCorpus", "health/gold-corpus/gold-corpus-report.json");
  const p0Mutation = await healthCheck("p0Mutation", "health/p0-mutation/p0-mutation-report.json");
  const observerQualification = await healthCheck("observerQualification", "health/observer-qualification/observer-qualification.json");
  const aaReliability = await healthCheck("aaReliability", "health/aa-reliability/reliability-report.json");
  const schemaCompatibility = await healthCheck("schemaCompatibility", "health/schema-compatibility/schema-compatibility.json");
  const pluginInstall = await healthCheck("pluginInstall", "health/plugin-install/plugin-install.json");
  const privacyScan = await healthCheck("privacyScan", "health/privacy-scan/privacy-scan.json");

  return {
    benchmarkVersion: packageJson.version,
    generatedAt,
    goldCorpus: {
      ...goldCorpus,
      p0MutationKillRate: checkResults.get("goldCorpus")?.metrics.p0MutationKillRate ?? 0,
      falseNegativeCount: checkResults.get("goldCorpus")?.metrics.falseNegativeCount ?? 1,
      falsePassCount: checkResults.get("goldCorpus")?.metrics.falsePassCount ?? 0,
      knownGoodBlockedCount: checkResults.get("goldCorpus")?.metrics.knownGoodBlockedCount ?? 0
    },
    p0Mutation: {
      ...p0Mutation,
      detectionRate: checkResults.get("p0Mutation")?.metrics.detectionRate ?? 0,
      falseNegativeCount: checkResults.get("p0Mutation")?.metrics.falseNegativeCount ?? 1,
      falsePassCount: checkResults.get("p0Mutation")?.metrics.falsePassCount ?? 0
    },
    observerQualification: {
      ...observerQualification,
      decision: checkResults.get("observerQualification")?.metrics.decision ?? "invalid",
      p0DetectionRate: checkResults.get("observerQualification")?.metrics.p0DetectionRate ?? 0,
      falsePassCount: checkResults.get("observerQualification")?.metrics.falsePassCount ?? 0,
      privateKeyVisibleToRunner:
        checkResults.get("observerQualification")?.metrics.privateKeyVisibleToRunner ?? true
    },
    aaReliability: {
      ...aaReliability,
      gateEligibility: checkResults.get("aaReliability")?.metrics.gateEligibility ?? "BLOCKED",
      deterministicAgreement: checkResults.get("aaReliability")?.metrics.deterministicAgreement ?? 0,
      stableGateAgreement: checkResults.get("aaReliability")?.metrics.stableGateAgreement ?? 0,
      p0FalsePassCount: checkResults.get("aaReliability")?.metrics.p0FalsePassCount ?? 0,
      sampleSufficient: checkResults.get("aaReliability")?.metrics.sampleSufficient ?? false
    },
    schemaCompatibility: {
      ...schemaCompatibility,
      compatible: checkResults.get("schemaCompatibility")?.metrics.compatible ?? false,
      incompatibleArtifactCount:
        checkResults.get("schemaCompatibility")?.metrics.incompatibleArtifactCount ?? 1
    },
    pluginInstall: {
      ...pluginInstall,
      freshInstall: checkResults.get("pluginInstall")?.metrics.freshInstall ?? false,
      runtimeParity: checkResults.get("pluginInstall")?.metrics.runtimeParity ?? false
    },
    privacyScan: {
      ...privacyScan,
      findingCount: checkResults.get("privacyScan")?.metrics.findingCount ?? 1
    }
  };
}

async function healthCheck(id, evidenceRef) {
  const result = checkResults.get(id);
  await ensureEvidenceFile(id, evidenceRef, result);
  return {
    status: result?.status ?? "MISSING",
    evidenceRef,
    evidenceHash: await hashPortableRef(evidenceRef)
  };
}

async function ensureEvidenceFile(id, evidenceRef, result) {
  const file = path.join(outDir, evidenceRef);
  try {
    const info = await stat(file);
    if (info.isFile()) {
      return;
    }
  } catch {
    // Missing native evidence is represented by this redacted diagnostic file.
  }
  await writeJson(
    file,
    withIntegrity({
      schemaVersion: "0.1.0",
      artifactType: "benchmark_health_missing_evidence",
      generatedAt: new Date().toISOString(),
      checkId: id,
      status: result?.status ?? "MISSING"
    })
  );
}

async function writeEvidenceManifest(report) {
  const refs = [
    "benchmark-health-input.json",
    "benchmark-health-report.json",
    ...[...checkResults.values()].map((check) => check.evidenceRef)
  ];
  const artifacts = [];
  for (const ref of refs) {
    artifacts.push({
      ref,
      sha256: await hashPortableRef(ref)
    });
  }
  await writeJson(
    path.join(outDir, "evidence-manifest.json"),
    withIntegrity({
      schemaVersion: "0.1.0",
      artifactType: "benchmark_health_evidence_manifest",
      generatedAt: new Date().toISOString(),
      disposition: report?.versionDisposition ?? "DIAGNOSTIC_ONLY",
      commandResults,
      artifacts
    })
  );
}

async function writeMarker(report) {
  const disposition = report?.versionDisposition === "RELEASE_ELIGIBLE"
    ? "RELEASE_ELIGIBLE"
    : "DIAGNOSTIC_ONLY";
  await Promise.all([
    rm(path.join(outDir, "HEALTH_RELEASE_ELIGIBLE.marker"), {
      force: true
    }),
    rm(path.join(outDir, "HEALTH_DIAGNOSTIC_ONLY.marker"), {
      force: true
    })
  ]);
  await writeFile(
    path.join(outDir, `HEALTH_${disposition}.marker`),
    `disposition=${disposition}\nreport=benchmark-health-report.json\n`
  );
}

async function assertBuiltCli() {
  try {
    const info = await stat(cli);
    if (!info.isFile()) {
      throw new Error("built CLI path is not a file");
    }
  } catch (error) {
    throw new Error(
      `Built CLI is missing at dist/src/cli/index.js; run npm run build before benchmark health. ${error.message}`
    );
  }
}

async function runCommand(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  const result = {
    command: path.basename(command),
    args: redactArgs(args),
    cwd: options.cwd ? portablePath(options.cwd) : ".",
    exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    stdoutTail: redactText(stdout).slice(-4000),
    stderrTail: redactText(stderr).slice(-4000)
  };
  commandResults.push(result);
  process.stdout.write(`${result.command} ${result.args.join(" ")} -> ${exitCode}\n`);
  return result;
}

function redactArgs(args) {
  return args.map((arg) => {
    const text = String(arg);
    if (tempRoots.some((root) => text.startsWith(root))) {
      return "<ephemeral-temp-path>";
    }
    return portablePath(text);
  });
}

function redactText(text) {
  return redactPublicCommandText(text, {
    repoRoot,
    outputRoot: outDir,
    tempRoots
  });
}

function portablePath(value) {
  return portableCommandValue(String(value), {
    repoRoot,
    tempRoots
  });
}

async function makeTempRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePrivateKey(file) {
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(
    file,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );
}

async function runtimeDigest() {
  return digestDirectory(path.join(repoRoot, "plugins", "agent-workflow-bench", "runtime"));
}

async function materializeExpectedRuntime() {
  const tempRoot = await makeTempRoot("awb-health-expected-runtime-");
  const runtimeRoot = path.join(tempRoot, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  for (const entry of [
    "dist",
    "configs",
    "schemas",
    "fixtures",
    "package.json",
    "package-lock.json"
  ]) {
    await cp(path.join(repoRoot, entry), path.join(runtimeRoot, entry), {
      recursive: true
    });
  }
  await writeFile(
    path.join(runtimeRoot, "README.md"),
    [
      "# Agent Workflow Bench Runtime",
      "",
      "This directory is generated by `npm run plugin:build`.",
      "It makes the Codex/Claude Code plugin runnable after marketplace installation without requiring users to clone the source repository.",
      "",
      "Do not edit generated runtime files directly; change the source project and rebuild the plugin runtime."
    ].join("\n")
  );
  return runtimeRoot;
}

async function digestDirectory(root) {
  const files = await listFiles(root);
  const entries = [];
  for (const file of files) {
    entries.push({
      path: path.relative(root, file).split(path.sep).join("/"),
      sha256: await hashFile(file)
    });
  }
  return sha256(JSON.stringify(entries.sort((a, b) => a.path.localeCompare(b.path))));
}

async function listFiles(root) {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(root, { withFileTypes: true })
  );
  const output = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFiles(absolute)));
    } else if (entry.isFile()) {
      output.push(absolute);
    }
  }
  return output;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function hashPortableRef(ref) {
  return hashFile(path.join(outDir, ref));
}

async function hashFile(file) {
  try {
    return sha256(await readFile(file));
  } catch {
    return `sha256:${"0".repeat(64)}`;
  }
}

function withIntegrity(value) {
  return {
    ...value,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256(JSON.stringify(value))
    }
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function integerOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
