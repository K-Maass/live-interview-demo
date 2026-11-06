import Ajv from "ajv";
import { fail } from "./errors.mjs";
import { PROVIDER_BUDGET_MS } from "./deadlines.mjs";
export const object = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function exact(v, allowed, required = allowed) {
  if (
    !object(v) ||
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    required.some((k) => !(k in v))
  )
    fail(400, "invalidRequest");
}
/** A locator that reveals a local file path (and usually the user name). */
export const localPathLocator = (locator) =>
  /^(?:[/~\\]|file:|[A-Za-z]:[\\/])/i.test(locator) ||
  locator.includes("/Users/");
export function textOnly(value) {
  let count = 0;
  function walk(v, depth = 0) {
    if (++count > 30000 || depth > 32) fail(400, "invalidRequest");
    if (typeof v === "string") {
      if (
        /data:(?:audio|video|application\/octet-stream)|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/i.test(
          v,
        ) ||
        (v.length > 1000 &&
          /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(v) &&
          !/[ ]/.test(v))
      )
        fail(400, "textOnlyBoundary");
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (object(v)) {
      for (const [key, item] of Object.entries(v)) {
        if (
          /audio|base64|pcm|waveform|bytes|^api[_-]?key$|password|credential|secret|authorization|cookie|^(?:access|refresh|session|id)[_-]?token$/i.test(
            key,
          )
        )
          fail(400, "textOnlyBoundary");
        walk(item, depth + 1);
      }
    } else if (
      v !== null &&
      typeof v !== "boolean" &&
      !(typeof v === "number" && Number.isFinite(v))
    )
      fail(400, "invalidRequest");
  }
  walk(value);
}
const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
/**
 * A source ID is cited back as evidence, so it gets the evidence-ID length limit (EVIDENCE_ID_PATTERN),
 * not the 200 of other IDs: a public-research ID is `web:<workspace>:<https URL>` and URLs run long.
 */
const sourceId = (v) => typeof v === "string" && v.length > 0 && v.length <= 2048;
const nonnegative = (v) => Number.isSafeInteger(v) && v >= 0;
const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function speech(event) {
  exact(
    event,
    [
      "meetingId",
      "segmentId",
      "revision",
      "journalSequence",
      "lane",
      "startMs",
      "endMs",
      "language",
      "text",
      "kind",
      "sourceSegmentId",
      "speakerClusterId",
      "confidence",
    ],
    [
      "meetingId",
      "segmentId",
      "revision",
      "journalSequence",
      "lane",
      "startMs",
      "endMs",
      "language",
      "text",
      "kind",
    ],
  );
  if (
    !id(event.meetingId) ||
    !id(event.segmentId) ||
    !nonnegative(event.revision) ||
    !nonnegative(event.journalSequence) ||
    !["me", "remote"].includes(event.lane) ||
    !nonnegative(event.startMs) ||
    !nonnegative(event.endMs) ||
    event.endMs < event.startMs ||
    typeof event.language !== "string" ||
    typeof event.text !== "string" ||
    !["partial", "final", "translation"].includes(event.kind)
  )
    fail(400, "invalidContext");
}
function brief(value) {
  exact(value, ["revision", "text", "objectives", "evidence"]);
  if (
    !nonnegative(value.revision) ||
    typeof value.text !== "string" ||
    !strings(value.objectives) ||
    !strings(value.evidence)
  )
    fail(400, "invalidContext");
}
export function validateContext(context) {
  exact(
    context,
    [
      "publicResearchTopics",
      "coveredObjectives",
      "pinnedTopics",
      "participants",
      "selfName",
      "attributions",
      "purpose",
      "objectives",
      "brief",
      "conversation",
      "sources",
      "stateRevision",
      "indexRevision",
      "briefRevision",
      "sourceRevisions",
    ],
    [
      "purpose",
      "objectives",
      "conversation",
      "sources",
      "stateRevision",
      "indexRevision",
      "briefRevision",
      "sourceRevisions",
    ],
  );
  if (
    typeof context.purpose !== "string" ||
    !strings(context.objectives) ||
    !Array.isArray(context.conversation) ||
    !Array.isArray(context.sources) ||
    !nonnegative(context.stateRevision) ||
    !nonnegative(context.indexRevision) ||
    !nonnegative(context.briefRevision) ||
    !object(context.sourceRevisions) ||
    Object.values(context.sourceRevisions).some((v) => !nonnegative(v)) ||
    // The display name the `me` lane is bound to (set by the app, never inferred).
    (context.selfName !== undefined &&
      (typeof context.selfName !== "string" || context.selfName.length > 200))
  )
    fail(400, "invalidContext");
  for (const key of [
    "publicResearchTopics",
    "coveredObjectives",
    "pinnedTopics",
  ])
    if (context[key] !== undefined && !strings(context[key]))
      fail(400, "invalidContext");
  for (const event of context.conversation) speech(event);
  for (const source of context.sources) {
    exact(source, [
      "sourceId",
      "workspaceId",
      "kind",
      "title",
      "text",
      "locator",
      "revision",
      "derived",
    ]);
    if (
      !sourceId(source.sourceId) ||
      !id(source.workspaceId) ||
      ["kind", "title", "text", "locator"].some(
        (k) => typeof source[k] !== "string",
      ) ||
      !nonnegative(source.revision) ||
      typeof source.derived !== "boolean"
    )
      fail(400, "invalidContext");
    // The app sends a workspace-relative label, a file name or a URL, never an
    // absolute local path (apps/desktop/src-tauri/src/reasoning/locator.rs).
    if (localPathLocator(source.locator)) fail(400, "localPathLocator");
  }
  if (context.brief !== undefined) brief(context.brief);
  if (context.participants !== undefined) {
    if (!Array.isArray(context.participants)) fail(400, "invalidContext");
    for (const person of context.participants) {
      exact(person, ["id", "name"]);
      if (!id(person.id) || typeof person.name !== "string")
        fail(400, "invalidContext");
    }
  }
  if (context.attributions !== undefined) {
    if (!Array.isArray(context.attributions)) fail(400, "invalidContext");
    for (const a of context.attributions) {
      exact(
        a,
        ["clusterId", "personId", "status", "evidence", "confirmedByUser"],
        ["clusterId", "status", "evidence"],
      );
      if (
        !id(a.clusterId) ||
        !["unattributed", "suggested", "established", "confirmed"].includes(
          a.status,
        ) ||
        !strings(a.evidence)
      )
        fail(400, "invalidContext");
    }
  }
}
export function validateBasis(basis) {
  exact(basis, [
    "snapshot",
    "transcriptDeltas",
    "invalidatedSourceIds",
    "observationSequence",
    "stateRevision",
    "profileId",
    "profileRevision",
  ]);
  if (
    !object(basis.snapshot) ||
    !Array.isArray(basis.transcriptDeltas) ||
    !strings(basis.invalidatedSourceIds) ||
    !nonnegative(basis.observationSequence) ||
    !nonnegative(basis.stateRevision) ||
    !nonnegative(basis.profileRevision) ||
    !["interview", "discovery", "workClient", "presentationAnswering"].includes(
      basis.profileId,
    )
  )
    fail(400, "invalidBasis");
  const snapshot = basis.snapshot;
  exact(snapshot, [
    "snapshotId",
    "meetingId",
    "context",
    "candidates",
    "createdAtMs",
    "transcriptThroughSequence",
  ]);
  if (
    !id(snapshot.snapshotId) ||
    !id(snapshot.meetingId) ||
    !Array.isArray(snapshot.candidates) ||
    !nonnegative(snapshot.createdAtMs) ||
    !nonnegative(snapshot.transcriptThroughSequence)
  )
    fail(400, "invalidBasis");
  validateContext(snapshot.context);
  for (const event of basis.transcriptDeltas) speech(event);
  for (const card of snapshot.candidates) {
    exact(
      card,
      [
        "trigger",
        "provisional",
        "id",
        "origin",
        "preparedFrom",
        "intent",
        "headline",
        "say",
        "why",
        "evidence",
        "createdAtMs",
        "basis",
        "asOfMs",
        "pinned",
        "stale",
        "usefulness",
        "relevance",
        "novelty",
        "answerQuality",
        "uncertain",
      ],
      [
        "id",
        "intent",
        "say",
        "why",
        "evidence",
        "createdAtMs",
        "basis",
        "pinned",
        "stale",
        "usefulness",
        "relevance",
        "novelty",
        "answerQuality",
        "uncertain",
      ],
    );
    validateBasis(card.basis);
  }
}
export function reasoningRequest(body) {
  exact(body, ["job", "prompt"]);
  textOnly(body);
  const job = body.job;
  exact(
    job,
    [
      "id",
      "meetingId",
      "lane",
      "intent",
      "trigger",
      "recentSuggestions",
      "brevityRetry",
      "basis",
      "outputSchema",
      "deadlineMs",
      "timeoutMs",
      "toolBudget",
      "refinesJobId",
      "refinesCardId",
      "preparation",
      "usageFeature",
    ],
    [
      "id",
      "meetingId",
      "lane",
      "intent",
      "trigger",
      "basis",
      "outputSchema",
      "toolBudget",
    ],
  );
  validateBasis(job.basis);
  if (
    !id(job.id) ||
    !id(job.meetingId) ||
    job.meetingId !== job.basis.snapshot.meetingId ||
    !["fast", "deep"].includes(job.lane) ||
    ![
      "digDeeper",
      "respond",
      "contribute",
      "checkConversation",
      "checkObjectives",
    ].includes(job.intent) ||
    !["requested", "automatic"].includes(job.trigger) ||
    typeof body.prompt !== "string" ||
    body.prompt.length < 1 ||
    body.prompt.length > 200000 ||
    // A relative timeout (preferred) or, from older apps, an absolute deadline.
    (job.timeoutMs === undefined && job.deadlineMs === undefined) ||
    (job.timeoutMs !== undefined &&
      (!Number.isSafeInteger(job.timeoutMs) ||
        job.timeoutMs <= 0 ||
        job.timeoutMs > PROVIDER_BUDGET_MS)) ||
    (job.deadlineMs !== undefined &&
      (!Number.isSafeInteger(job.deadlineMs) || job.deadlineMs <= 0)) ||
    !nonnegative(job.toolBudget) ||
    job.toolBudget > 10 ||
    (job.preparation !== undefined && typeof job.preparation !== "boolean") ||
    (job.usageFeature !== undefined &&
      !["live", "preparation", "automaticPreparation", "synthesis"].includes(
        job.usageFeature,
      ))
  )
    fail(400, "invalidJob");
  return validateSchema(job.outputSchema);
}
/**
 * The one string pattern an output schema may carry: the desktop's evidence-ID pattern
 * (`evidenceIdPattern` in packages/core/src/guidance/engine.ts; a core test checks they match).
 * Ajv runs schema patterns on provider output, so a client-chosen pattern is not accepted.
 */
export const EVIDENCE_ID_PATTERN = "^(segment:[^\\s]{1,2040}|[^\\s]{1,2048})$";
const schemaKeys = new Set([
  "type",
  "pattern",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "enum",
  "description",
  "title",
]);
export function validateSchema(schema) {
  let nodes = 0;
  function walk(s, depth) {
    if (
      !object(s) ||
      ++nodes > 128 ||
      depth > 12 ||
      Object.keys(s).some((k) => !schemaKeys.has(k))
    )
      fail(400, "invalidOutputSchema");
    if (
      ![
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
      ].includes(s.type)
    )
      fail(400, "invalidOutputSchema");
    if (s.properties) {
      if (!object(s.properties) || Object.keys(s.properties).length > 64)
        fail(400, "invalidOutputSchema");
      for (const property of Object.values(s.properties))
        walk(property, depth + 1);
    }
    if (s.items) walk(s.items, depth + 1);
    if (s.enum && (!Array.isArray(s.enum) || s.enum.length > 64))
      fail(400, "invalidOutputSchema");
    if (
      s.pattern !== undefined &&
      (s.type !== "string" || s.pattern !== EVIDENCE_ID_PATTERN)
    )
      fail(400, "invalidOutputSchema");
    if (
      s.additionalProperties !== undefined &&
      typeof s.additionalProperties !== "boolean"
    )
      fail(400, "invalidOutputSchema");
  }
  if (JSON.stringify(schema).length > 16000) fail(400, "invalidOutputSchema");
  walk(schema, 0);
  try {
    return new Ajv({
      strict: false,
      allErrors: false,
      validateFormats: false,
    }).compile(schema);
  } catch {
    fail(400, "invalidOutputSchema");
  }
}
export function decideRequest(body) {
  exact(
    body,
    ["basis", "effectiveContext", "questions"],
    ["basis", "questions"],
  );
  textOnly(body);
  validateBasis(body.basis);
  if (body.effectiveContext !== undefined)
    validateContext(body.effectiveContext);
  const q = body.questions;
  if (!object(q) || !Object.keys(q).length || Object.keys(q).length > 32)
    fail(400, "invalidQuestions");
  for (const [key, v] of Object.entries(q)) {
    if (!id(key)) fail(400, "invalidQuestions");
    exact(v, ["type", "instructions", "criteria"], ["type", "instructions"]);
    if (
      !["noul", "choice", "score"].includes(v.type) ||
      typeof v.instructions !== "string" ||
      !v.instructions ||
      v.instructions.length > 4000
    )
      fail(400, "invalidQuestions");
    if (
      v.type === "choice" &&
      (!object(v.criteria) ||
        !Object.keys(v.criteria).length ||
        Object.keys(v.criteria).length > 32 ||
        Object.values(v.criteria).some(
          (x) => typeof x !== "string" || x.length > 2000,
        ))
    )
      fail(400, "invalidQuestions");
    if (
      v.type === "score" &&
      (!Array.isArray(v.criteria) ||
        v.criteria.length < 2 ||
        v.criteria.length > 10 ||
        v.criteria.some((x) => typeof x !== "string" || x.length > 2000))
    )
      fail(400, "invalidQuestions");
    if (
      v.type === "noul" &&
      v.criteria !== undefined &&
      (!object(v.criteria) ||
        Object.keys(v.criteria).some((k) => !["true", "false"].includes(k)) ||
        Object.values(v.criteria).some(
          (x) => typeof x !== "string" || x.length > 2000,
        ))
    )
      fail(400, "invalidQuestions");
  }
}
export function validateUsage(usage, input, output) {
  if (
    usage !== undefined &&
    (!object(usage) ||
      !Number.isSafeInteger(usage.input) ||
      !Number.isSafeInteger(usage.output) ||
      usage.input < 0 ||
      usage.output < 0 ||
      usage.input > input ||
      usage.output > output ||
      // Optional and informational: the part of `input` the provider served from cache.
      (usage.cachedInput !== undefined &&
        (!Number.isSafeInteger(usage.cachedInput) ||
          usage.cachedInput < 0 ||
          usage.cachedInput > usage.input)))
  )
    fail(502, "invalidProviderResult");
}
export function decisionResult(result, questions) {
  if (
    !object(result) ||
    !object(result.answers) ||
    Object.keys(result.answers).length !== Object.keys(questions).length ||
    typeof result.model !== "string" ||
    !result.model ||
    result.model.length > 200
  )
    fail(502, "invalidProviderResult");
  for (const [id, q] of Object.entries(questions)) {
    const a = result.answers[id];
    if (!object(a) || a.type !== q.type) fail(502, "invalidProviderResult");
    const p = q.type === "noul" ? a.noul : a.confidence;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
      fail(502, "invalidProviderResult");
    if (
      q.type === "choice" &&
      (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))
    )
      fail(502, "invalidProviderResult");
    if (q.type !== "noul") {
      const keys = Object.keys(q.criteria);
      if (
        !object(a.probabilities) ||
        Object.keys(a.probabilities).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(a.probabilities, k)) ||
        Object.values(a.probabilities).some(
          (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
        ) ||
        Math.abs(
          Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1,
        ) > 0.02
      )
        fail(502, "invalidProviderResult");
      if (
        q.type === "score" &&
        (!Number.isFinite(a.score) ||
          a.score < 0 ||
          a.score > q.criteria.length - 1 ||
          !object(a.legend) ||
          Object.keys(a.legend).length !== keys.length ||
          keys.some((k) => a.legend[k] !== q.criteria[k]) ||
          Math.abs(
            keys.reduce((sum, k) => sum + Number(k) * a.probabilities[k], 0) -
              a.score,
          ) > 0.02)
      )
        fail(502, "invalidProviderResult");
    }
  }
  try {
    textOnly(result.answers);
  } catch {
    fail(502, "invalidProviderResult");
  }
}
