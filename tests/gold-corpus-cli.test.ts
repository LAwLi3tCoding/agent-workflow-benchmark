import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

describe("Gold Corpus CLI", () => {
  test("validates and reverse-validates the complete corpus", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "awb-gold-corpus-"));
    try {
      const validation = await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "gold-corpus",
          "validate",
          "--corpus",
          "fixtures/gold-corpus/v1/manifest.yaml"
        ],
        { cwd: process.cwd() }
      );
      expect(validation.stdout).toContain("36 trajectories");
      expect(validation.stdout).toContain("corpusVersion=1.0.0");

      await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "debug",
          "reverse-validate",
          "--corpus",
          "fixtures/gold-corpus/v1/manifest.yaml",
          "--out",
          out
        ],
        { cwd: process.cwd() }
      );
      const report = JSON.parse(await readFile(path.join(out, "gold-corpus-report.json"), "utf8"));
      const schema = JSON.parse(
        await readFile(
          path.join(process.cwd(), "schemas/gold-corpus-report.schema.json"),
          "utf8"
        )
      );
      const validate = new Ajv2020({ strict: false }).compile(schema);
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
      expect(report).toMatchObject({
        status: "PASS",
        assessmentType: "harness_diagnostic",
        releaseEligible: false,
        metrics: {
          p0MutationKillRate: 1,
          falsePassCount: 0,
          knownGoodBlockedCount: 0
        }
      });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
