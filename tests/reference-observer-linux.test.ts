import { describe, expect, test } from "vitest";
import {
  assertReferenceObserverIsolationConfig,
  buildLinuxOciDockerRunPlan,
  buildReferenceObserverIsolationManifest
} from "../src/observer/referenceObserver.js";
import {
  assertWorkflowTraceIsolationBinding,
  assertWorkflowTraceIsolationManifest
} from "../src/observer/workflowTrace.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";

const IMAGE_DIGEST =
  "ghcr.io/example/awb-observer-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

describe("Linux OCI Docker reference Observer backend", () => {
  test("fails closed for mutable or unresolved Docker image identities", () => {
    expect(() =>
      assertReferenceObserverIsolationConfig({
        backend: "linux-oci-docker",
        dockerExecutable: "docker",
        image: "node:22"
      })
    ).toThrow(/immutable image digest or image id/i);

    expect(() =>
      assertReferenceObserverIsolationConfig({
        backend: "linux-oci-docker",
        dockerExecutable: "docker",
        image: IMAGE_DIGEST,
        imageId: "node:22"
      })
    ).toThrow(/immutable image id/i);
  });

  test("builds a deny-default Docker run plan without mounting secrets or host control surfaces", () => {
    const plan = buildLinuxOciDockerRunPlan({
      dockerExecutable: "docker",
      image: IMAGE_DIGEST,
      imageId: IMAGE_ID,
      runtimeVersion: "Docker version 27.5.1, build fixture",
      runnerUser: "1000:1000",
      workspaceRoot: "/tmp/awb-workspace",
      commandCwd: "/tmp/awb-workspace/subdir",
      privateKeyPath: "/tmp/awb-secrets/observer-private.pem",
      command: {
        executable: "node",
        args: ["runner.mjs"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" }
      },
      canaries: {
        signingKeyRead: "ABSENT_FROM_MOUNT_NAMESPACE",
        networkDenied: "NETWORK_UNREACHABLE",
        nestedProcessDenied: "DENIED",
        outOfScopeWriteDenied: "EROFS"
      }
    });

    expect(plan.executable).toBe("docker");
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--workdir",
        "/workspace/subdir",
        IMAGE_DIGEST,
        "/usr/local/bin/awb-seccomp-launcher",
        "node",
        "runner.mjs"
      ])
    );
    const serialized = plan.args.join(" ");
    expect(serialized).toContain("type=bind,src=/tmp/awb-workspace,dst=/workspace");
    expect(serialized).toContain("/tmp:rw,noexec,nosuid,nodev,size=67108864");
    expect(serialized).not.toContain("--privileged");
    expect(serialized).not.toContain("--cap-add");
    expect(serialized).not.toContain("--pid=host");
    expect(serialized).not.toContain("/var/run/docker.sock");
    expect(serialized).not.toContain("/tmp/awb-secrets/observer-private.pem");
  });

  test("translates host-only Node paths and Observer workspace environment into the container namespace", () => {
    const plan = buildLinuxOciDockerRunPlan({
      dockerExecutable: "docker",
      image: IMAGE_DIGEST,
      imageId: IMAGE_ID,
      runtimeVersion: "Docker version 27.5.1, build fixture",
      runnerUser: "1000:1000",
      workspaceRoot: "/tmp/awb-workspace",
      commandCwd: "/tmp/awb-workspace/subdir",
      privateKeyPath: "/tmp/awb-secrets/observer-private.pem",
      command: {
        executable: process.execPath,
        args: ["/tmp/awb-workspace/subdir/runner.mjs"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: "/tmp/awb-workspace/.awb-observer-home",
          TMPDIR: "/tmp/awb-workspace/.awb-observer-tmp",
          LANG: "C.UTF-8",
          AWB_OBSERVED_WORKSPACE: "/tmp/awb-workspace"
        }
      },
      canaries: {
        signingKeyRead: "ABSENT_FROM_MOUNT_NAMESPACE",
        networkDenied: "NETWORK_UNREACHABLE",
        nestedProcessDenied: "DENIED",
        outOfScopeWriteDenied: "EROFS"
      }
    });

    expect(plan.args.slice(-3)).toEqual([
      "/usr/local/bin/awb-seccomp-launcher",
      "node",
      "/workspace/subdir/runner.mjs"
    ]);
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "--env",
        "HOME=/workspace/.awb-observer-home",
        "--env",
        "TMPDIR=/workspace/.awb-observer-tmp",
        "--env",
        "AWB_OBSERVED_WORKSPACE=/workspace"
      ])
    );
    expect(plan.args.join(" ")).not.toContain(process.execPath);
  });

  test("rejects Runner arguments and environment paths outside the mounted workspace", () => {
    const base = {
      dockerExecutable: "docker",
      image: IMAGE_DIGEST,
      imageId: IMAGE_ID,
      runtimeVersion: "Docker version 27.5.1, build fixture",
      runnerUser: "1000:1000",
      workspaceRoot: "/tmp/awb-workspace",
      commandCwd: "/tmp/awb-workspace",
      privateKeyPath: "/tmp/awb-secrets/observer-private.pem",
      canaries: {
        signingKeyRead: "ABSENT_FROM_MOUNT_NAMESPACE" as const,
        networkDenied: "NETWORK_UNREACHABLE" as const,
        nestedProcessDenied: "DENIED" as const,
        outOfScopeWriteDenied: "EROFS" as const
      }
    };

    expect(() =>
      buildLinuxOciDockerRunPlan({
        ...base,
        command: {
          executable: "node",
          args: ["/tmp/outside-workspace/runner.mjs"]
        }
      })
    ).toThrow(/argument.*outside.*workspace/iu);
    expect(() =>
      buildLinuxOciDockerRunPlan({
        ...base,
        command: {
          executable: "node",
          args: [],
          env: { HOME: "/tmp/outside-workspace/home" }
        }
      })
    ).toThrow(/environment.*outside.*workspace/iu);
  });

  test("builds a deterministic isolation manifest bound to active canary outcomes", () => {
    const manifest = buildReferenceObserverIsolationManifest({
      backend: "linux-oci-docker",
      platform: "linux",
      runtimeVersion: "Docker version 27.5.1, build fixture",
      image: IMAGE_DIGEST,
      imageId: IMAGE_ID,
      policyHash: HASH_C,
      mountManifestHash: HASH_C,
      networkMode: "none",
      processPolicy: "seccomp_launcher_no_child_process",
      capabilities: { drop: ["ALL"], add: [] },
      noNewPrivileges: true,
      readOnlyRootfs: true,
      writableMounts: ["/workspace", "/tmp"],
      canaries: {
        signingKeyRead: "ABSENT_FROM_MOUNT_NAMESPACE",
        networkDenied: "NETWORK_UNREACHABLE",
        nestedProcessDenied: "DENIED",
        outOfScopeWriteDenied: "EROFS"
      }
    });

    expect(manifest).toMatchObject({
      backend: "linux-oci-docker",
      platform: "linux",
      image: IMAGE_DIGEST,
      imageId: IMAGE_ID,
      networkMode: "none",
      noNewPrivileges: true,
      readOnlyRootfs: true,
      canaries: {
        signingKeyRead: "ABSENT_FROM_MOUNT_NAMESPACE",
        networkDenied: "NETWORK_UNREACHABLE",
        nestedProcessDenied: "DENIED",
        outOfScopeWriteDenied: "EROFS"
      }
    });
    expect(manifest.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => assertWorkflowTraceIsolationManifest(manifest)).not.toThrow();
    expect(() =>
      assertWorkflowTraceIsolationBinding("read_only_sandbox", manifest)
    ).not.toThrow();
    expect(() =>
      assertWorkflowTraceIsolationBinding("working_directory_only", manifest)
    ).toThrow(/isolation claim.*qualified reference Observer manifest/iu);

    expect(() =>
      buildReferenceObserverIsolationManifest({
        ...manifest,
        canaries: { ...manifest.canaries, networkDenied: "CONNECTED" as never }
      })
    ).toThrow(/canary unexpectedly succeeded/i);

    expect(() =>
      buildReferenceObserverIsolationManifest({
        ...manifest,
        platform: "darwin"
      })
    ).toThrow(/backend.*platform/iu);

    expect(() =>
      assertWorkflowTraceIsolationManifest({
        ...manifest,
        policyHash: `sha256:${"0".repeat(64)}`
      })
    ).toThrow(/stale.*unsafe.*backend/iu);
    const { manifestHash: _manifestHash, ...manifestContent } = manifest;
    const backendMismatchContent = {
      ...manifestContent,
      platform: "darwin"
    };
    expect(() =>
      assertWorkflowTraceIsolationManifest({
        ...backendMismatchContent,
        manifestHash: sha256Text(stableJson(backendMismatchContent))
      })
    ).toThrow(/stale.*unsafe.*backend/iu);
  });
});
