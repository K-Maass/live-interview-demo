import assert from "node:assert/strict";
import { CommercialProviders } from "../apps/service/src/providers.mjs";
import { decisionResult, validateSchema } from "../apps/service/src/validation.mjs";
import { guidanceLane } from "../packages/core/src/guidance/engine";
import { meetingProfiles } from "../packages/core/src/guidance/profiles";

const profile = meetingProfiles.discovery;
const basis = { profileId: profile.id, profileRevision: 1, observationSequence: 1, stateRevision: 1 };
const questions = {
  intervene: { type: "noul", instructions: "Did a worthwhile unresolved issue just emerge?" },
  intent: {
    type: "choice",
    instructions: "Which intervention would advance the conversation?",
    criteria: Object.fromEntries(profile.automaticIntents.map((intent) => [intent, intent])),
  },
  research: { type: "noul", instructions: "Would verifying a public fact help?" },
};
const turns = [
  { transcript: "The agenda is on screen.", intervene: 0.15 },
  { transcript: "Security owns final approval and has not signed off.", intervene: 0.91 },
];
const prompts = {
  luna: "Who can confirm Security approval, and by when?",
  sol: "What changes about Friday’s launch if approval is still pending on Thursday?",
};

const called: string[] = [];
let forceDeepFailure = false;
const route = (name: string) => ({
  url: `https://fixture.invalid/${name}`,
  model: `fixture-${name}`,
  key: "local-test-placeholder",
});
const adapter = new CommercialProviders(
  {
    providerConfigured: true,
    maxOutput: 128,
    providers: { jev: route("jev"), luna: route("luna"), sol: route("sol") },
  },
  {
    fetch: async (url: string | URL, options: { body: string }) => {
      const target = new URL(url);
      assert.equal(target.hostname, "fixture.invalid");
      const path = target.pathname.slice(1);
      const body = JSON.parse(options.body);
      called.push(path);
      if (path === "jev") {
        const turn = turns.find((item) => item.transcript === body.state.context.transcript);
        assert.ok(turn);
        return Response.json({
          model: body.model,
          answers: {
            intervene: { type: "noul", noul: turn.intervene },
            intent: {
              type: "choice",
              choice: "digDeeper",
              confidence: 1,
              probabilities: Object.fromEntries(
                profile.automaticIntents.map((intent) => [intent, intent === "digDeeper" ? 1 : 0]),
              ),
            },
            research: { type: "noul", noul: 0.05 },
          },
        });
      }
      if (path === "sol" && forceDeepFailure) return new Response(null, { status: 503 });
      assert.ok(path === "luna" || path === "sol");
      return Response.json({
        model: body.model,
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ say: prompts[path] }) }],
        }],
      });
    },
  },
);

const outputSchema = {
  type: "object",
  properties: { say: { type: "string" } },
  required: ["say"],
  additionalProperties: false,
};
const validateOutput = validateSchema(outputSchema);
const signal = new AbortController().signal;
async function card(trigger: "requested" | "automatic") {
  const lane = guidanceLane("digDeeper", trigger, "premium");
  const result = await adapter.run(
    { lane, outputSchema, deadlineMs: Date.now() + 10_000 },
    turns[1].transcript,
    signal,
  );
  assert.ok(validateOutput(result.output));
  console.log(`  ${lane} → ${result.model}: ${result.output.say}`);
}

console.log("Synthetic fixture replay (no audio capture, accounts, or network calls)");
for (const turn of turns) {
  const result = await adapter.decide(basis, { transcript: turn.transcript }, questions, signal);
  decisionResult(result, questions);
  const accepted = result.answers.intervene.noul >= profile.threshold &&
    profile.automaticIntents.includes(result.answers.intent.choice);
  console.log(`Jev fixture ${result.answers.intervene.noul} / threshold ${profile.threshold} → ${accepted ? "intervene" : "abstain"}`);
  if (accepted) await card("automatic");
}
console.log("Explicit Dig deeper");
await card("requested");
console.log("Explicit Dig deeper with a simulated deep-route outage");
forceDeepFailure = true;
await card("requested");
assert.deepEqual(called, ["jev", "jev", "luna", "sol", "sol", "luna"]);
