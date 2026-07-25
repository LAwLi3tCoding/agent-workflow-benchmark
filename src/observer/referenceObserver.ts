import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";
import {
  createReadStream,
  readFileSync
} from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { execa } from "execa";
import type { RunEvent } from "../core/types.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { WorkflowTraceBundle } from "./workflowTrace.js";

export const REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES = [
  "filesystem",
  "tool",
  "process",
  "network",
  "artifact",
  "state",
  "side_effect",
  "token"
] as const;

export type ReferenceObserverEvidenceCapability =
  (typeof REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES)[number];

export interface ReferenceObservationRequest {
  schemaVersion: "0.1.0";
  observer: {
    id: string;
    version: string;
  };
  subject: WorkflowTraceBundle["subject"];
  cases: Array<{
    caseId: string;
    templateId: string;
    runId: string;
    workspaceRoot: string;
    command: {
      executable: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
    };
    artifactPaths: string[];
    statePaths: string[];
    protectedPaths: string[];
  }>;
}

export interface ReferenceObservationResult {
  bundle: WorkflowTraceBundle;
  traceHash: string;
}

interface FileSnapshot {
  sha256: string;
  bytes: number;
}

interface IsolationBoundaryProbe {
  signingKeyRead: "EPERM";
  networkDenied: "EPERM";
  nestedProcessDenied: "EPERM";
}

const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export function referenceObserverImplementationHash(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(modulePath);
  const observerRoot = path.dirname(modulePath);
  const sourceRoot = path.dirname(observerRoot);
  const components = [
    ["observer/referenceObserver", modulePath],
    ["observer/workflowTrace", path.join(observerRoot, `workflowTrace${extension}`)],
    ["observer/qualification", path.join(observerRoot, `qualification${extension}`)],
    [
      "evaluation/evaluationContract",
      path.join(sourceRoot, "evaluation", `evaluationContract${extension}`)
    ],
    ["utils/hash", path.join(sourceRoot, "utils", `hash${extension}`)],
    ["utils/redaction", path.join(sourceRoot, "utils", `redaction${extension}`)]
  ] as const;
  return sha256Text(
    stableJson({
      protocol: "awb-reference-observer-content/1",
      components: components.map(([id, componentPath]) => ({
        id,
        sha256: `sha256:${createHash("sha256")
          .update(readFileSync(componentPath))
          .digest("hex")}`
      }))
    })
  );
}

export async function observeWithReferenceObserver(options: {
  request: ReferenceObservationRequest;
  privateKeyPath: string;
  outputPath: string;
}): Promise<ReferenceObservationResult> {
  assertRequest(options.request);
  const privateKeyBytes = await readFile(options.privateKeyPath);
  const safeOutputPath = await assertSigningKeyIsolation(
    options.privateKeyPath,
    privateKeyBytes.toString("utf8"),
    options.outputPath,
    options.request
  );
  const privateKey = createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Reference Observer signing key must be an Ed25519 private key.");
  }
  const publicKey = createPublicKey(privateKey);
  const keyFingerprint = publicKeyFingerprint(publicKey);
  const observedCases = [];

  for (const observedCase of options.request.cases) {
    observedCases.push(
      await observeCase(
        observedCase,
        options.request.subject.contractHash,
        await realpath(options.privateKeyPath)
      )
    );
  }

  const unsigned = redactDeep({
    schemaVersion: "0.1.0" as const,
    observer: {
      id: options.request.observer.id,
      version: options.request.observer.version,
      keyFingerprint,
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: [...REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES]
    },
    subject: options.request.subject,
    cases: observedCases
  });
  const serialized = stableJson(unsigned);
  if (redactSensitiveText(serialized) !== serialized) {
    throw new Error("Reference Observer could not redact evidence before attestation.");
  }
  const signature = sign(null, Buffer.from(serialized), privateKey).toString("base64");
  const bundle: WorkflowTraceBundle = {
    ...unsigned,
    attestation: {
      algorithm: "ed25519",
      signature
    }
  };
  const traceBytes = `${JSON.stringify(bundle, null, 2)}\n`;
  await writeTraceArtifactAtomically(safeOutputPath, traceBytes);
  return {
    bundle,
    traceHash: sha256Text(traceBytes)
  };
}

async function observeCase(
  input: ReferenceObservationRequest["cases"][number],
  contractHash: string,
  privateKeyPath: string
): Promise<WorkflowTraceBundle["cases"][number]> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  const commandCwd = await realpath(input.command.cwd);
  assertWithin(workspaceRoot, commandCwd, "Runner cwd");
  const artifactPaths = input.artifactPaths.map((item) =>
    resolvePortablePath(workspaceRoot, item, "artifact")
  );
  const statePaths = input.statePaths.map((item) =>
    resolvePortablePath(workspaceRoot, item, "state")
  );
  const protectedPaths = input.protectedPaths.map((item) =>
    resolvePortablePath(workspaceRoot, item, "protected")
  );
  const homePath = path.join(workspaceRoot, ".awb-observer-home");
  const tempPath = path.join(workspaceRoot, ".awb-observer-tmp");
  await mkdir(homePath, { recursive: true });
  await mkdir(tempPath, { recursive: true });
  const before = await snapshotWorkspace(workspaceRoot);
  const events: RunEvent[] = [];
  let sequence = 0;
  const startedAt = Date.now();
  const push = (
    type: RunEvent["type"],
    payload: Record<string, unknown>,
    actor = "observer"
  ): void => {
    sequence += 1;
    events.push({
      eventId: `${input.runId}-${sequence}`,
      timestamp: new Date(startedAt + sequence).toISOString(),
      type,
      actor,
      payload
    });
  };

  push("case_start", { caseId: input.caseId, templateId: input.templateId });
  push("contract_observed", { contractHash });
  push("filesystem_access", {
    operation: "snapshot",
    root: "workspace://root",
    fileCount: before.size
  });
  for (const state of statePaths) {
    const relativePath = portableRelative(workspaceRoot, state);
    const stateEvidence = await fileEvidence(state);
    push("state_read", {
      path: relativePath,
      ...stateEvidence,
      observedBy: "reference_observer"
    });
  }
  push("side_effect_attempt", {
    attempted: false,
    policyDecision: "deny",
    allowed: false,
    classifiedAs: "none",
    observedBy: "reference_observer"
  });
  push("runner_start", {
    runner: path.basename(input.command.executable),
    executionMode: "live"
  });
  push("process_spawn", {
    executable: path.basename(input.command.executable),
    argsHash: sha256Text(stableJson(input.command.args.map(portableArgument))),
    cwd: "workspace://root",
    observedBy: "reference_observer"
  });
  push("tool_call", {
    tool: path.basename(input.command.executable),
    policyDecision: "allow",
    observedBy: "reference_observer"
  });

  const runnerEnvironment = buildRunnerEnvironment(
    workspaceRoot,
    input.caseId,
    homePath,
    tempPath,
    input.command.env
  );
  const isolated = await executeWithReferenceObserverBoundary({
    input,
    workspaceRoot,
    commandCwd,
    privateKeyPath,
    runnerEnvironment
  });
  const { execution, boundaryProbe, boundaryProfileHash } = isolated;
  push("filesystem_access", {
    operation: "read_probe",
    resource: "observer-signing-key",
    attempted: true,
    allowed: false,
    outcomeCode: boundaryProbe.signingKeyRead,
    policyDecision: "deny",
    policy: "deny_default",
    boundary: "macos-seatbelt",
    boundaryProfileHash,
    observedBy: "reference_observer"
  });
  push("network_access", {
    attempted: true,
    allowed: false,
    outcomeCode: boundaryProbe.networkDenied,
    policyDecision: "deny",
    policy: "deny_default",
    boundary: "macos-seatbelt",
    boundaryProfileHash,
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("process_spawn", {
    executable: "observer-boundary-canary",
    attempted: true,
    allowed: false,
    outcomeCode: boundaryProbe.nestedProcessDenied,
    policyDecision: "deny",
    boundary: "macos-seatbelt",
    boundaryProfileHash,
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("tool_call", {
    tool: "observer-boundary-canary",
    attempted: true,
    allowed: false,
    outcomeCode: boundaryProbe.nestedProcessDenied,
    policyDecision: "deny",
    boundary: "macos-seatbelt",
    boundaryProfileHash,
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  if (execution.stdout) {
    push("runner_transcript", {
      stream: "stdout",
      text: redactSensitiveText(execution.stdout)
    });
  }
  if (execution.stderr) {
    push("runner_transcript", {
      stream: "stderr",
      text: redactSensitiveText(execution.stderr)
    });
  }

  const after = await snapshotWorkspace(workspaceRoot);
  const changedPaths = changedFiles(before, after);
  for (const relativePath of changedPaths) {
    const evidence = after.get(relativePath);
    push("filesystem_access", {
      operation: before.has(relativePath) ? "modify" : "create",
      path: relativePath,
      ...(evidence ?? {}),
      observedBy: "reference_observer"
    });
  }

  const hardFailureCodes: string[] = [];
  for (const artifact of artifactPaths) {
    const relativePath = portableRelative(workspaceRoot, artifact);
    const evidence = await optionalFileEvidence(artifact);
    if (!evidence) {
      hardFailureCodes.push("ARTIFACT_PATH_DRIFT");
      push("hard_failure", {
        code: "ARTIFACT_PATH_DRIFT",
        severity: "P0",
        why: `Required artifact ${relativePath} was not observed.`
      });
      continue;
    }
    push("artifact_write", {
      path: relativePath,
      ...evidence,
      observedBy: "reference_observer"
    });
  }
  for (const protectedPath of protectedPaths) {
    const relativePath = portableRelative(workspaceRoot, protectedPath);
    const touched = changedPaths.some(
      (item) => item === relativePath || item.startsWith(`${relativePath}/`)
    );
    if (touched) {
      hardFailureCodes.push("PRODUCTION_SIDE_EFFECT");
      push("side_effect_attempt", {
        attempted: true,
        policyDecision: "deny",
        allowed: true,
        path: relativePath,
        classifiedAs: "production_write",
        observedBy: "reference_observer"
      });
      push("hard_failure", {
        code: "PRODUCTION_SIDE_EFFECT",
        severity: "P0",
        why: `Protected path ${relativePath} changed.`
      });
    }
  }

  const outputBytes =
    Buffer.byteLength(execution.stdout ?? "") + Buffer.byteLength(execution.stderr ?? "");
  const estimatedOutputTokens = Math.ceil(outputBytes / 4);
  push("runner_result", {
    verdict:
      execution.exitCode === 0 && hardFailureCodes.length === 0 ? "PASS" : "FAIL",
    hardFailureCodes
  });
  push("runner_exit", {
    exitCode: execution.exitCode ?? 1,
    timedOut: execution.timedOut
  });
  push("token_usage", {
    input: 0,
    output: estimatedOutputTokens,
    total: estimatedOutputTokens,
    wasted: 0,
    source: "estimated",
    observedBy: "reference_observer"
  });
  push("case_end", {
    status:
      execution.exitCode === 0 && hardFailureCodes.length === 0
        ? "completed"
        : "failed"
  });

  return {
    caseId: input.caseId,
    templateId: input.templateId,
    runId: input.runId,
    events,
    wallClockSeconds: Math.max(0, (Date.now() - startedAt) / 1_000),
    tokens: {
      input: 0,
      output: estimatedOutputTokens,
      total: estimatedOutputTokens,
      wasted: 0,
      costEstimateConfidence: "low"
    },
    telemetryCompleteness: 1
  };
}

function buildRunnerEnvironment(
  workspaceRoot: string,
  caseId: string,
  homePath: string,
  tempPath: string,
  requested: Record<string, string> | undefined
): Record<string, string> {
  const safe: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homePath,
    TMPDIR: tempPath,
    LANG: process.env.LANG ?? "C.UTF-8",
    AWB_OBSERVED_WORKSPACE: workspaceRoot,
    AWB_OBSERVED_CASE_ID: caseId
  };
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (/(private|secret|token|credential|signing|observer.*key|key.*observer)/iu.test(key)) {
      throw new Error(`Runner environment key ${key} is forbidden by Observer isolation.`);
    }
    if (/PRIVATE KEY/iu.test(value)) {
      throw new Error(`Runner environment value for ${key} contains private key material.`);
    }
    safe[key] = value;
  }
  return safe;
}

async function executeWithReferenceObserverBoundary(options: {
  input: ReferenceObservationRequest["cases"][number];
  workspaceRoot: string;
  commandCwd: string;
  privateKeyPath: string;
  runnerEnvironment: Record<string, string>;
}) {
  await assertReferenceObserverIsolationAvailable();
  const runnerExecutable = await resolveExecutable(
    options.input.command.executable,
    options.runnerEnvironment.PATH
  );
  const observerExecutable = await realpath(process.execPath);
  const probeProfile = buildMacosSeatbeltProfile({
    workspaceRoot: options.workspaceRoot,
    privateKeyPath: options.privateKeyPath,
    executablePaths: [observerExecutable],
    readablePaths: []
  });
  const boundaryProbe = await runIsolationBoundaryProbe({
    profile: probeProfile,
    observerExecutable,
    privateKeyPath: options.privateKeyPath,
    cwd: options.commandCwd,
    environment: options.runnerEnvironment
  });
  const runnerProfile = buildMacosSeatbeltProfile({
    workspaceRoot: options.workspaceRoot,
    privateKeyPath: options.privateKeyPath,
    executablePaths: [runnerExecutable],
    readablePaths: await Promise.all(
      options.input.command.args
        .filter((value) => path.isAbsolute(value))
        .map((value) => canonicalPath(value))
    )
  });
  const execution = await execa(
    MACOS_SANDBOX_EXECUTABLE,
    ["-p", runnerProfile, runnerExecutable, ...options.input.command.args],
    {
      cwd: options.commandCwd,
      env: options.runnerEnvironment,
      extendEnv: false,
      reject: false,
      timeout: 30_000
    }
  );
  if (
    execution.exitCode === 71 &&
    /sandbox-exec|sandbox_apply/iu.test(execution.stderr ?? "")
  ) {
    throw new Error(
      "Reference Observer could not apply the macOS Seatbelt Runner boundary."
    );
  }
  return {
    execution,
    boundaryProbe,
    boundaryProfileHash: sha256Text(runnerProfile)
  };
}

export async function assertReferenceObserverIsolationAvailable(
  options: {
    platform?: NodeJS.Platform;
    sandboxExecutable?: string;
  } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const sandboxExecutable =
    options.sandboxExecutable ?? MACOS_SANDBOX_EXECUTABLE;
  if (platform !== "darwin") {
    throw new Error(
      "Reference Observer qualification requires the macOS Seatbelt isolation backend; no supported Runner boundary is available on this platform."
    );
  }
  try {
    await access(sandboxExecutable, constants.X_OK);
  } catch {
    throw new Error(
      "Reference Observer qualification requires an executable sandbox-exec isolation backend."
    );
  }
}

async function resolveExecutable(
  executable: string,
  pathValue: string | undefined
): Promise<string> {
  if (path.isAbsolute(executable)) {
    return realpath(executable);
  }
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, executable);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the explicitly supplied PATH without invoking a shell.
    }
  }
  throw new Error(
    `Reference Observer could not resolve Runner executable ${executable}.`
  );
}

function buildMacosSeatbeltProfile(options: {
  workspaceRoot: string;
  privateKeyPath: string;
  executablePaths: string[];
  readablePaths: string[];
}): string {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const executablePaths = [
    ...new Set(options.executablePaths.map((item) => path.resolve(item)))
  ];
  const readablePaths = [
    workspaceRoot,
    ...executablePaths,
    ...options.readablePaths.map((item) => path.resolve(item))
  ];
  const literalReadPaths = new Set<string>();
  const subpathReadPaths = new Set<string>([workspaceRoot]);
  for (const readablePath of readablePaths) {
    for (const ancestor of pathAncestors(readablePath)) {
      literalReadPaths.add(ancestor);
    }
  }
  for (const executablePath of executablePaths) {
    const runtimeRoot = executableRuntimeRoot(executablePath);
    subpathReadPaths.add(runtimeRoot);
    for (const ancestor of pathAncestors(runtimeRoot)) {
      literalReadPaths.add(ancestor);
    }
    const cellarIndex = executablePath.indexOf(`${path.sep}Cellar${path.sep}`);
    if (cellarIndex >= 0) {
      const packagePrefix = executablePath.slice(0, cellarIndex);
      for (const relativePath of ["Cellar", "opt", "etc"]) {
        const dependencyRoot = path.join(packagePrefix, relativePath);
        subpathReadPaths.add(dependencyRoot);
        for (const ancestor of pathAncestors(dependencyRoot)) {
          literalReadPaths.add(ancestor);
        }
      }
    }
  }
  const readFilters = [
    ...[...literalReadPaths].sort().map(seatbeltLiteral),
    ...[...subpathReadPaths].sort().map(seatbeltSubpath)
  ];
  const executableFilters = executablePaths
    .sort()
    .map(seatbeltLiteral);
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow sysctl-read)",
    `(allow file-read* ${readFilters.join(" ")})`,
    `(allow file-write* ${seatbeltSubpath(workspaceRoot)})`,
    "(deny network*)",
    `(allow process-exec ${executableFilters.join(" ")})`,
    `(deny file-read* ${seatbeltLiteral(path.resolve(options.privateKeyPath))})`
  ].join("\n");
}

function pathAncestors(filePath: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(filePath);
  while (current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  return ancestors;
}

function executableRuntimeRoot(executablePath: string): string {
  const cellarMarker = `${path.sep}Cellar${path.sep}`;
  const cellarIndex = executablePath.indexOf(cellarMarker);
  if (cellarIndex >= 0) {
    const afterCellar = executablePath.slice(cellarIndex + cellarMarker.length);
    const [packageName, version] = afterCellar.split(path.sep);
    if (packageName && version) {
      return path.join(
        executablePath.slice(0, cellarIndex),
        "Cellar",
        packageName,
        version
      );
    }
  }
  return path.dirname(executablePath);
}

function seatbeltLiteral(value: string): string {
  return `(literal "${escapeSeatbeltString(value)}")`;
}

function seatbeltSubpath(value: string): string {
  return `(subpath "${escapeSeatbeltString(value)}")`;
}

function escapeSeatbeltString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function runIsolationBoundaryProbe(options: {
  profile: string;
  observerExecutable: string;
  privateKeyPath: string;
  cwd: string;
  environment: Record<string, string>;
}): Promise<IsolationBoundaryProbe> {
  const probeSource = [
    'const { readFile } = require("node:fs/promises");',
    'const { spawnSync } = require("node:child_process");',
    'const net = require("node:net");',
    "(async () => {",
    '  let signingKeyRead = "READABLE";',
    "  try { await readFile(process.argv[1]); }",
    '  catch (error) { signingKeyRead = error?.code ?? "UNKNOWN"; }',
    "  const networkDenied = await new Promise((resolve) => {",
    '    const socket = net.connect({ host: "127.0.0.1", port: 9 });',
    '    socket.once("connect", () => { socket.destroy(); resolve("CONNECTED"); });',
    '    socket.once("error", (error) => resolve(error?.code ?? "UNKNOWN"));',
    "  });",
    '  const nested = spawnSync("/bin/echo", ["observer-boundary-canary"]);',
    "  const nestedProcessDenied =",
    '    nested.error?.code ?? (nested.status === 0 ? "ALLOWED" : "UNKNOWN");',
    "  process.stdout.write(JSON.stringify({",
    "    signingKeyRead, networkDenied, nestedProcessDenied",
    "  }));",
    "})().catch((error) => {",
    "  process.stderr.write(String(error));",
    "  process.exit(1);",
    "});"
  ].join("\n");
  const result = await execa(
    MACOS_SANDBOX_EXECUTABLE,
    [
      "-p",
      options.profile,
      options.observerExecutable,
      "-e",
      probeSource,
      options.privateKeyPath
    ],
    {
      cwd: options.cwd,
      env: options.environment,
      extendEnv: false,
      reject: false,
      timeout: 10_000
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Reference Observer isolation boundary probe failed closed: ${redactSensitiveText(
        result.stderr || `exit ${result.exitCode}`
      )}`
    );
  }
  let probe: Partial<IsolationBoundaryProbe>;
  try {
    probe = JSON.parse(result.stdout) as Partial<IsolationBoundaryProbe>;
  } catch {
    throw new Error(
      "Reference Observer isolation boundary probe returned invalid evidence."
    );
  }
  if (
    probe.signingKeyRead !== "EPERM" ||
    probe.networkDenied !== "EPERM" ||
    probe.nestedProcessDenied !== "EPERM"
  ) {
    throw new Error(
      "Reference Observer isolation boundary did not deny signing-key, network, and nested-process canaries."
    );
  }
  return probe as IsolationBoundaryProbe;
}

async function snapshotWorkspace(root: string): Promise<Map<string, FileSnapshot>> {
  const matches = await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: [".git/**", "node_modules/**"]
  });
  const snapshot = new Map<string, FileSnapshot>();
  for (const relativePath of matches.sort()) {
    const absolutePath = path.join(root, relativePath);
    snapshot.set(relativePath.split(path.sep).join("/"), await fileEvidence(absolutePath));
  }
  return snapshot;
}

function changedFiles(
  before: Map<string, FileSnapshot>,
  after: Map<string, FileSnapshot>
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((item) => stableJson(before.get(item)) !== stableJson(after.get(item)))
    .sort();
}

async function fileEvidence(filePath: string): Promise<FileSnapshot> {
  const bytes = await readFile(filePath);
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length
  };
}

async function optionalFileEvidence(
  filePath: string
): Promise<FileSnapshot | undefined> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? await fileEvidence(filePath) : undefined;
  } catch {
    return undefined;
  }
}

function resolvePortablePath(root: string, value: string, label: string): string {
  if (path.isAbsolute(value)) {
    throw new Error(`Reference Observer ${label} path must be workspace-relative.`);
  }
  const resolved = path.resolve(root, value);
  assertWithin(root, resolved, `Reference Observer ${label} path`);
  return resolved;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the observed workspace.`);
  }
}

function portableRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function portableArgument(value: string): string {
  return path.isAbsolute(value) ? `external://${path.basename(value)}` : value;
}

function publicKeyFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactDeep(item)
      ])
    ) as T;
  }
  return value;
}

function assertRequest(request: ReferenceObservationRequest): void {
  if (
    !request ||
    request.schemaVersion !== "0.1.0" ||
    !request.observer?.id ||
    !request.observer.version ||
    !request.subject ||
    !Array.isArray(request.cases) ||
    request.cases.length === 0
  ) {
    throw new Error("Reference Observer request is missing required fields.");
  }
  const caseIds = request.cases.map((item) => item.caseId);
  if (caseIds.some((item) => !item) || new Set(caseIds).size !== caseIds.length) {
    throw new Error("Reference Observer request contains duplicate or empty case ids.");
  }
}

async function assertSigningKeyIsolation(
  privateKeyPath: string,
  privateKeyPem: string,
  outputPath: string,
  request: ReferenceObservationRequest
): Promise<string> {
  const resolvedKeyPath = await realpath(privateKeyPath);
  const repositoryRoot = await realpath(getBenchmarkRoot());
  const lexicalOutputPath = path.resolve(outputPath);
  const lexicalOutputRoot = path.dirname(lexicalOutputPath);
  const outputRoot = await canonicalPath(path.dirname(outputPath));
  const resolvedOutputPath = await canonicalPath(outputPath);
  const outputFileName = path.basename(lexicalOutputPath);
  if (!outputFileName || outputFileName === "." || outputFileName === "..") {
    throw new Error("Observer trace output must name a file.");
  }
  const keyInfo = await stat(resolvedKeyPath);
  const privateKeyBytes = Buffer.from(privateKeyPem.trim());
  const scannedWorkspaces = new Set<string>();
  if (isWithin(repositoryRoot, resolvedKeyPath)) {
    throw new Error(
      "Observer private key must not be stored inside the benchmark repository."
    );
  }
  if (isWithin(outputRoot, resolvedKeyPath)) {
    throw new Error(
      "Observer private key must not be stored inside the trace artifact directory."
    );
  }
  if (resolvedOutputPath === resolvedKeyPath) {
    throw new Error(
      "Observer trace output must not resolve to the signing key."
    );
  }
  try {
    const outputLinkInfo = await lstat(outputPath);
    if (outputLinkInfo.isSymbolicLink()) {
      throw new Error(
        "Observer trace output must not be an existing symlink, including one to the signing key."
      );
    }
    const outputInfo = await stat(outputPath);
    if (
      outputInfo.dev === keyInfo.dev &&
      outputInfo.ino === keyInfo.ino
    ) {
      throw new Error(
        "Observer trace output must not be a hard link to the signing key."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  for (const observedCase of request.cases) {
    const lexicalWorkspaceRoot = path.resolve(observedCase.workspaceRoot);
    const workspaceRoot = await canonicalPath(observedCase.workspaceRoot);
    if (
      isWithin(lexicalWorkspaceRoot, lexicalOutputRoot) ||
      isWithin(lexicalWorkspaceRoot, lexicalOutputPath) ||
      isWithin(workspaceRoot, outputRoot) ||
      isWithin(workspaceRoot, resolvedOutputPath)
    ) {
      throw new Error(
        "Observer trace output must be outside every Runner workspace."
      );
    }
    if (isWithin(workspaceRoot, resolvedKeyPath)) {
      throw new Error(
        "Observer private key must not be stored inside a Runner workspace."
      );
    }
    if (!scannedWorkspaces.has(workspaceRoot)) {
      await assertNoPrivateKeyMaterialInWorkspace(
        workspaceRoot,
        privateKeyBytes
      );
      scannedWorkspaces.add(workspaceRoot);
    }
    const runnerInputs = [
      observedCase.command.executable,
      ...observedCase.command.args,
      ...Object.values(observedCase.command.env ?? {})
    ];
    if (
      runnerInputs.some(
        (value) =>
          value.includes(resolvedKeyPath) ||
          value.includes(privateKeyPem.trim()) ||
          /PRIVATE KEY/iu.test(value)
      )
    ) {
      throw new Error(
        "Observer private key material or path must not be passed to the Runner."
      );
    }
    for (const runnerPath of [
      observedCase.command.executable,
      ...observedCase.command.args
    ].filter((value) => path.isAbsolute(value))) {
      const candidate = await canonicalPath(runnerPath);
      let info;
      try {
        info = await stat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (
        info.isFile() &&
        info.size >= privateKeyBytes.length &&
        (await fileContainsBytes(candidate, privateKeyBytes))
      ) {
        throw new Error(
          "Observer private key material must not be present in Runner executable inputs."
        );
      }
    }
  }
  return path.join(outputRoot, outputFileName);
}

async function writeTraceArtifactAtomically(
  outputPath: string,
  contents: string
): Promise<void> {
  const outputDirectory = path.dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, contents, {
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function assertNoPrivateKeyMaterialInWorkspace(
  workspaceRoot: string,
  privateKeyBytes: Buffer
): Promise<void> {
  const matches = await fg("**/*", {
    cwd: workspaceRoot,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false
  });
  for (const relativePath of matches) {
    const candidate = path.join(workspaceRoot, relativePath);
    const info = await stat(candidate);
    if (
      info.size >= privateKeyBytes.length &&
      (await fileContainsBytes(candidate, privateKeyBytes))
    ) {
      throw new Error(
        "Observer private key material must not be present in a Runner workspace."
      );
    }
  }
}

async function fileContainsBytes(
  filePath: string,
  needle: Buffer
): Promise<boolean> {
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const searchable = Buffer.concat([carry, bytes]);
    if (searchable.indexOf(needle) >= 0) {
      return true;
    }
    carry = searchable.subarray(
      Math.max(0, searchable.length - needle.length + 1)
    );
  }
  return false;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    const parent = path.dirname(value);
    if (parent === value) {
      return path.resolve(value);
    }
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}
