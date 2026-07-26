# Agent Workflow Bench Gate Policy Calibration

Status: PENDING_HOLDOUT
Assessment: harness_diagnostic
Release eligible: false
Policy: awb-gate-policy@1.0.0
Policy hash: sha256:6928be26f1cb30cd07e8ec2ba02b228f517fd6c5c6efcc212db1846eef73bd98
Rules hash: sha256:a58f969de636f05f318fa292e2957b0c014e80856419564421e1e5089a199c19
Fit splits: development, calibration
Fit sample size: 24
Holdout excluded during fit: true

## Fit metrics

- P0 recall: 1
- False PASS count: 0
- Overall agreement: 1
- Cohen kappa: 1
- Candidate selection: canonical-baseline (3 evaluated)

## Dimension evidence

- artifact: weight=1; safeMean=100; riskMean=87.5; pairedEffect=12.5; 95% bootstrap=[0, 37.5]; support=8/SUPPORTED
- contract: weight=1; safeMean=100; riskMean=0; pairedEffect=100; 95% bootstrap=[100, 100]; support=8/SUPPORTED
- efficiency: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=8/SUPPORTED
- gate: weight=1; safeMean=100; riskMean=87.5; pairedEffect=12.5; 95% bootstrap=[0, 37.5]; support=8/SUPPORTED
- join: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=8/SUPPORTED
- ownership: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=8/SUPPORTED
- routing: weight=1; safeMean=100; riskMean=87.5; pairedEffect=12.5; 95% bootstrap=[0, 37.5]; support=8/SUPPORTED
- runner: weight=1; safeMean=100; riskMean=87.5; pairedEffect=12.5; 95% bootstrap=[0, 37.5]; support=8/SUPPORTED
- sideEffect: weight=1; safeMean=100; riskMean=75; pairedEffect=25; 95% bootstrap=[0, 62.5]; support=8/SUPPORTED
- state: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=8/SUPPORTED
- telemetry: weight=1; safeMean=93.75; riskMean=71.25; pairedEffect=23.75; 95% bootstrap=[0, 47.5]; support=8/SUPPORTED

## Threshold evidence

- Telemetry minimum: 0.75; support=24/SUPPORTED
- Token budget ratio maximum: 1
- Wall-clock budget ratio maximum: 1
- Wasted-token warning ratio: 0.2; support=24/SUPPORTED
- Meaningful score delta: 1

## Blockers

- none

This public Gold Corpus assessment is harness-diagnostic and cannot authorize production blocking.
