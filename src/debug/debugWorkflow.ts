import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BenchmarkCase,
  ContractModel,
  DebugEnvironment,
  MutationInput,
  ReverseValidationResult,
  TargetPack
} from "../core/types.js";
import { runCase } from "../runner/simulatedRunner.js";
import { scoreCaseWithContract } from "../scorer/score.js";
import { hashPath, sha256Text, stableJson } from "../utils/hash.js";

export async function prepareDebugEnvironment(
  target: TargetPack,
  contract: ContractModel,
  testCase: BenchmarkCase,
  options: { runner: string; mockProfile: string; outDir: string }
): Promise<DebugEnvironment> {
  const debugId = path.basename(options.outDir);
  const sandboxRoot = path.join(options.outDir, "sandbox");
  const binRoot = path.join(options.outDir, "bin");
  const repoCopy = path.join(options.outDir, "repos", "target-copy");
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(path.dirname(repoCopy), { recursive: true });
  await cp(target.root, repoCopy, { recursive: true, force: true });

  const fakeToolNames = ["gh", "issue-cli", "deploy-cli", "docs-cli", "curl"];
  const fakeTools = [];
  for (const name of fakeToolNames) {
    const toolPath = path.join(binRoot, name);
    await writeFile(toolPath, "#!/usr/bin/env sh\necho '{\"policyDecision\":\"deny\",\"allowed\":false}'\nexit 0\n", { mode: 0o755 });
    fakeTools.push({ name, path: `bin/${name}`, behaviorFixture: `fixtures/fake-tools/${name}/${options.mockProfile}.json` });
  }

  const env: DebugEnvironment = {
    schemaVersion: "0.1.0",
    debugId,
    targetId: target.id,
    caseId: testCase.id,
    contractHash: contract.contractHash,
    caseHash: testCase.caseHash,
    sandboxRoot: "sandbox",
    mockProfile: options.mockProfile,
    fakeTools,
    mockServices: [
      {
        id: "fake-docs",
        kind: "http",
        baseUrl: "http://127.0.0.1:0",
        fixture: "fixtures/mock-services/fake-docs/default.json"
      }
    ],
    fixtureRepos: [
      {
        id: "target-copy",
        source: "target://root",
        sandboxPath: "repos/target-copy",
        sourceHash: await hashPath(target.root)
      }
    ],
    stateSeeds: [],
    artifactSeeds: [],
    networkPolicyHash: sha256Text("declared-loopback-only-not-enforced"),
    commandPolicyHash: sha256Text(stableJson(target.commandPolicy)),
    reproduceCommands: [
      `npm run benchmark -- debug prepare-env --case <case-yaml> --runner ${options.runner} --mock-profile ${options.mockProfile} --out <debug-out>`
    ],
    preflightResults: [
      {
        status: "DIAGNOSTIC_ONLY",
        check: "production-network-deny",
        why: "Only loopback fake services are declared; prepare-env does not enforce network isolation."
      }
    ]
  };
  await writeFile(path.join(options.outDir, "debug-environment.json"), JSON.stringify(env, null, 2));
  return env;
}

export async function reverseValidate(
  target: TargetPack,
  contract: ContractModel,
  testCase: BenchmarkCase,
  options: { mutation: MutationInput; runner: string; outDir: string; expectedVerdict?: MutationInput["expectedVerdict"] }
): Promise<ReverseValidationResult> {
  if (options.runner !== "simulated") {
    throw new Error("debug reverse-validate currently supports overlay-only mutations with --runner simulated only");
  }
  const mutationScope = options.mutation.scope ?? "overlay-only";
  if (mutationScope !== "overlay-only") {
    throw new Error(`debug reverse-validate only accepts overlay-only mutations, got scope: ${mutationScope}`);
  }
  await mkdir(options.outDir, { recursive: true });
  await prepareDebugEnvironment(target, contract, testCase, {
    runner: options.runner,
    mockProfile: "strict",
    outDir: path.join(options.outDir, "env")
  });

  const baseline = scoreCaseWithContract(
    testCase,
    runCase(testCase, contract),
    contract
  );
  const mutant = scoreCaseWithContract(
    testCase,
    runCase(testCase, contract, options.mutation),
    contract
  );
  const restore = scoreCaseWithContract(
    testCase,
    runCase(testCase, contract),
    contract
  );
  const expectedVerdict = options.expectedVerdict ?? options.mutation.expectedVerdict;
  const expectedHardFailureMatched =
    !options.mutation.expectedHardFailureCode || mutant.hardFailures.some((failure) => failure.code === options.mutation.expectedHardFailureCode);
  const mutationKilled = isMutationKilled(baseline, mutant, options.mutation, expectedVerdict);
  const expectationMatched = !expectedVerdict || mutant.verdict === expectedVerdict;
  const falsePositive = baseline.verdict === "FAIL" || restore.verdict === "FAIL";
  const falseNegative = !mutationKilled || !expectationMatched || (expectedVerdict === "FAIL" && !expectedHardFailureMatched);
  const result: ReverseValidationResult = {
    schemaVersion: "0.1.0",
    debugId: path.basename(options.outDir),
    status: !falsePositive && !falseNegative ? "PASS" : "FAIL",
    mutationId: options.mutation.id,
    runner: "simulated",
    mutationScope,
    expectedVerdict,
    expectationMatched,
    expectedHardFailureCode: options.mutation.expectedHardFailureCode,
    expectedHardFailureMatched,
    baseline,
    mutant,
    restore,
    mutationKilled,
    falseNegative,
    falsePositive
  };

  if (falseNegative || falsePositive) {
    const dossierPath = path.join(options.outDir, "debug-dossier.json");
    await writeFile(
      dossierPath,
      JSON.stringify(
        {
          schemaVersion: "0.1.0",
          debugId: result.debugId,
          targetId: target.id,
          caseId: testCase.id,
          mutationId: options.mutation.id,
          gapClassification: falseNegative ? "oracle_gap" : "fixture_gap",
          suspectedComponents: ["cases/templates/smoke", "src/scorer/score.ts"],
          confidence: "medium"
        },
        null,
        2
      )
    );
    result.debugDossierPath = "debug-dossier.json";
  }

  await writeFile(path.join(options.outDir, "reverse-validation-result.json"), JSON.stringify(result, null, 2));
  return result;
}

function isMutationKilled(
  baseline: ReturnType<typeof scoreCaseWithContract>,
  mutant: ReturnType<typeof scoreCaseWithContract>,
  mutation: MutationInput,
  expectedVerdict: MutationInput["expectedVerdict"] | undefined
): boolean {
  if (mutation.expectedHardFailureCode) {
    const expectedHardFailureMatched = mutant.hardFailures.some((failure) => failure.code === mutation.expectedHardFailureCode);
    if (expectedVerdict === "FAIL") {
      return expectedHardFailureMatched;
    }
    if (expectedHardFailureMatched) {
      return true;
    }
  }
  if (mutant.verdict !== baseline.verdict || mutant.cappedScore < baseline.cappedScore) {
    return true;
  }
  if (mutant.telemetryCompleteness < baseline.telemetryCompleteness - 0.1) {
    return true;
  }
  if (mutant.tokens.costEstimateConfidence !== baseline.tokens.costEstimateConfidence) {
    return true;
  }
  return false;
}
