import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cwd = process.cwd();
const studyPath = path.join(
  cwd,
  "fixtures",
  "external-validity",
  "v1",
  "study.yaml"
);

describe("criterion validity CLI", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-validity-"));
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("generates a public-safe blinded labeling package and draft inputs", async () => {
    const out = path.join(root, "package");
    await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "criterion-validity",
        "package",
        "--study",
        studyPath,
        "--out",
        out
      ],
      { cwd }
    );

    const labelingPackage = JSON.parse(
      await readFile(
        path.join(out, "external-validity-labeling-package.json"),
        "utf8"
      )
    );
    const observationsTemplate = JSON.parse(
      await readFile(
        path.join(
          out,
          "external-validity-observations.template.json"
        ),
        "utf8"
      )
    );
    const labelsTemplate = JSON.parse(
      await readFile(
        path.join(
          out,
          "external-validity-human-labels.template.json"
        ),
        "utf8"
      )
    );
    const agentPrelabelA = JSON.parse(
      await readFile(
        path.join(
          out,
          "external-validity-agent-prelabels.agent-rater-a.template.json"
        ),
        "utf8"
      )
    );
    const agentPrelabelB = JSON.parse(
      await readFile(
        path.join(
          out,
          "external-validity-agent-prelabels.agent-rater-b.template.json"
        ),
        "utf8"
      )
    );
    const serialized = JSON.stringify({
      labelingPackage,
      observationsTemplate,
      labelsTemplate,
      agentPrelabelA,
      agentPrelabelB
    });

    expect(labelingPackage).toMatchObject({
      resultType: "external_validity_labeling_package",
      status: "READY_FOR_HUMAN_LABELING",
      publicSafe: true
    });
    expect(observationsTemplate.status).toBe("DRAFT");
    expect(labelsTemplate.status).toBe("DRAFT");
    expect([agentPrelabelA, agentPrelabelB]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          laneId: "agent-rater-a",
          humanTruth: false
        }),
        expect.objectContaining({
          laneId: "agent-rater-b",
          humanTruth: false
        })
      ])
    );
    expect(serialized).not.toMatch(
      /known_improvement|no_change|ordinary_regression|p0_regression/u
    );
    expect(serialized).not.toMatch(/\/Users\/|@|private-target/iu);
  }, 30_000);

  test("writes pending report and full labeling package when human inputs are absent", async () => {
    const out = path.join(root, "pending");
    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "criterion-validity",
        "analyze",
        "--study",
        studyPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    const report = JSON.parse(
      await readFile(path.join(out, "validity-report.json"), "utf8")
    );

    expect(execution.exitCode).toBe(2);
    expect(report).toMatchObject({
      status: "PENDING_HUMAN_INPUT",
      criterionValidity: "pending_human_input",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY"
    });
    await expect(
      readFile(
        path.join(out, "external-validity-labeling-package.json"),
        "utf8"
      )
    ).resolves.toContain("READY_FOR_HUMAN_LABELING");
    await expect(
      readFile(path.join(out, "validity-report.md"), "utf8")
    ).resolves.toContain("Pending human input");
  }, 30_000);

  test("does not trust comparison references without both explicit public trust anchors", async () => {
    const out = path.join(root, "untrusted-comparison");
    const observationsPath = path.join(root, "untrusted-observations.json");
    await writeFile(
      observationsPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          resultType: "external_validity_observations",
          studyId: "public-safe-external-validity-template",
          status: "COMPLETE",
          items: [
            {
              itemId: "blind-item-001",
              evidence: {
                comparisonRef: "missing-comparison/comparison-result.json",
                comparisonHash: `sha256:${"a".repeat(64)}`
              }
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "criterion-validity",
        "analyze",
        "--study",
        studyPath,
        "--observations",
        observationsPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    const report = JSON.parse(
      await readFile(path.join(out, "validity-report.json"), "utf8")
    );

    expect(execution.exitCode).toBe(2);
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        "AWB_OBSERVATIONS_INCOMPLETE",
        "UNQUALIFIED_EVIDENCE"
      ])
    );
  }, 30_000);
});
