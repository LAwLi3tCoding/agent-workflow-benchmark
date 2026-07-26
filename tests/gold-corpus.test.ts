import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { buildAiCasePlanPrompt } from "../src/generator/aiPlanner.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import {
  DEFAULT_GOLD_CORPUS_PATH,
  REQUIRED_GOLD_FAILURE_CODES,
  detectTrajectoryFailures,
  evaluateGoldCorpus,
  loadGoldCorpus,
  loadGoldCorpusPlannerView
} from "../src/evaluation/goldCorpus.js";
import { semanticCaseSetHash } from "../src/regression/provenance.js";
import { runCase } from "../src/runner/simulatedRunner.js";
import { listFiles } from "../src/utils/hash.js";

describe("versioned Gold Corpus", () => {
  test("binds every required failure family to good, bad, and boundary trajectories", async () => {
    const target = await loadTargetPack("minimal-directory-agent");
    const profile = await profileTarget(target);
    const suite = materializeSmokeSuite(profile.contract);
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);

    expect(corpus.manifest.schemaVersion).toBe("0.1.0");
    expect(corpus.manifest.corpusVersion).toBe("1.0.0");
    expect(corpus.manifest.fixtureVersion).toBe("1.0.0");
    expect(corpus.manifest.contractHash).toBe(profile.contract.contractHash);
    expect(corpus.manifest.caseSetHash).toBe(semanticCaseSetHash(suite.cases));
    expect(corpus.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const expectedSplitSize = REQUIRED_GOLD_FAILURE_CODES.length;
    const expectedCorpusSize = expectedSplitSize * 3;
    expect(corpus.cases).toHaveLength(expectedCorpusSize);
    expect(new Set(corpus.cases.map((item) => item.trajectory.id)).size).toBe(expectedCorpusSize);

    const coveredCodes = [...new Set(corpus.cases.map((item) => item.label.failureCode))].sort();
    expect(coveredCodes).toEqual([...REQUIRED_GOLD_FAILURE_CODES].sort());
    for (const code of REQUIRED_GOLD_FAILURE_CODES) {
      expect(
        corpus.cases
          .filter((item) => item.label.failureCode === code)
          .map((item) => item.label.control)
          .sort()
      ).toEqual(["boundary", "known_bad", "known_good"]);
    }
    expect(corpus.cases.filter((item) => item.split === "development")).toHaveLength(expectedSplitSize);
    expect(corpus.cases.filter((item) => item.split === "calibration")).toHaveLength(expectedSplitSize);
    expect(corpus.cases.filter((item) => item.split === "holdout")).toHaveLength(expectedSplitSize);
    expect(corpus.cases.every((item) => item.label.labelSource.length > 0)).toBe(true);
  });

  test("keeps holdout trajectories and all expected labels out of planner context", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    const plannerView = await loadGoldCorpusPlannerView(DEFAULT_GOLD_CORPUS_PATH);
    const prompt = buildAiCasePlanPrompt(profile.contract, {
      maxCases: 4,
      goldCorpusView: plannerView
    });
    const serialized = JSON.stringify(plannerView);

    expect(plannerView.split).toBe("development");
    expect(plannerView.trajectories).toHaveLength(REQUIRED_GOLD_FAILURE_CODES.length);
    expect(plannerView.baseTrajectory.events.length).toBeGreaterThan(0);
    expect(serialized).not.toMatch(/expectedVerdict|expectedFailure|failureCode|labelSource|known_bad|known_good|boundary/u);
    for (const holdout of corpus.cases.filter((item) => item.split === "holdout")) {
      expect(serialized).not.toContain(holdout.trajectory.id);
      expect(prompt).not.toContain(holdout.trajectory.id);
    }
    expect(prompt).toContain("Development-only unlabeled Gold Corpus trajectories");

    const contaminated = structuredClone(plannerView);
    contaminated.trajectories[0]!.patches.push({
      op: "set_payload",
      eventId: "contract",
      key: "expectedVerdict",
      value: "FAIL"
    });
    expect(() =>
      buildAiCasePlanPrompt(profile.contract, {
        maxCases: 4,
        goldCorpusView: contaminated
      })
    ).toThrow("outcome-label material");
  });

  test("planner loading does not read holdout labels while evaluation fails closed on tampering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-gold-isolation-"));
    try {
      const fixtureCopy = path.join(root, "v1");
      await cp(path.dirname(DEFAULT_GOLD_CORPUS_PATH), fixtureCopy, {
        recursive: true
      });
      const manifestPath = path.join(fixtureCopy, "manifest.yaml");
      const holdoutLabels = path.join(fixtureCopy, "labels", "holdout.yaml");
      await appendFile(holdoutLabels, "\n# integrity-tamper\n");

      await expect(loadGoldCorpusPlannerView(manifestPath)).resolves.toMatchObject({
        split: "development"
      });
      await expect(loadGoldCorpus(manifestPath)).rejects.toThrow(
        "integrity mismatch"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("achieves complete P0 mutation kill with no false PASS or known-good block", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    const report = evaluateGoldCorpus(corpus, profile.contract, suite.cases);

    expect(report.assessmentType).toBe("harness_diagnostic");
    expect(report.releaseEligible).toBe(false);
    expect(report.status).toBe("PASS");
    expect(report.metrics.p0MutationKillRate).toBe(1);
    expect(report.metrics.mutationKillRate).toBe(1);
    expect(report.metrics.falsePassCount).toBe(0);
    expect(report.metrics.falsePositiveCount).toBe(0);
    expect(report.metrics.falseNegativeCount).toBe(0);
    expect(report.metrics.knownGoodBlockedCount).toBe(0);
    expect(report.coverage.missingFailureCodes).toEqual([]);
    expect(report.coverage.missingCoverageTargetIds).toEqual([]);
    expect(report.coverage.unknownCoverageTargetIds).toEqual([]);
    expect(report.blindSpots).toEqual([]);

    for (const result of report.results.filter((item) => item.control === "known_bad" && item.severity === "P0")) {
      expect(result.mutationKilled, result.trajectoryId).toBe(true);
      expect(result.observedVerdict, result.trajectoryId).toBe("FAIL");
      expect(result.observedFailureCodes, result.trajectoryId).toContain(result.expectedFailureCodes[0]);
    }
    for (const result of report.results.filter((item) => item.control === "known_good")) {
      expect(result.observedVerdict, result.trajectoryId).not.toBe("FAIL");
    }
  });

  test("does not turn a wrong label into detector evidence", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    const tampered = structuredClone(corpus);
    const targetCase = tampered.cases.find(
      (item) => item.label.failureCode === "TARGET_ROUTE_FORBIDDEN" && item.label.control === "known_bad"
    );
    expect(targetCase).toBeDefined();
    targetCase!.label.expectedFailureCodes = ["TARGET_OWNER_BYPASS"];

    const report = evaluateGoldCorpus(tampered, profile.contract, suite.cases);

    expect(report.status).toBe("FAIL");
    expect(report.metrics.falseNegativeCount).toBeGreaterThan(0);
    expect(report.blindSpots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trajectoryId: targetCase!.trajectory.id,
          classification: "oracle_gap"
        })
      ])
    );
    expect(
      report.results.find((item) => item.trajectoryId === targetCase!.trajectory.id)?.observedFailureCodes
    ).toContain("TARGET_ROUTE_FORBIDDEN");
  });

  test("fails closed on unknown coverage claims", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract);
    const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
    const tampered = structuredClone(corpus);
    tampered.cases[0]!.label.coverageTargetIds.push("unknown:fixture-claim");

    const report = evaluateGoldCorpus(tampered, profile.contract, suite.cases);

    expect(report.status).toBe("FAIL");
    expect(report.coverage.unknownCoverageTargetIds).toEqual([
      "unknown:fixture-claim"
    ]);
    expect(report.blindSpots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trajectoryId: "__coverage__",
          classification: "fixture_gap"
        })
      ])
    );
  });

  test("contains only generic synthetic data and no private host material", async () => {
    const corpusRoot = path.dirname(DEFAULT_GOLD_CORPUS_PATH);
    const files = await listFiles(corpusRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content, file).not.toMatch(/\/Users\/|\/home\/|file:\/\/|@san\u006buai\.com|@mei\u0074uan\.com|git\.san\u006buai\.com/u);
      expect(content, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]{16,}/u);
    }
  });

  test("detects the same false-pass transition after target status codes are renamed", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract) as typeof profile.contract & {
      statusSemantics: Array<{
        code: string;
        semanticClass: string;
        scope: string;
        blocking: boolean;
        terminal: boolean;
        allowedTransitions: string[];
      }>;
    };
    contract.statuses = ["GREEN", "WAIVED"];
    contract.statusSemantics = [
      {
        code: "GREEN",
        semanticClass: "pass",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      },
      {
        code: "WAIVED",
        semanticClass: "skipped",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      }
    ];
    const testCase = materializeSmokeSuite(contract).cases.find(
      (item) => item.templateId === "skip-not-pass"
    )!;
    const run = runCase(testCase, contract);
    const gate = run.events.find((event) => event.type === "gate_decision")!;
    gate.payload = {
      status: "GREEN",
      sourceStatus: "WAIVED",
      scope: "release-gate",
      flowDecision: "release",
      transition: { from: "WAIVED", to: "GREEN" },
      readbackStatus: "GREEN"
    };

    expect(
      detectTrajectoryFailures(run, contract, testCase).map((failure) => failure.code)
    ).toContain("GATE_FALSE_PASS");
  });

  test("does not infer false pass from status names without transition readback evidence", async () => {
    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const contract = structuredClone(profile.contract) as typeof profile.contract & {
      statusSemantics: Array<{
        code: string;
        semanticClass: string;
        scope: string;
        blocking: boolean;
        terminal: boolean;
        allowedTransitions: string[];
      }>;
    };
    contract.statuses = ["GREEN", "WAIVED"];
    contract.statusSemantics = [
      {
        code: "GREEN",
        semanticClass: "pass",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      },
      {
        code: "WAIVED",
        semanticClass: "skipped",
        scope: "release-gate",
        blocking: false,
        terminal: true,
        allowedTransitions: []
      }
    ];
    const testCase = materializeSmokeSuite(contract).cases.find(
      (item) => item.templateId === "skip-not-pass"
    )!;
    const run = runCase(testCase, contract);
    const gate = run.events.find((event) => event.type === "gate_decision")!;
    gate.payload = {
      status: "GREEN",
      sourceStatus: "WAIVED",
      scope: "release-gate"
    };

    expect(
      detectTrajectoryFailures(run, contract, testCase).map((failure) => failure.code)
    ).not.toContain("GATE_FALSE_PASS");
  });
});
