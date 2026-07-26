import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import YAML from "yaml";
import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { inferTargetPackDraft } from "../src/profiler/targetPackInitializer.js";
import { hashFile } from "../src/utils/hash.js";

const cwd = process.cwd();

describe("target onboarding trust boundary", () => {
  test("preserves arbitrary raw status codes without guessing their semantics", async () => {
    const agentRoot = await mkdtemp(
      path.join(tmpdir(), "awb-target-statuses-")
    );
    try {
      await mkdir(path.join(agentRoot, "coordinator"), { recursive: true });
      await writeFile(
        path.join(agentRoot, "coordinator", "AGENTS.md"),
        [
          "# Coordinator",
          "Owns triage.",
          "Statuses: BYPASSED_BY_CONFIG, ADVISORY_CONTINUE."
        ].join("\n")
      );

      const result = await inferTargetPackDraft({
        agentRoot,
        targetId: "custom-status-agent"
      });

      expect(result.targetPack.contracts.statuses).toEqual([
        "ADVISORY_CONTINUE",
        "BYPASSED_BY_CONFIG"
      ]);
      expect(result.targetPack.contracts.statuses).not.toEqual(
        expect.arrayContaining(["PASS", "FAILED", "SKIPPED", "ADVISORY"])
      );
      expect(result.targetPack.contracts.statusSemantics).toBeUndefined();
      expect(result.gapsMarkdown).toContain(
        "Confirm owner-reviewed status semantics"
      );
    } finally {
      await rm(agentRoot, { recursive: true, force: true });
    }
  });

  test("contract-model schema accepts targets with no status vocabulary", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const contract = structuredClone(profile.contract);
    contract.statuses = [];
    delete contract.statusSemantics;
    const schema = JSON.parse(
      await readFile(
        path.join(cwd, "schemas", "contract-model.schema.json"),
        "utf8"
      )
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);

    expect(validate(contract), JSON.stringify(validate.errors)).toBe(true);
  });

  test("a generated-style draft can be reviewed but cannot be registered", async () => {
    const fixture = await makeBenchmarkRoot({
      status: "draft"
    });
    try {
      const result = await validateFixtureRoot(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("owner-reviewed");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("a reviewed target with a stale contract-validity artifact is rejected", async () => {
    const fixture = await makeBenchmarkRoot({
      status: "reviewed",
      reviewerId: "fixture-owner",
      reviewedAt: "2026-07-25T00:00:00.000Z",
      artifactPath: "configs/targets/reviews/minimal-directory-agent.contract-validity.json",
      artifactHash: `sha256:${"0".repeat(64)}`
    });
    try {
      const result = await validateFixtureRoot(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("contract review artifact hash");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("a hash-matched review artifact cannot approve a stale contractHash", async () => {
    const artifactPath =
      "configs/targets/reviews/minimal-directory-agent.contract-validity.json";
    const fixture = await makeBenchmarkRoot({
      status: "reviewed",
      reviewerId: "fixture-owner",
      reviewedAt: "2026-07-25T00:00:00.000Z",
      artifactPath,
      artifactHash: `sha256:${"0".repeat(64)}`
    });
    try {
      const reviewArtifactPath = path.join(fixture, artifactPath);
      await writeFile(
        reviewArtifactPath,
        `${JSON.stringify(
          {
            schemaVersion: "0.1.0",
            artifactType: "contract-validity",
            targetId: "minimal-directory-agent",
            contractHash: `sha256:${"1".repeat(64)}`,
            decision: "approved",
            reviewerId: "fixture-owner",
            reviewedAt: "2026-07-25T00:00:00.000Z",
            reviewedContractFields: [
              "entrypoints",
              "roles",
              "statuses",
              "requiredOwners",
              "routing",
              "joins",
              "artifacts",
              "states",
              "budgets",
              "commandPolicy"
            ]
          },
          null,
          2
        )}\n`
      );
      const targetPath = path.join(
        fixture,
        "configs/targets/minimal-directory-agent.yaml"
      );
      const target = YAML.parse(await readFile(targetPath, "utf8"));
      target.contractReview.artifactHash = await hashFile(reviewArtifactPath);
      await writeFile(targetPath, YAML.stringify(target));

      const result = await validateFixtureRoot(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "does not approve the current contractHash"
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

async function makeBenchmarkRoot(contractReview: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "awb-target-onboarding-"));
  await cp(path.join(cwd, "schemas"), path.join(root, "schemas"), { recursive: true });
  await cp(path.join(cwd, "configs/evaluation"), path.join(root, "configs/evaluation"), {
    recursive: true
  });
  await cp(
    path.join(cwd, "configs/artifacts"),
    path.join(root, "configs/artifacts"),
    { recursive: true }
  );
  await cp(path.join(cwd, "configs/ci"), path.join(root, "configs/ci"), { recursive: true });
  await cp(path.join(cwd, "configs/runners"), path.join(root, "configs/runners"), { recursive: true });
  await mkdir(path.join(root, "configs/targets/reviews"), { recursive: true });
  const target = YAML.parse(
    await readFile(path.join(cwd, "configs/targets/minimal-directory-agent.yaml"), "utf8")
  ) as Record<string, unknown>;
  target.root = path.join(cwd, "fixtures/repos/minimal-directory-agent");
  target.contractReview = contractReview;
  await writeFile(
    path.join(root, "configs/targets/minimal-directory-agent.yaml"),
    YAML.stringify(target)
  );
  await writeFile(
    path.join(root, "configs/targets/registry.yaml"),
    YAML.stringify({
      targets: [
        {
          id: "minimal-directory-agent",
          configPath: "configs/targets/minimal-directory-agent.yaml"
        }
      ]
    })
  );
  await writeFile(
    path.join(root, "configs/targets/reviews/minimal-directory-agent.contract-validity.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        artifactType: "contract-validity",
        targetId: "minimal-directory-agent",
        contractHash: `sha256:${"1".repeat(64)}`,
        decision: "approved",
        reviewerId: "fixture-owner",
        reviewedAt: "2026-07-25T00:00:00.000Z"
      },
      null,
      2
    )}\n`
  );
  return root;
}

async function validateFixtureRoot(root: string) {
  return execa(
    "node",
    ["--import", "tsx", "src/cli/index.ts", "validate-schema"],
    {
      cwd,
      env: {
        ...process.env,
        AWB_PROJECT_ROOT: root
      },
      reject: false
    }
  );
}
