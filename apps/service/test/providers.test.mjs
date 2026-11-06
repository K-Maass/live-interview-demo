import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CommercialProviders, LIVE_DEEP_FIRST_TEXT_MS, promptCacheKey } from "../src/providers.mjs";
import { loadConfig } from "../src/config.mjs";
const job = {
  lane: "fast",
  deadlineMs: Date.now() + 60000,
  outputSchema: {
    type: "object",
    properties: { say: { type: "string" } },
    required: ["say"],
    additionalProperties: false,
  },
};
async function fixture(
  t,
  {
    deepFails = false,
    malformed = false,
    streamTooLarge = false,
    wait = false,
    redirect = false,
    lunaStatus,
    deepHangs = false,
  } = {},
) {
  const requests = [];
  let received;
  const firstRequest = new Promise((r) => (received = r));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    received();
    res.setHeader("Content-Type", "application/json");
    if (wait) return;
    if (redirect) {
      res.writeHead(302, { location: "https://attacker.invalid/collect" });
      return res.end();
    }
    if (body.model === "paid-sol" && deepHangs) return;
    if (body.model === "paid-luna" && lunaStatus) {
      res.statusCode = lunaStatus;
      return res.end(JSON.stringify({ error: { message: "synthetic-secret" } }));
    }
    if (body.model === "paid-sol" && deepFails) {
      res.statusCode = 503;
      return res.end(
        JSON.stringify({
          error: { message: "upstream private detail synthetic-secret" },
        }),
      );
    }
    if (req.url === "/jev") {
      return res.end(
        JSON.stringify({
          model: "jev-latest",
          answers: { gap: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
        }),
      );
    }
    const result = {
      model: body.model,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: malformed
                ? "unstructured prose"
                : JSON.stringify({ say: "Who owns the next step?" }),
            },
          ],
        },
      ],
      usage: { input_tokens: 50, output_tokens: 12 },
    };
    res.end(streamTooLarge ? "x".repeat(1100000) : JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const local = `http://127.0.0.1:${server.address().port}`;
  const config = {
    providerConfigured: true,
    maxOutput: 128,
    providers: {
      luna: {
        url: "https://commercial.fixture/luna",
        key: "test-luna-commercial-key",
        model: "paid-luna",
      },
      sol: {
        url: "https://commercial.fixture/sol",
        key: "test-sol-commercial-key",
        model: "paid-sol",
      },
      jev: {
        url: "https://commercial.fixture/jev",
        key: "test-jev-commercial-key",
        model: "jev-latest",
      },
    },
  };
  const adapter = new CommercialProviders(config, {
    fetch: async (url, options) =>
      fetch(local + new URL(url).pathname, options),
  });
  return { adapter, requests, firstRequest };
}
test("fast reasoning uses server Luna key/model and sends only bounded text with storage disabled", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.run(
    job,
    "A transcript text excerpt.",
    new AbortController().signal,
  );
  assert.equal(result.provider, "managedFast");
  assert.equal(result.model, "paid-luna");
  assert.deepEqual(result.output, { say: "Who owns the next step?" });
  assert.deepEqual(result.usage, { input: 50, output: 12 });
  assert.equal(f.requests[0].authorization, "Bearer test-luna-commercial-key");
  const b = f.requests[0].body;
  assert.equal(b.model, "paid-luna");
  assert.equal(b.store, false);
  assert.equal(b.max_output_tokens, 128);
  assert.equal(b.text.format.strict, true);
  assert.equal(b.tools, undefined);
  assert.ok(
    b.input.every((m) => m.content.every((c) => c.type === "input_text")),
  );
});
test("a deep route refused before running falls back to Luna with truthful provenance and Luna's own usage", async (t) => {
  const f = await fixture(t, { deepFails: true });
  const result = await f.adapter.run(
    { ...job, lane: "deep" },
    "text",
    new AbortController().signal,
  );
  assert.deepEqual(
    f.requests.map((r) => r.body.model),
    ["paid-sol", "paid-luna"],
  );
  assert.equal(result.provider, "managedFast");
  assert.equal(result.model, "paid-luna");
  // Sol answered 503 with no body, so it provably ran nothing: Luna's report is the whole cost.
  assert.deepEqual(result.usage, { input: 50, output: 12 });
});
test("a deep route that may have spent tokens leaves the fallback without usage, so the reservation stands", async (t) => {
  const f = await fixture(t, { deepHangs: true });
  const result = await f.adapter.run(
    { ...job, lane: "deep", deadlineMs: Date.now() + 1500 },
    "text",
    new AbortController().signal,
  );
  assert.deepEqual(
    f.requests.map((r) => r.body.model),
    ["paid-sol", "paid-luna"],
  );
  assert.equal(result.provider, "managedFast");
  assert.equal(result.usage, undefined);
});
test("successful deep reasoning reports managedDeep without touching a personal subscription", async (t) => {
  const f = await fixture(t);
  const r = await f.adapter.run(
    { ...job, lane: "deep" },
    "text",
    new AbortController().signal,
  );
  assert.equal(r.provider, "managedDeep");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer test-sol-commercial-key");
});
test("Jev uses its own key and typed state/questions API and normalizes token usage", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.decide(
    {
      profileId: "discovery",
      stateRevision: 2,
      profileRevision: 3,
      observationSequence: 4,
    },
    { purpose: "Test" },
    { gap: { type: "noul", instructions: "Is approval unclear?" } },
    new AbortController().signal,
  );
  assert.equal(f.requests[0].authorization, "Bearer test-jev-commercial-key");
  assert.equal(f.requests[0].body.model, "jev-latest");
  assert.deepEqual(f.requests[0].body.state, {
    context: { purpose: "Test" },
    profileId: "discovery",
    stateRevision: 2,
    profileRevision: 3,
    observationSequence: 4,
  });
  assert.equal(result.answers.gap.noul, 0.9);
  assert.deepEqual(result.usage, { input: 11, output: 2 });
});
test("the decide route sends no retention flag; the privacy notice says so per route", async (t) => {
  // The Jev state/questions API (api.typesafe.ai/v1/systemone) has no known
  // "do not store" parameter, so none is invented here. The privacy notice
  // (docs/privacy.md) states `store: false` only for
  // the fast and deep routes. If this payload ever gains a retention field,
  // update that section too.
  const f = await fixture(t);
  await f.adapter.decide(
    { profileId: "p", stateRevision: 1, profileRevision: 1, observationSequence: 1 },
    { purpose: "Test" },
    { gap: { type: "noul", instructions: "Is approval unclear?" } },
    new AbortController().signal,
  );
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), [
    "model",
    "questions",
    "state",
  ]);
  const notice = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../../../docs/privacy.md", import.meta.url),
      "utf8",
    ),
  );
  assert.match(notice, /structured-decision route[^\n]*no "do not store" option/);
});
for (const status of [401, 429, 503])
  test(`a provider ${status} before any body is marked as not accepted`, async (t) => {
    const f = await fixture(t, { lunaStatus: status });
    await assert.rejects(
      () => f.adapter.run(job, "text", new AbortController().signal),
      (e) =>
        e.code === "providerUnavailable" &&
        e.providerNotAccepted === true &&
        !e.message.includes("synthetic-secret"),
    );
  });
test("a deep refusal followed by a fast refusal is still not accepted", async (t) => {
  const f = await fixture(t, { deepFails: true, lunaStatus: 429 });
  await assert.rejects(
    () =>
      f.adapter.run({ ...job, lane: "deep" }, "text", new AbortController().signal),
    (e) => e.providerNotAccepted === true,
  );
  assert.equal(f.requests.length, 2);
});
test("a fast refusal after a deep route that may have spent tokens is not marked", async (t) => {
  const f = await fixture(t, { deepHangs: true, lunaStatus: 503 });
  await assert.rejects(
    () =>
      f.adapter.run(
        { ...job, lane: "deep", deadlineMs: Date.now() + 300 },
        "text",
        new AbortController().signal,
      ),
    (e) => e.code === "providerUnavailable" && !e.providerNotAccepted,
  );
});
test("a decision refused by the provider before any body is not accepted", async (t) => {
  const f = await fixture(t);
  const adapter = new CommercialProviders(
    { ...f.adapter.config },
    { fetch: async () => new Response("{}", { status: 401 }) },
  );
  await assert.rejects(
    () =>
      adapter.decide(
        { profileId: "discovery", stateRevision: 1, profileRevision: 1, observationSequence: 0 },
        {},
        {},
        new AbortController().signal,
      ),
    (e) => e.providerNotAccepted === true,
  );
});
for (const flag of ["malformed", "streamTooLarge", "redirect"])
  test(`commercial provider rejects ${flag} response without returning upstream detail`, async (t) => {
    const f = await fixture(t, { [flag]: true });
    await assert.rejects(
      () => f.adapter.run(job, "text", new AbortController().signal),
      (e) => !e.message.includes("synthetic-secret"),
    );
  });
test("cancellation aborts provider request promptly and never falls back after abort", async (t) => {
  const f = await fixture(t, { wait: true });
  const cancel = new AbortController();
  const pending = f.adapter.run(
    { ...job, lane: "deep" },
    "text",
    cancel.signal,
  );
  // Cancel once the deep request has reached the provider, not after a guessed delay.
  await f.firstRequest;
  cancel.abort();
  await assert.rejects(() => pending);
  assert.equal(f.requests.length, 1);
});

// --- Streaming ---

const sseLine = (event) => `data: ${JSON.stringify(event)}\n\n`;
const textDelta = (delta) => ({ type: "response.output_text.delta", delta });
const completed = (model, say = "Who owns the next step?") => ({
  type: "response.completed",
  response: {
    model,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ say }) }],
      },
    ],
    usage: { input_tokens: 50, output_tokens: 12 },
  },
});
/** `script(model, res, request)` writes the provider's event stream. */
async function streamFixture(
  t,
  script,
  { contentType = "text/event-stream" } = {},
) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body,
    });
    res.writeHead(200, { "content-type": contentType });
    await script(body.model, res, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const local = `http://127.0.0.1:${server.address().port}`;
  const route = (model) => ({
    url: `https://commercial.fixture/${model}`,
    key: `key-${model}`,
    model,
  });
  const adapter = new CommercialProviders(
    {
      providerConfigured: true,
      maxOutput: 128,
      providers: {
        luna: route("paid-luna"),
        sol: route("paid-sol"),
        jev: route("jev"),
      },
    },
    {
      fetch: async (url, options) =>
        fetch(local + new URL(url).pathname, options),
    },
  );
  return { adapter, requests };
}
const collect = () => {
  const fragments = [];
  return { fragments, onText: async (text) => void fragments.push(text) };
};

test("streaming sends stream:true with storage off, reports fragments in order, and returns the validated result", async (t) => {
  const f = await streamFixture(t, async (model, res) => {
    res.write(sseLine({ type: "response.created", response: {} }));
    // One event split across two chunks, and a CRLF-terminated event.
    const line = sseLine(textDelta('{"say":'));
    res.write(line.slice(0, 20));
    await new Promise((r) => setTimeout(r, 5));
    res.write(line.slice(20));
    res.write(
      `data: ${JSON.stringify(textDelta('"Who owns the next step?"}'))}\r\n\r\n`,
    );
    res.end(sseLine(completed(model)) + "data: [DONE]\n\n");
  });
  const c = collect();
  const result = await f.adapter.run(
    job,
    "text",
    new AbortController().signal,
    c.onText,
  );
  assert.deepEqual(c.fragments, ['{"say":', '"Who owns the next step?"}']);
  assert.equal(result.provider, "managedFast");
  assert.deepEqual(result.output, { say: "Who owns the next step?" });
  assert.deepEqual(result.usage, { input: 50, output: 12 });
  const b = f.requests[0].body;
  assert.equal(b.stream, true);
  assert.equal(b.store, false);
  assert.equal(b.tools, undefined);
  assert.equal(f.requests[0].authorization, "Bearer key-paid-luna");
});

test("fragments reach the consumer before the provider has finished", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = await streamFixture(t, async (model, res) => {
    res.write(sseLine(textDelta("{")));
    await gate;
    res.end(sseLine(completed(model)));
  });
  let first;
  const sawFirst = new Promise((r) => (first = r));
  const pending = f.adapter.run(
    job,
    "text",
    new AbortController().signal,
    async (text) => first(text),
  );
  assert.equal(await sawFirst, "{");
  release();
  assert.equal((await pending).provider, "managedFast");
});

for (const [name, script] of [
  [
    "a provider failure event",
    (m, res) => {
      res.write(sseLine(textDelta("{")));
      res.end(
        sseLine({
          type: "response.failed",
          response: { error: { message: "synthetic-secret" } },
        }),
      );
    },
  ],
  [
    "an incomplete response",
    (m, res) => res.end(sseLine({ type: "response.incomplete", response: {} })),
  ],
  [
    "an error event",
    (m, res) =>
      res.end(sseLine({ type: "error", message: "synthetic-secret" })),
  ],
  [
    "a stream that ends without a completed response",
    (m, res) => res.end(sseLine(textDelta("{"))),
  ],
  ["a malformed event", (m, res) => res.end("data: {not json\n\n")],
  [
    "a non-string text fragment",
    (m, res) =>
      res.end(sseLine({ type: "response.output_text.delta", delta: { x: 1 } })),
  ],
  [
    "a completed response with unstructured text",
    (m, res) =>
      res.end(
        sseLine({
          type: "response.completed",
          response: {
            model: m,
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "prose" }],
              },
            ],
          },
        }),
      ),
  ],
  [
    "a refusal",
    (m, res) =>
      res.end(
        sseLine({
          type: "response.completed",
          response: {
            model: m,
            output: [
              {
                type: "message",
                content: [{ type: "refusal", refusal: "synthetic-secret" }],
              },
            ],
          },
        }),
      ),
  ],
  [
    "an oversized stream",
    async (m, res) => {
      for (let i = 0; i < 12; i++)
        res.write(sseLine(textDelta("x".repeat(100000))));
      res.end();
    },
  ],
])
  test(`streaming rejects ${name} without returning upstream detail`, async (t) => {
    const f = await streamFixture(t, script);
    await assert.rejects(
      () =>
        f.adapter.run(
          job,
          "text",
          new AbortController().signal,
          async () => {},
        ),
      (e) =>
        e.status === 502 &&
        !JSON.stringify(e).includes("synthetic-secret") &&
        !e.message.includes("synthetic-secret"),
    );
  });

test("streaming rejects a JSON body or error status from the provider", async (t) => {
  const json = await streamFixture(t, (m, res) => res.end("{}"), {
    contentType: "application/json",
  });
  await assert.rejects(
    () =>
      json.adapter.run(
        job,
        "text",
        new AbortController().signal,
        async () => {},
      ),
    (e) => e.code === "invalidProviderResult",
  );
});

test("a deep failure before any text falls back to Luna; after text it does not", async (t) => {
  const before = await streamFixture(t, async (model, res) => {
    if (model === "paid-sol") {
      return res.destroy();
    }
    res.write(sseLine(textDelta("{")));
    res.end(sseLine(completed(model)));
  });
  const c = collect();
  const result = await before.adapter.run(
    { ...job, lane: "deep" },
    "text",
    new AbortController().signal,
    c.onText,
  );
  assert.deepEqual(
    before.requests.map((r) => r.body.model),
    ["paid-sol", "paid-luna"],
  );
  assert.equal(result.provider, "managedFast");
  assert.equal(result.usage, undefined);
  assert.deepEqual(c.fragments, ["{"]);

  const after = await streamFixture(t, async (model, res) => {
    res.write(sseLine(textDelta("{")));
    if (model === "paid-sol")
      return res.end(sseLine({ type: "response.failed", response: {} }));
    res.end(sseLine(completed(model)));
  });
  const c2 = collect();
  await assert.rejects(() =>
    after.adapter.run(
      { ...job, lane: "deep" },
      "text",
      new AbortController().signal,
      c2.onText,
    ),
  );
  assert.deepEqual(
    after.requests.map((r) => r.body.model),
    ["paid-sol"],
  );
  assert.deepEqual(c2.fragments, ["{"]);
});

test("a deep failure after text resets the consumer and falls back to Luna once", async (t) => {
  const f = await streamFixture(t, async (model, res) => {
    res.write(sseLine(textDelta(model === "paid-sol" ? "{sol" : "{luna")));
    // The connection drops mid-answer: a transport failure, not an invalid result.
    if (model === "paid-sol") return setTimeout(() => res.destroy(), 20);
    res.end(sseLine(completed(model)));
  });
  const seen = [];
  const result = await f.adapter.run(
    { ...job, lane: "deep" },
    "text",
    new AbortController().signal,
    async (text) => void seen.push(["text", text]),
    async () => void seen.push(["reset"]),
  );
  assert.deepEqual(
    f.requests.map((r) => r.body.model),
    ["paid-sol", "paid-luna"],
  );
  assert.deepEqual(seen, [["text", "{sol"], ["reset"], ["text", "{luna"]]);
  assert.equal(result.provider, "managedFast");
  assert.equal(result.usage, undefined);
});

test("cancelling a stream aborts the provider request and never falls back", async (t) => {
  const f = await streamFixture(t, async (model, res) => {
    res.write(sseLine(textDelta("{")));
  });
  const cancel = new AbortController();
  let first;
  const sawFirst = new Promise((r) => (first = r));
  const pending = f.adapter.run(
    { ...job, lane: "deep" },
    "text",
    cancel.signal,
    async () => first(),
  );
  await sawFirst;
  cancel.abort();
  await assert.rejects(
    () => pending,
    (e) => e.code === "requestCancelled",
  );
  assert.equal(f.requests.length, 1);
});

test("a failure event mid-stream closes the upstream request instead of letting the provider keep generating", async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => (upstreamClosed = r));
  const f = await streamFixture(t, async (_model, res) => {
    res.on("close", upstreamClosed);
    res.write(sseLine(textDelta("{")));
    res.write(sseLine({ type: "response.failed", response: {} }));
    // The provider would carry on; it is not ended here.
  });
  await assert.rejects(() =>
    f.adapter.run(job, "text", new AbortController().signal, async () => {}),
  );
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("upstream stayed open")), 2000),
    ),
  ]);
});

test("cached input tokens are carried through only when the provider reports a valid count", () => {
  const adapter = new CommercialProviders({ providerConfigured: true });
  const response = (usage) => ({
    status: "completed",
    model: "paid-luna",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"say":"Hello"}' }],
      },
    ],
    usage,
  });
  const usageOf = (usage) => adapter.finish("luna", response(usage)).usage;
  assert.deepEqual(
    usageOf({
      input_tokens: 50,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 32 },
    }),
    { input: 50, output: 12, cachedInput: 32 },
  );
  // A reported zero is a measurement, not a missing value.
  assert.deepEqual(
    usageOf({
      input_tokens: 50,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
    }),
    { input: 50, output: 12, cachedInput: 0 },
  );
  // Absent, malformed or impossible counts leave the field out and keep the rest.
  for (const details of [
    undefined,
    {},
    { cached_tokens: null },
    { cached_tokens: -1 },
    { cached_tokens: 1.5 },
    { cached_tokens: "7" },
    { cached_tokens: 51 },
  ])
    assert.deepEqual(
      usageOf({
        input_tokens: 50,
        output_tokens: 12,
        input_tokens_details: details,
      }),
      { input: 50, output: 12 },
    );
});

const providerEnv = {
  LUNA_PROVIDER_URL: "https://commercial.fixture/luna",
  LUNA_API_KEY: "test-luna-commercial-key",
  LUNA_MODEL: "paid-luna",
  SOL_PROVIDER_URL: "https://commercial.fixture/sol",
  SOL_API_KEY: "test-sol-commercial-key",
  SOL_MODEL: "paid-sol",
};
test("reasoning effort unset sends exactly the previous payload", async (t) => {
  const f = await fixture(t);
  await f.adapter.run(job, "A transcript text excerpt.", new AbortController().signal);
  assert.deepEqual(f.requests[0].body, {
    model: "paid-luna",
    store: false,
    input: [
      { role: "system", content: [{ type: "input_text", text: f.requests[0].body.input[0].content[0].text }] },
      { role: "user", content: [{ type: "input_text", text: "A transcript text excerpt." }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "meeting_result",
        strict: true,
        schema: job.outputSchema,
      },
    },
    max_output_tokens: 128,
  });
  assert.equal("reasoning" in f.requests[0].body, false);
});
test("reasoning effort is sent only on the route that configures it", async (t) => {
  const f = await fixture(t);
  f.adapter.config.providers.luna.reasoningEffort = "low";
  const signal = new AbortController().signal;
  await f.adapter.run(job, "text", signal);
  await f.adapter.run({ ...job, lane: "deep" }, "text", signal);
  const [fast, deep] = f.requests.map((r) => r.body);
  assert.equal(fast.model, "paid-luna");
  assert.deepEqual(fast.reasoning, { effort: "low" });
  assert.equal(deep.model, "paid-sol");
  assert.equal("reasoning" in deep, false);
  f.adapter.config.providers.sol.reasoningEffort = "high";
  await f.adapter.run({ ...job, lane: "deep" }, "text", signal);
  assert.deepEqual(f.requests[2].body.reasoning, { effort: "high" });
});
test("reasoning effort config accepts the four levels, ignores unset and rejects anything else without echoing it", () => {
  const unset = loadConfig(providerEnv);
  assert.equal("reasoningEffort" in unset.providers.luna, false);
  assert.equal("reasoningEffort" in unset.providers.sol, false);
  assert.equal(loadConfig({ ...providerEnv, LUNA_REASONING_EFFORT: "" }).providers.luna.reasoningEffort, undefined);
  for (const effort of ["minimal", "low", "medium", "high"]) {
    const c = loadConfig({
      ...providerEnv,
      LUNA_REASONING_EFFORT: effort,
      SOL_REASONING_EFFORT: effort,
    });
    assert.equal(c.providers.luna.reasoningEffort, effort);
    assert.equal(c.providers.sol.reasoningEffort, effort);
    assert.equal(c.missing.provider.some((m) => m.includes("REASONING")), false);
  }
  const bad = loadConfig({
    ...providerEnv,
    LUNA_REASONING_EFFORT: "sk-secret-looking-value",
    SOL_REASONING_EFFORT: "LOW",
  });
  assert.equal(bad.providers.luna.reasoningEffort, undefined);
  assert.equal(bad.providers.sol.reasoningEffort, undefined);
  assert.equal(bad.providerConfigured, false);
  const messages = bad.missing.provider.filter((m) => m.includes("REASONING"));
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => !m.includes("secret") && !m.includes("LOW")));
});
test("every call of a meeting carries the same hashed prompt_cache_key, which a route can turn off", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  await f.adapter.run({ ...job, meetingId: "meeting-a" }, "text", signal);
  await f.adapter.run({ ...job, meetingId: "meeting-a", lane: "deep" }, "text", signal);
  await f.adapter.run({ ...job, meetingId: "meeting-b" }, "text", signal);
  const keys = f.requests.map((r) => r.body.prompt_cache_key);
  assert.equal(keys[0], promptCacheKey("meeting-a"));
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[0]);
  // The meeting ID itself never reaches the provider.
  assert.ok(!JSON.stringify(f.requests.map((r) => r.body)).includes("meeting-a"));
  assert.ok(keys[0].length <= 64);
  f.adapter.config.promptCacheKey = false;
  await f.adapter.run({ ...job, meetingId: "meeting-a" }, "text", signal);
  assert.equal("prompt_cache_key" in f.requests[3].body, false);
  assert.equal(loadConfig(providerEnv).promptCacheKey, true);
  assert.equal(loadConfig({ ...providerEnv, PROVIDER_PROMPT_CACHE_KEY: "off" }).promptCacheKey, false);
});
test("a requested digDeeper on the deep lane falls back to the fast route when the deep route is silent past its cap", async (t) => {
  const f = await fixture(t, { deepHangs: true });
  const signal = new AbortController().signal;
  const started = Date.now();
  const result = await f.adapter.run(
    { ...job, lane: "deep", intent: "digDeeper", trigger: "requested" },
    "text",
    signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.provider, "managedFast");
  assert.deepEqual(f.requests.map((r) => r.body.model), ["paid-sol", "paid-luna"]);
  // The deep attempt may have spent tokens: no usage, so the reservation stands.
  assert.equal(result.usage, undefined);
  assert.ok(elapsed >= LIVE_DEEP_FIRST_TEXT_MS - 50 && elapsed < LIVE_DEEP_FIRST_TEXT_MS + 3000, `${elapsed} ms`);
});
test("the live deep cap does not apply to reviews or an automatic digDeeper", async (t) => {
  const f = await fixture(t, { deepHangs: true });
  for (const variant of [
    { intent: "checkConversation", trigger: "requested" },
    { intent: "digDeeper", trigger: "automatic" },
  ]) {
    const controller = new AbortController();
    const pending = f.adapter.run({ ...job, ...variant, lane: "deep", deadlineMs: Date.now() + 10_000 }, "text", controller.signal);
    // Still on the deep route after the live cap: nothing fell back.
    await new Promise((r) => setTimeout(r, LIVE_DEEP_FIRST_TEXT_MS + 300));
    assert.deepEqual(f.requests.map((r) => r.body.model).filter((m) => m === "paid-luna"), [], variant.intent);
    controller.abort();
    await assert.rejects(pending);
    f.requests.length = 0;
  }
});
test("a requested digDeeper whose deep route streams before the cap keeps the deep answer", async (t) => {
  const f = await streamFixture(t, async (model, res) => {
    res.write(sseLine(textDelta("{")));
    // Finishes after the cap: the first text came in time, so the deep answer stands.
    await new Promise((r) => setTimeout(r, LIVE_DEEP_FIRST_TEXT_MS + 300));
    res.end(sseLine(completed(model)));
  });
  const result = await f.adapter.run(
    { ...job, lane: "deep", intent: "digDeeper", trigger: "requested" },
    "text",
    new AbortController().signal,
    async () => {},
  );
  assert.equal(result.provider, "managedDeep");
});
