import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";

const cwd = process.cwd();

describe("generic regression scenario catalog", () => {
  test("declares the portable outcomes required by the CI regression contract", async () => {
    const fixture = parse(await readFile(path.join(cwd, "fixtures", "regression", "scenarios.yaml"), "utf8"));
    const schema = JSON.parse(await readFile(path.join(cwd, "schemas", "regression-scenarios.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);

    expect(validate(fixture), new Ajv2020({ strict: false }).errorsText(validate.errors)).toBe(true);
    expect(fixture.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual([
      "normal",
      "improvement",
      "regression",
      "hard-failure",
      "simulated-only"
    ]);
    expect(fixture.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "normal", expectedClassification: "UNCHANGED", expectedGate: "DIAGNOSTIC_ONLY" }),
        expect.objectContaining({ id: "improvement", expectedClassification: "IMPROVED", expectedGate: "DIAGNOSTIC_ONLY" }),
        expect.objectContaining({ id: "regression", expectedClassification: "REGRESSED", expectedGate: "BLOCK" }),
        expect.objectContaining({ id: "hard-failure", expectedClassification: "HARD_FAILURE", expectedGate: "BLOCK" }),
        expect.objectContaining({ id: "simulated-only", expectedClassification: "UNCHANGED", expectedGate: "DIAGNOSTIC_ONLY" })
      ])
    );
    const serialized = JSON.stringify(fixture);
    const prohibitedFragments = [
      ["/", "Users", "/"].join(""),
      ["liu", "yi", "85"].join(""),
      ["san", "kuai"].join(""),
      ["mei", "tuan"].join("")
    ];
    for (const fragment of prohibitedFragments) {
      expect(serialized).not.toContain(fragment);
    }
  });
});
