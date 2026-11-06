# Evaluation design

The main project replays synthetic meetings at checkpoints, including late transcript changes, stale source evidence and opportunities to repeat already-settled points. Its harness can score generated cards for grounding, usefulness, specificity, brevity, repetition and bilingual fidelity. The public case set in this preview contains 23 synthetic cases. The scorer and case tests run locally.

The October 17, 2026 guidance run with the later case-set revision recorded 61.8% worst-sample and 73.5% best-sample checkpoint pass rates, with two repetition hard failures. It missed the 90% gate. These are historical results, tied to the case set and rubric used in that run. The main project subsequently changed the rubric and requires fresh blind human calibration before it can claim a current pass rate.

The Jev integration tests cover transport, typed answers and invalid responses. The replay illustrates decision policy with fixtures. Measuring whether Jev picks the right moment to speak would require human-labeled intervention and abstention cases, and reporting both missed opportunities and distracting interventions. A model comparison should use the same meeting checkpoints, record the resolved model versions, and report quality, latency and token use together.
