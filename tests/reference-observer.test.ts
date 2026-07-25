import { generateKeyPairSync } from "node:crypto";
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { RunEvent } from "../src/core/types.js";
import { getBenchmarkRoot } from "../src/core/targetRegistry.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  assertReferenceObserverIsolationAvailable,
  observeWithReferenceObserver,
  referenceObserverImplementationHash
} from "../src/observer/referenceObserver.js";
import { verifyWorkflowTraceBundle } from "../src/observer/workflowTrace.js";
import {
  hashFile,
  sha256Text,
  stableJson
} from "../src/utils/hash.js";

let root = "";

describe("reference workflow-trace Observer", () => {
  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates the signing key, redacts before signing, and emits every evidence family", async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-reference-observer-"));
    const workspaceRoot = path.join(root, "workspace");
    const secretRoot = path.join(root, "secrets");
    const outputRoot = path.join(root, "output");
    const artifactPath = path.join(workspaceRoot, "artifacts", "result.json");
    const statePath = path.join(workspaceRoot, "state", "workflow.json");
    const runnerEnvironmentPath = path.join(workspaceRoot, "artifacts", "runner-environment.json");
    const isolationProbePath = path.join(
      workspaceRoot,
      "artifacts",
      "isolation-probe.json"
    );
    const runnerPath = path.join(workspaceRoot, "fixture-runner.mjs");
    const tracePath = path.join(outputRoot, "workflow-trace.json");
    const privateKeyPath = path.join(secretRoot, "observer-private.pem");
    const publicKeyPath = path.join(secretRoot, "observer-public.pem");
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    await mkdir(path.dirname(statePath), { recursive: true });
    await mkdir(secretRoot, { recursive: true });
    await writeFile(statePath, '{"status":"ready"}\n');
    await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
    await writeFile(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    await symlink(
      privateKeyPath,
      path.join(workspaceRoot, "observer-key-symlink.pem")
    );
    await writeFile(
      runnerPath,
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { link, readFile } from "node:fs/promises";',
        'import { spawnSync } from "node:child_process";',
        'import net from "node:net";',
        'import path from "node:path";',
        "const workspace = process.env.AWB_OBSERVED_WORKSPACE;",
        'await mkdir(path.join(workspace, "artifacts"), { recursive: true });',
        'await writeFile(path.join(workspace, "artifacts", "result.json"), "{\\"ok\\":true}\\n");',
        'await writeFile(path.join(process.env.HOME, "runner-home.txt"), "home-write\\n");',
        'await writeFile(path.join(process.env.TMPDIR, "runner-temp.txt"), "temp-write\\n");',
        "const visible = Object.fromEntries(",
        "  Object.entries(process.env).filter(([key]) => /observer|private|signing|key/i.test(key))",
        ");",
        'await writeFile(path.join(workspace, "artifacts", "runner-environment.json"), JSON.stringify(visible));',
        'let signingKeyRead = "READABLE";',
        "try {",
        '  await readFile(path.resolve(workspace, "../secrets/observer-private.pem"));',
        "} catch (error) {",
        '  signingKeyRead = error?.code ?? "UNKNOWN";',
        "}",
        'let signingKeySymlinkRead = "READABLE";',
        "try {",
        '  await readFile(path.join(workspace, "observer-key-symlink.pem"));',
        "} catch (error) {",
        '  signingKeySymlinkRead = error?.code ?? "UNKNOWN";',
        "}",
        'let signingKeyHardLinkRead = "READABLE";',
        "try {",
        "  await link(",
        '    path.resolve(workspace, "../secrets/observer-private.pem"),',
        '    path.join(workspace, "artifacts", "linked-observer-key.pem")',
        "  );",
        '  await readFile(path.join(workspace, "artifacts", "linked-observer-key.pem"));',
        "} catch (error) {",
        '  signingKeyHardLinkRead = error?.code ?? "UNKNOWN";',
        "}",
        "const networkDenied = await new Promise((resolve) => {",
        '  const socket = net.connect({ host: "127.0.0.1", port: 9 });',
        '  socket.once("connect", () => { socket.destroy(); resolve("CONNECTED"); });',
        '  socket.once("error", (error) => resolve(error?.code ?? "UNKNOWN"));',
        "});",
        'const nested = spawnSync("/bin/echo", ["observer-isolation-probe"]);',
        "await writeFile(",
        '  path.join(workspace, "artifacts", "isolation-probe.json"),',
        "  JSON.stringify({",
        "    signingKeyRead,",
        "    signingKeySymlinkRead,",
        "    signingKeyHardLinkRead,",
        "    networkDenied,",
        '    nestedProcessDenied: nested.error?.code ?? (nested.status === 0 ? "ALLOWED" : "UNKNOWN")',
        "  })",
        ");",
        'process.stdout.write(["Authorization: ", "Be", "arer fixture-secret-token\\n"].join(""));'
      ].join("\n")
    );

    const result = await observeWithReferenceObserver({
      privateKeyPath,
      outputPath: tracePath,
      request: {
        schemaVersion: "0.1.0",
        observer: {
          id: "awb-reference-observer",
          version: "1.0.0"
        },
        subject: {
          targetId: "fixture-target",
          contractHash: `sha256:${"a".repeat(64)}`,
          suite: "qualification",
          seed: "reference-observer-test",
          caseSetHash: `sha256:${"b".repeat(64)}`,
          runner: {
            name: "codex",
            adapterVersion: "fixture-runner-1",
            version: "fixture",
            capabilitiesHash: `sha256:${"c".repeat(64)}`
          },
          isolation: "read_only_sandbox",
          permissionMode: "read_only_no_approval",
          model: "fixture-model"
        },
        cases: [
          {
            caseId: "known-good",
            templateId: "observer-qualification",
            runId: "known-good-run",
            workspaceRoot,
            command: {
              executable: process.execPath,
              args: [
                runnerPath,
                path.join(workspaceRoot, "artifacts", "future-output.json")
              ],
              cwd: workspaceRoot
            },
            artifactPaths: [
              "artifacts/result.json",
              "artifacts/runner-environment.json",
              "artifacts/isolation-probe.json"
            ],
            statePaths: ["state/workflow.json"],
            protectedPaths: ["protected"]
          }
        ]
      }
    });

    expect(result.bundle.observer).toMatchObject({
      id: "awb-reference-observer",
      version: "1.0.0",
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES
    });
    const eventTypes = new Set(result.bundle.cases[0]!.events.map((event) => event.type));
    for (const eventType of [
      "filesystem_access",
      "tool_call",
      "process_spawn",
      "network_access",
      "artifact_write",
      "state_read",
      "side_effect_attempt",
      "token_usage"
    ]) {
      expect(eventTypes.has(eventType as RunEvent["type"])).toBe(true);
    }

    const serializedTrace = await readFile(tracePath, "utf8");
    expect(serializedTrace).not.toContain("fixture-secret-token");
    expect(serializedTrace).not.toContain(privatePem.trim());
    expect(serializedTrace).not.toContain(privateKeyPath);
    expect(JSON.parse(await readFile(runnerEnvironmentPath, "utf8"))).toEqual({});
    expect(JSON.parse(await readFile(isolationProbePath, "utf8"))).toEqual({
      signingKeyRead: "EPERM",
      signingKeySymlinkRead: "EPERM",
      signingKeyHardLinkRead: "EPERM",
      networkDenied: "EPERM",
      nestedProcessDenied: "EPERM"
    });
    expect(
      result.bundle.cases[0]!.events.find(
        (event) =>
          event.type === "network_access" &&
          event.payload.attempted === true
      )
    ).toMatchObject({
      actor: "observer",
      payload: {
        allowed: false,
        policyDecision: "deny",
        observedBy: "reference_observer"
      }
    });
    expect(
      result.bundle.cases[0]!.events.find(
        (event) =>
          event.type === "tool_call" &&
          event.payload.attempted === true
      )
    ).toMatchObject({
      actor: "observer",
      payload: {
        allowed: false,
        policyDecision: "deny",
        observedBy: "reference_observer"
      }
    });
    expect(
      result.bundle.cases[0]!.events.filter(
        (event) => event.type === "filesystem_access"
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "observer",
          payload: expect.objectContaining({
            operation: "create",
            path: ".awb-observer-home/runner-home.txt",
            observedBy: "reference_observer"
          })
        }),
        expect.objectContaining({
          actor: "observer",
          payload: expect.objectContaining({
            operation: "create",
            path: ".awb-observer-tmp/runner-temp.txt",
            observedBy: "reference_observer"
          })
        })
      ])
    );

    await expect(
      verifyWorkflowTraceBundle(tracePath, publicKeyPath, {
        targetId: "fixture-target",
        contractHash: `sha256:${"a".repeat(64)}`,
        suite: "qualification",
        seed: "reference-observer-test",
        caseSetHash: `sha256:${"b".repeat(64)}`,
        caseIds: ["known-good"],
        cases: [{ id: "known-good", templateId: "observer-qualification" }]
      })
    ).resolves.toMatchObject({
      keyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      eventCount: expect.any(Number)
    });
    await expect(
      verifyWorkflowTraceBundle(tracePath, publicKeyPath, {
        targetId: "fixture-target",
        contractHash: `sha256:${"a".repeat(64)}`,
        suite: "qualification",
        seed: "different-study-seed",
        caseSetHash: `sha256:${"b".repeat(64)}`,
        caseIds: ["known-good"],
        cases: [{ id: "known-good", templateId: "observer-qualification" }]
      })
    ).rejects.toThrow("Workflow trace seed does not match");
  }, 30_000);

  test("refuses a signing key stored inside the Runner workspace", async () => {
    const isolatedRoot = await mkdtemp(
      path.join(tmpdir(), "awb-reference-observer-key-boundary-")
    );
    try {
      const workspaceRoot = path.join(isolatedRoot, "workspace");
      const privateKeyPath = path.join(
        workspaceRoot,
        "observer-private.pem"
      );
      const keys = generateKeyPairSync("ed25519");
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(
        privateKeyPath,
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 }
      );
      await expect(
        observeWithReferenceObserver({
          privateKeyPath,
          outputPath: path.join(isolatedRoot, "output", "trace.json"),
          request: {
            schemaVersion: "0.1.0",
            observer: { id: "fixture", version: "1.0.0" },
            subject: {
              targetId: "fixture-target",
              contractHash: `sha256:${"a".repeat(64)}`,
              suite: "qualification",
              seed: "reference-observer-test",
              caseSetHash: `sha256:${"b".repeat(64)}`,
              runner: {
                name: "codex",
                adapterVersion: "fixture",
                capabilitiesHash: `sha256:${"c".repeat(64)}`
              },
              isolation: "read_only_sandbox",
              permissionMode: "read_only_no_approval"
            },
            cases: [
              {
                caseId: "key-boundary",
                templateId: "observer-qualification",
                runId: "key-boundary",
                workspaceRoot,
                command: {
                  executable: process.execPath,
                  args: ["--version"],
                  cwd: workspaceRoot
                },
                artifactPaths: [],
                statePaths: [],
                protectedPaths: []
              }
            ]
          }
        })
      ).rejects.toThrow(/Runner workspace/iu);
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("refuses a trace output path controlled by the Runner workspace", async () => {
    const isolatedRoot = await mkdtemp(
      path.join(tmpdir(), "awb-reference-observer-output-boundary-")
    );
    try {
      const workspaceRoot = path.join(isolatedRoot, "workspace");
      const secretRoot = path.join(isolatedRoot, "secrets");
      const victimPath = path.join(isolatedRoot, "victim.json");
      const outputPath = path.join(workspaceRoot, "workflow-trace.json");
      const privateKeyPath = path.join(secretRoot, "observer-private.pem");
      const keys = generateKeyPairSync("ed25519");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(secretRoot, { recursive: true });
      await writeFile(
        privateKeyPath,
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 }
      );
      await symlink(victimPath, outputPath);

      await expect(
        observeWithReferenceObserver({
          privateKeyPath,
          outputPath,
          request: {
            schemaVersion: "0.1.0",
            observer: { id: "fixture", version: "1.0.0" },
            subject: {
              targetId: "fixture-target",
              contractHash: `sha256:${"a".repeat(64)}`,
              suite: "qualification",
              seed: "reference-observer-test",
              caseSetHash: `sha256:${"b".repeat(64)}`,
              runner: {
                name: "codex",
                adapterVersion: "fixture",
                capabilitiesHash: `sha256:${"c".repeat(64)}`
              },
              isolation: "read_only_sandbox",
              permissionMode: "read_only_no_approval"
            },
            cases: [
              {
                caseId: "output-boundary",
                templateId: "observer-qualification",
                runId: "output-boundary",
                workspaceRoot,
                command: {
                  executable: process.execPath,
                  args: ["--version"],
                  cwd: workspaceRoot
                },
                artifactPaths: [],
                statePaths: [],
                protectedPaths: []
              }
            ]
          }
        })
      ).rejects.toThrow(
        /trace output.*(?:Runner workspace|existing symlink)/iu
      );
      await expect(readFile(victimPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hard-link"] as const)(
    "refuses a trace output %s to the signing key",
    async (exposure) => {
      const isolatedRoot = await mkdtemp(
        path.join(
          tmpdir(),
          `awb-reference-observer-output-${exposure}-key-boundary-`
        )
      );
      try {
        const workspaceRoot = path.join(isolatedRoot, "workspace");
        const secretRoot = path.join(isolatedRoot, "secrets");
        const outputRoot = path.join(isolatedRoot, "output");
        const privateKeyPath = path.join(secretRoot, "observer-private.pem");
        const outputPath = path.join(outputRoot, "workflow-trace.json");
        const keys = generateKeyPairSync("ed25519");
        const privatePem = keys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString();
        await mkdir(workspaceRoot, { recursive: true });
        await mkdir(secretRoot, { recursive: true });
        await mkdir(outputRoot, { recursive: true });
        await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
        if (exposure === "symlink") {
          await symlink(privateKeyPath, outputPath);
        } else {
          await link(privateKeyPath, outputPath);
        }

        await expect(
          observeWithReferenceObserver({
            privateKeyPath,
            outputPath,
            request: {
              schemaVersion: "0.1.0",
              observer: { id: "fixture", version: "1.0.0" },
              subject: {
                targetId: "fixture-target",
                contractHash: `sha256:${"a".repeat(64)}`,
                suite: "qualification",
                seed: "reference-observer-test",
                caseSetHash: `sha256:${"b".repeat(64)}`,
                runner: {
                  name: "codex",
                  adapterVersion: "fixture",
                  capabilitiesHash: `sha256:${"c".repeat(64)}`
                },
                isolation: "read_only_sandbox",
                permissionMode: "read_only_no_approval"
              },
              cases: [
                {
                  caseId: `output-${exposure}-key-boundary`,
                  templateId: "observer-qualification",
                  runId: `output-${exposure}-key-boundary`,
                  workspaceRoot,
                  command: {
                    executable: process.execPath,
                    args: ["--version"],
                    cwd: workspaceRoot
                  },
                  artifactPaths: [],
                  statePaths: [],
                  protectedPaths: []
                }
              ]
            }
          })
        ).rejects.toThrow(/trace output.*signing key|same file|hard link/iu);
        expect(await readFile(privateKeyPath, "utf8")).toBe(privatePem);
      } finally {
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    }
  );

  test("refuses a Runner-controlled parent symlink before execution", async () => {
    const isolatedRoot = await mkdtemp(
      path.join(tmpdir(), "awb-reference-observer-parent-symlink-boundary-")
    );
    try {
      const workspaceRoot = path.join(isolatedRoot, "workspace");
      const secretRoot = path.join(isolatedRoot, "secrets");
      const safeOutputRoot = path.join(isolatedRoot, "safe-output");
      const parentLink = path.join(workspaceRoot, "output-link");
      const outputPath = path.join(parentLink, "observer-private.pem");
      const privateKeyPath = path.join(secretRoot, "observer-private.pem");
      const runnerMarkerPath = path.join(workspaceRoot, "runner-started");
      const runnerPath = path.join(workspaceRoot, "retarget-runner.mjs");
      const keys = generateKeyPairSync("ed25519");
      const privatePem = keys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(secretRoot, { recursive: true });
      await mkdir(safeOutputRoot, { recursive: true });
      await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
      await symlink(safeOutputRoot, parentLink);
      await writeFile(
        runnerPath,
        [
          'import { rm, symlink, writeFile } from "node:fs/promises";',
          `await writeFile(${JSON.stringify(runnerMarkerPath)}, "started\\n");`,
          `await rm(${JSON.stringify(parentLink)});`,
          `await symlink(${JSON.stringify(secretRoot)}, ${JSON.stringify(
            parentLink
          )});`
        ].join("\n")
      );

      await expect(
        observeWithReferenceObserver({
          privateKeyPath,
          outputPath,
          request: {
            schemaVersion: "0.1.0",
            observer: { id: "fixture", version: "1.0.0" },
            subject: {
              targetId: "fixture-target",
              contractHash: `sha256:${"a".repeat(64)}`,
              suite: "qualification",
              seed: "reference-observer-test",
              caseSetHash: `sha256:${"b".repeat(64)}`,
              runner: {
                name: "codex",
                adapterVersion: "fixture",
                capabilitiesHash: `sha256:${"c".repeat(64)}`
              },
              isolation: "read_only_sandbox",
              permissionMode: "read_only_no_approval"
            },
            cases: [
              {
                caseId: "parent-symlink-boundary",
                templateId: "observer-qualification",
                runId: "parent-symlink-boundary",
                workspaceRoot,
                command: {
                  executable: process.execPath,
                  args: [runnerPath],
                  cwd: workspaceRoot
                },
                artifactPaths: [],
                statePaths: [],
                protectedPaths: []
              }
            ]
          }
        })
      ).rejects.toThrow(/trace output.*Runner workspace/iu);
      expect(await readFile(privateKeyPath, "utf8")).toBe(privatePem);
      await expect(readFile(runnerMarkerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("derives the Observer identity from its content-addressed implementation closure", async () => {
    const benchmarkRoot = getBenchmarkRoot();
    const components = [
      ["observer/referenceObserver", "src/observer/referenceObserver.ts"],
      ["observer/workflowTrace", "src/observer/workflowTrace.ts"],
      ["observer/qualification", "src/observer/qualification.ts"],
      ["evaluation/evaluationContract", "src/evaluation/evaluationContract.ts"],
      ["utils/hash", "src/utils/hash.ts"],
      ["utils/redaction", "src/utils/redaction.ts"]
    ] as const;
    const expectedHash = sha256Text(
      stableJson({
        protocol: "awb-reference-observer-content/1",
        components: await Promise.all(
          components.map(async ([id, relativePath]) => ({
            id,
            sha256: await hashFile(path.join(benchmarkRoot, relativePath))
          }))
        )
      })
    );
    expect(referenceObserverImplementationHash()).toBe(expectedHash);
  });

  test("fails closed when the isolation backend is unsupported or missing", async () => {
    await expect(
      assertReferenceObserverIsolationAvailable({ platform: "linux" })
    ).rejects.toThrow(/no supported Runner boundary/iu);
    await expect(
      assertReferenceObserverIsolationAvailable({
        platform: "darwin",
        sandboxExecutable: path.join(root, "missing-sandbox-exec")
      })
    ).rejects.toThrow(/executable .*sandbox-exec isolation backend/iu);
  });

  test("refuses copied or hard-linked signing-key material in the Runner workspace", async () => {
    for (const exposure of ["copy", "hard-link"] as const) {
      const isolatedRoot = await mkdtemp(
        path.join(tmpdir(), `awb-reference-observer-${exposure}-boundary-`)
      );
      try {
        const workspaceRoot = path.join(isolatedRoot, "workspace");
        const secretRoot = path.join(isolatedRoot, "secrets");
        const privateKeyPath = path.join(
          secretRoot,
          "observer-private.pem"
        );
        const exposedPath = path.join(
          workspaceRoot,
          "runner-visible-material.bin"
        );
        const keys = generateKeyPairSync("ed25519");
        const privatePem = keys.privateKey.export({
          type: "pkcs8",
          format: "pem"
        });
        await mkdir(workspaceRoot, { recursive: true });
        await mkdir(secretRoot, { recursive: true });
        await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
        if (exposure === "copy") {
          await writeFile(exposedPath, privatePem);
        } else {
          await link(privateKeyPath, exposedPath);
        }

        await expect(
          observeWithReferenceObserver({
            privateKeyPath,
            outputPath: path.join(isolatedRoot, "output", "trace.json"),
            request: {
              schemaVersion: "0.1.0",
              observer: { id: "fixture", version: "1.0.0" },
              subject: {
                targetId: "fixture-target",
                contractHash: `sha256:${"a".repeat(64)}`,
                suite: "qualification",
                seed: "reference-observer-test",
                caseSetHash: `sha256:${"b".repeat(64)}`,
                runner: {
                  name: "codex",
                  adapterVersion: "fixture",
                  capabilitiesHash: `sha256:${"c".repeat(64)}`
                },
                isolation: "read_only_sandbox",
                permissionMode: "read_only_no_approval"
              },
              cases: [
                {
                  caseId: `${exposure}-boundary`,
                  templateId: "observer-qualification",
                  runId: `${exposure}-boundary`,
                  workspaceRoot,
                  command: {
                    executable: process.execPath,
                    args: ["--version"],
                    cwd: workspaceRoot
                  },
                  artifactPaths: [],
                  statePaths: [],
                  protectedPaths: []
                }
              ]
            }
          })
        ).rejects.toThrow(/key material|Runner workspace/iu);
      } finally {
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    }
  });
});
