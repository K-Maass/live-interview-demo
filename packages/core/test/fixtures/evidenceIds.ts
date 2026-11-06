// Shared by packages/core/test/guidance.test.ts and apps/service/test/contract.test.mjs.
/**
 * Every evidence-ID form the desktop's context builder emits. Keep in step with the producers:
 * workspace files and ChatGPT imports (sha256 hex, context_sources.rs `hash`), earlier meetings
 * (`record:<id>`, context_sources.rs), the derived summary (`summary:<state id>`, snapshots.ts),
 * public research (`web:<workspace>:<https URL>`, research.rs and preparationEvidence.ts), and
 * transcript segments (`segment:<chunk uuid>` and its English `segment:<uuid>:en`, recording.rs and
 * the local speech helper).
 */
export const productEvidenceSources = [
  "3f5a9c0e7b1d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5",
  "record:meeting_2026-11-04-a1",
  "summary:6c1e9f52-1f0a-4b9e-9c55-0b7d3a2f1e44",
  "web:workspace-1:https://example.com/r%C3%BCckblick/plan?q=rollout%20date&lang=de#ziele",
  `web:workspace-1:https://example.org/${"standards/".repeat(195)}soc2`,
];
export const productSegmentIds = [
  "0b9c3f0e-5d6a-4b8f-9e21-7c4d2a1b3e5f",
  "0b9c3f0e-5d6a-4b8f-9e21-7c4d2a1b3e5f:en",
];
