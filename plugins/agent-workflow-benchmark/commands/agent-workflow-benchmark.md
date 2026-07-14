# Agent Workflow Benchmark

Use this command to run an AI-first benchmark flow from Claude Code.

Core pipeline: `evaluate` for the complete flow, or `plan-cases` -> inspect `ai-case-plan-validation.json` -> `materialize --strategy ai` -> `run --execution live` when you need manual stage control.

Preferred complete run:

```bash
awb evaluate --target "$ARGUMENTS" --planner-runner claude --runner claude --coverage-mode full --execution live --out reports/evaluations/"$ARGUMENTS"-claude-ai
```

This writes profile, AI plan, cases, `run/suite-result.json`, `run/report.md`, `run/harness-validation.json`, `run/recommendations.json`, `run/recommendations.md`, `run/p0-cases.json`, `run/p0-cases.md`, and `evaluation-summary.json`. The report includes dimension scores, agent modification recommendations, harness validation, and P0 case records.

Use the manual flow below only when you need to inspect or replace an intermediate artifact.

1. Build an AI case plan with Claude Code:

```bash
awb plan-cases --target "$ARGUMENTS" --runner claude --coverage-mode full --out reports/ai-plans/"$ARGUMENTS"
```

The plan must include `workflowUnderstanding`, `coverageTags`, and `scoringRubric`; coverage gaps are written to `ai-case-plan-validation.json`. Use `--max-cases` only to override the per-pass budget.

2. Materialize executable cases from that AI plan:

```bash
awb materialize --target "$ARGUMENTS" --suite smoke --strategy ai --ai-plan reports/ai-plans/"$ARGUMENTS"/ai-case-plan.json --out cases/generated/"$ARGUMENTS"/ai-smoke
```

3. Run the benchmark through Claude Code live execution:

```bash
awb run --cases-dir cases/generated/"$ARGUMENTS"/ai-smoke --runner claude --execution live --mode diagnostic --out reports/runs/"$ARGUMENTS"-claude-ai
```

For a single case with a live adapter:

```bash
awb run --case cases/generated/"$ARGUMENTS"/ai-smoke/<case>.yaml --runner claude --execution live --mode diagnostic --out reports/runs/"$ARGUMENTS"-claude-live
```

4. Generate the report:

```bash
awb report --run reports/runs/"$ARGUMENTS"-claude-ai --format md,json
awb score --run reports/runs/"$ARGUMENTS"-claude-ai
```

5. For benchmark self-debug, run overlay-only mutation reverse validation. This path validates benchmark scorer/oracle behavior and must use the simulated runner; it is not a live Claude/Codex runner check:

```bash
awb debug reverse-validate --target "$ARGUMENTS" --suite smoke --mutation-set fixtures/mutations/extended.yaml --runner simulated --suite-result reports/runs/"$ARGUMENTS"-claude-ai/suite-result.json --out .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations
awb debug diagnose --debug-run .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations --out .benchmark-debug/"$ARGUMENTS"-claude-ai-mutations/diagnosis
```
