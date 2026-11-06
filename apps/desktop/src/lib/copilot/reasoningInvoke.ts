import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelJob, ModelResult } from "@live-interview/core";

/**
 * Unvalidated output fragments of a streaming provider call, in order. `reset`
 * voids everything received so far (the service switched routes mid-answer).
 */
export type DraftUpdate = { delta: string } | { reset: true };

/**
 * The only way the renderer calls the native `reasoning_run` command.
 *
 * Tauri deserialises a `Channel` argument as a required key, so a call without
 * `onDraft` fails before it reaches the service. This helper always opens a
 * channel, routes provisional fragments to `onDraft` when given, and silences
 * the channel once the call settles so a late fragment cannot resurrect a draft.
 */
export async function invokeReasoning<R extends ModelResult = ModelResult>(
  job: ModelJob,
  prompt: string,
  onDraft?: (update: DraftUpdate) => void,
): Promise<R> {
  const onDraftChannel = new Channel<DraftUpdate>();
  onDraftChannel.onmessage = onDraft ?? (() => {});
  try {
    return await invoke<R>("reasoning_run", {
      job,
      prompt,
      onDraft: onDraftChannel,
    });
  } finally {
    onDraftChannel.onmessage = () => {};
  }
}
