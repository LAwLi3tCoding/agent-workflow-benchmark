# Agent Workflow Bench Gate Policy Calibration

Status: PENDING_HOLDOUT
Assessment: harness_diagnostic
Release eligible: false
Policy: awb-gate-policy@1.1.0
Policy hash: sha256:650d570e19c64c6ddf7a760ae73d1698e5ec3c9518bd0c110e0e28ec86579da7
Rules hash: sha256:ca160f7cb842fa0b15c9a259f11289e7c1ccca37f72ab991dc110c594ecf0752
Fit splits: development, calibration
Fit sample size: 36
Holdout excluded during fit: true

## Fit metrics

- P0 recall: 1
- False PASS count: 0
- Overall agreement: 1
- Cohen kappa: 1
- Candidate selection: canonical-baseline (3 evaluated)

## Dimension evidence

- artifact: weight=1; safeMean=100; riskMean=91.666667; pairedEffect=8.333333; 95% bootstrap=[0, 25]; support=12/SUPPORTED
- contract: weight=1; safeMean=100; riskMean=0; pairedEffect=100; 95% bootstrap=[100, 100]; support=12/SUPPORTED
- efficiency: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=12/SUPPORTED
- gate: weight=1; safeMean=100; riskMean=91.666667; pairedEffect=8.333333; 95% bootstrap=[0, 25]; support=12/SUPPORTED
- join: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=12/SUPPORTED
- ownership: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=12/SUPPORTED
- routing: weight=1; safeMean=100; riskMean=91.666667; pairedEffect=8.333333; 95% bootstrap=[0, 25]; support=12/SUPPORTED
- runner: weight=1; safeMean=100; riskMean=91.666667; pairedEffect=8.333333; 95% bootstrap=[0, 25]; support=12/SUPPORTED
- sideEffect: weight=1; safeMean=100; riskMean=83.333333; pairedEffect=16.666667; 95% bootstrap=[0, 41.666667]; support=12/SUPPORTED
- state: weight=1; safeMean=100; riskMean=100; pairedEffect=0; 95% bootstrap=[0, 0]; support=12/SUPPORTED
- telemetry: weight=1; safeMean=94.166667; riskMean=79.166667; pairedEffect=15.833333; 95% bootstrap=[0, 39.583333]; support=12/SUPPORTED

## Threshold evidence

- Telemetry minimum: 0.75; support=36/SUPPORTED
- Token budget ratio maximum: 1
- Wall-clock budget ratio maximum: 1
- Wasted-token warning ratio: 0.2; support=36/SUPPORTED
- Meaningful score delta: 1

## Blockers

- none

This public Gold Corpus assessment is harness-diagnostic and cannot authorize production blocking.
