// Child process for `cargo test --test service_wire` (tests/service_wire.rs).
// Runs the real managed service (apps/service) twice on loopback ports with a
// fixture identity, a fixture billing stand-in and a fake model provider, and
// builds the request payloads with the real packages/core code the renderer
// uses. Nothing here reaches beyond 127.0.0.1 and no key is real.
//
// Protocol: one JSON line on stdout once ready ({main, tight, payload}); then one
// JSON line per JSON command read from stdin. Exits when stdin closes.
// Started through vite-node because packages/core uses extensionless imports.
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createService } from "../../../../service/src/app.mjs";
import { loadConfig } from "../../../../service/src/config.mjs";
import { ServiceError } from "../../../../service/src/errors.mjs";
import {
  buildContext,
  cardFromResult,
  createGuidanceJob,
  createMeetingState,
  effectiveContext,
  guidancePrompt,
  meetingProfiles,
  reduceMeetingEvent,
  SnapshotStore,
  type MeetingState,
  type SourceHit,
  type SpeechEvent,
} from "../../../../../packages/core/src/index";

const workspaceRoot = process.env.WIRE_ROOT!;
const home = process.env.WIRE_HOME!;
if (!workspaceRoot || !home) throw new Error("WIRE_ROOT and WIRE_HOME are required");

function env(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "development",
    SERVICE_ORIGIN: "http://127.0.0.1",
    DATABASE_PATH: ":memory:",
    OIDC_ISSUER: "https://identity.invalid",
    OIDC_CLIENT_ID: "service-wire",
    OIDC_CLIENT_SECRET: "service-wire-local-only",
    STRIPE_SECRET_KEY: "sk_test_service_wire",
    STRIPE_WEBHOOK_SECRET: "whsec_service_wire",
    STRIPE_MODE: "test",
    STRIPE_STANDARD_PRICE_ID: "price_wire_standard",
    STRIPE_PREMIUM_PRICE_ID: "price_wire_premium",
    LUNA_PROVIDER_URL: "https://provider.invalid/v1/responses",
    LUNA_API_KEY: "unused-fake-provider",
    LUNA_MODEL: "wire-fast",
    SOL_PROVIDER_URL: "https://provider.invalid/v1/responses",
    SOL_API_KEY: "unused-fake-provider",
    SOL_MODEL: "wire-deep",
    JEV_API_KEY: "unused-fake-provider",
    STANDARD_REQUESTS: "1000",
    STANDARD_INPUT_TOKENS: "100000000",
    STANDARD_OUTPUT_TOKENS: "10000000",
    PREMIUM_REQUESTS: "1000",
    PREMIUM_INPUT_TOKENS: "100000000",
    PREMIUM_OUTPUT_TOKENS: "10000000",
    ...overrides,
  };
}

const identity = {
  async authorizationUrl(flow: { state: string }) {
    return `https://identity.invalid/authorize?state=${flow.state}`;
  },
  async authenticate() {
    return {
      issuer: "https://identity.invalid",
      subject: "service-wire",
      email: "zoe@example.test",
      name: "Zoë Wire",
    };
  },
};
const checkout = () => ({
  id: "cs_service_wire",
  status: "open",
  url: "https://checkout.stripe.com/c/pay/service-wire",
  expiresAtMs: Date.now() + 1800000,
});
const premiumBilling = {
  verify() {
    throw new Error("Webhooks are not used by the wire test");
  },
  async customer() {
    return "cus_service_wire";
  },
  async checkout() {
    return checkout();
  },
  async getCheckout() {
    return checkout();
  },
  async expireCheckout() {},
  async portal() {
    return { url: "https://billing.stripe.com/p/session/service-wire" };
  },
  async reconcile(_customer: unknown, now: number) {
    return { plan: "premium", status: "active", periodEnd: now + 86400000 };
  },
};

const text: Record<string, string> = {
  gap: "The plan date and the remote update disagree.",
  headline: "Zürich rollout date",
  say: "The Zürich plan sets the start for 3 März. Does that date still hold?",
  why: "The plan in the workspace names 3 März; the latest remote turn sounds less certain.",
};
/**
 * A valid answer for a live card schema, with non-ASCII text. Like a real model, it cites an ID
 * from the context it received (the schema only gives the ID's form, `items.pattern`). IDs the
 * pattern rejects are filtered out silently here; what catches a pattern regression is the wire
 * test's exact assertion on the card's evidence (`["src-plan"]`).
 */
function sample(schema: any, job: any): any {
  const context = job.basis ? effectiveContext(job.basis) : { sources: [], conversation: [] };
  const known = [
    ...context.sources.map((s) => s.sourceId),
    ...context.conversation.map((s) => `segment:${s.segmentId}`),
  ];
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    if (prop.type === "string") out[key] = text[key] ?? "Zürich";
    else if (prop.type === "number") out[key] = 0.8;
    else if (prop.type === "boolean") out[key] = false;
    else if (prop.type === "array") {
      const items = prop.items ?? {};
      const options: string[] =
        items.enum ?? (items.pattern ? known.filter((id) => new RegExp(items.pattern, "u").test(id)) : []);
      out[key] =
        prop.maxItems === 0 ? [] : options.includes("src-plan") ? ["src-plan"] : options.slice(0, 1);
    }
  }
  return out;
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });

/** The fake provider. A marker in the prompt picks the behaviour. */
function fakeProvider() {
  const seen: { reasoning?: unknown; decide?: unknown } = {};
  return {
    seen,
    async run(job: any, prompt: string, signal: AbortSignal, onText?: (t: string) => Promise<void>, onReset?: () => Promise<void>) {
      seen.reasoning = { job, prompt };
      if (prompt.includes("[wire:refuse]"))
        throw Object.assign(new ServiceError(502, "providerUnavailable"), { providerNotAccepted: true });
      if (prompt.includes("[wire:hold]")) await sleep(1500, signal);
      const output = sample(job.outputSchema, job);
      if (onText && onReset) {
        // A route switch mid-answer: the first fragment is void.
        await onText('{"say":"Abandoned');
        await onReset();
        const full = JSON.stringify(output);
        const cut = Math.floor(full.length / 2);
        await onText(full.slice(0, cut));
        await onText(full.slice(cut));
      }
      return {
        provider: job.lane === "deep" ? "managedDeep" : "managedFast",
        model: "wire-fixture",
        output,
        usage: { input: 120, output: 40 },
      };
    },
    async decide(basis: unknown, context: unknown, questions: Record<string, any>) {
      seen.decide = { basis, context, questions };
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
        else {
          const keys = Object.keys(q.criteria);
          answers[id] = {
            type: "choice",
            choice: keys[0],
            confidence: 0.9,
            probabilities: Object.fromEntries(keys.map((k, n) => [k, n === 0 ? 1 : 0])),
          };
        }
      }
      return { answers, model: "wire-fixture", usage: { input: 30, output: 5 } };
    },
  };
}

async function start(overrides: Record<string, string>) {
  const config = loadConfig(env(overrides));
  if (!config.providerConfigured) throw new Error("fixture service configuration incomplete");
  const provider = fakeProvider();
  // How far the service's clock runs behind the Mac's (the `skew` command).
  const clock = { skewMs: 0 };
  const app = createService({
    config,
    oidc: identity,
    billing: premiumBilling,
    provider,
    now: () => Date.now() - clock.skewMs,
  } as any);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  // The device page and the poll must agree with the real origin and port.
  config.origin = base;
  // Poll every second (the production value is 5 s) to keep the test fast.
  config.pollIntervalMs = 1000;
  return { base, provider, app, config, clock };
}

/** A meeting as the renderer builds it: real reducer, snapshot store and context builder. */
function payload() {
  let state: MeetingState = createMeetingState({
    id: "meeting-wire",
    workspaceId: "ws-wire",
    purpose: "Review the Zürich rollout with the Søndergaard team",
    objectives: ["Agree the Zürich rollout date"],
    attendees: [
      { id: "person-zoe", name: "Zoë Ångström" },
      { id: "person-soren", name: "Søren Kierkegård" },
    ],
    selfName: "José Núñez",
    profileId: "interview",
    profileRevision: 1,
  } as any);
  let sequence = 0;
  const speech = (lane: "me" | "remote", language: string, words: string, extra: Partial<SpeechEvent> = {}): void => {
    sequence++;
    state = reduceMeetingEvent(state, {
      kind: "speech",
      event: {
        meetingId: state.id,
        segmentId: `seg-${sequence}`,
        revision: 1,
        journalSequence: sequence,
        lane,
        startMs: sequence * 4000,
        endMs: sequence * 4000 + 3500,
        language,
        text: words,
        kind: "final",
        ...extra,
      },
    } as any);
  };
  speech("me", "en", "Where are we on the Zürich rollout?");
  speech("remote", "de", "Wir starten am 3. März, wenn die Schulung fertig ist.");
  speech("remote", "en", "We start on 3 March if the training is done.", {
    kind: "translation",
    sourceSegmentId: "seg-2",
    segmentId: "seg-2-en",
  } as any);
  const hit = (sourceId: string, title: string, locator: string, body: string): SourceHit => ({
    sourceId,
    workspaceId: "ws-wire",
    kind: "file",
    title,
    text: body,
    locator,
    revision: 1,
    derived: false,
  });
  const hits = [
    hit("src-plan", "Zürich plan", `${workspaceRoot}/Plans/Zürich plan.md#Ziele:part1`, "Rollout in Zürich beginnt am 3. März."),
    hit("src-outside", "Ångström notes", `${home}/Downloads/Ångström notes.pdf#page:2`, "Training owner: the Zürich team."),
    hit("src-users", "Brief", "/Users/jane.doe/Desktop/brief.md", "Budget approved in January."),
    hit("src-web", "Rollout guide", "https://example.com/rollout?token=abc#top", "Public rollout checklist."),
  ];
  const snapshots = new SnapshotStore();
  snapshots.publish(
    {
      snapshotId: "snapshot-wire",
      meetingId: state.id,
      context: buildContext(state, hits),
      candidates: [],
      createdAtMs: Date.now(),
      transcriptThroughSequence: state.observationSequence,
    },
    state.segments,
  );
  // A turn after the snapshot: the hotkey reads it as a transcript delta.
  speech("remote", "de", "Die Schulung ist vielleicht erst im April fertig.");
  const basis = snapshots.read(state);
  const job = createGuidanceJob("respond", basis, "requested");
  const profile = meetingProfiles[basis.profileId];
  return {
    job,
    prompt: guidancePrompt(job),
    decide: {
      basis,
      effectiveContext: effectiveContext(basis),
      // The questions runtime.ts asks for automatic assistance.
      questions: {
        research: { type: "noul", instructions: "Would verifying a public fact materially improve this conversation now?" },
        intent: {
          type: "choice",
          instructions: "Which available intervention would most advance this meeting?",
          criteria: Object.fromEntries(profile.automaticIntents.map((intent) => [intent, intent])),
        },
        intervene: { type: "noul", instructions: "Is there a specific worthwhile opportunity to intervene now?" },
      },
    },
  };
}

const main = await start({});
// One request a month and no decision route: quota, refund and 503 paths.
const tight = await start({ PREMIUM_REQUESTS: "1", JEV_API_KEY: "" });
const services = { main, tight } as const;
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
write({ main: main.base, tight: tight.base, payload: payload() });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  try {
    if (command.cmd === "seen") write(services[command.service as "main" | "tight"].provider.seen);
    // What the renderer does with the native result: the card it would show.
    // The service's clock runs `ms` behind the Mac's.
    else if (command.cmd === "skew") {
      services[command.service as "main" | "tight"].clock.skewMs = command.ms;
      write({ ok: true });
    }
    // Renew sessions this close to expiry (to renew a fresh session in the test).
    else if (command.cmd === "renewWindow") {
      services[command.service as "main" | "tight"].config.sessionRenewWindowMs = command.ms;
      write({ ok: true });
    }
    else if (command.cmd === "card") write({ card: cardFromResult(command.result, command.job) ?? null });
    else write({ error: `unknown command ${command.cmd}` });
  } catch (error) {
    write({ error: String(error) });
  }
}
for (const { app } of Object.values(services)) {
  app.server.closeAllConnections();
  app.server.close();
  app.close();
}
process.exit(0);
