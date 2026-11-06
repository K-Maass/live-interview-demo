/**
 * What an interrupted call (cancelled by the client, or failed after the
 * provider had started answering) counts against the allowance.
 *
 * Admission reserves a conservative bound (`store.reserve`): input is the
 * request size in bytes plus 2,048, output is the output cap, both doubled on
 * the deep lane. A completed call is settled to the tokens the provider
 * reports. An interrupted call has no provider report, so this module
 * estimates what the provider spent from what the service saw:
 *
 *  - Nothing received (no streamed text yet, or a non-streaming call): the
 *    provider may have done any amount of work, so the whole reservation stays
 *    charged. `undefined` is returned and the caller settles nothing.
 *  - Some streamed text received: the provider certainly read the prompt and
 *    generated at least that text. Input is estimated from the bytes actually
 *    sent, output from the bytes actually received, both with a deliberately
 *    low bytes-per-token figure (so the estimate overshoots), plus a fixed
 *    slack for tokens generated while the abort travels to the provider. The
 *    output charge never falls below `minOutputTokens` nor a quarter of the
 *    output reservation, so a call cancelled after its first token costs at
 *    least about a short complete answer and a cancel loop cannot run calls
 *    far below the cost of finishing them. Hidden reasoning tokens (billed as
 *    output, never streamed) are only bounded by that share, not measured.
 *
 * Neither estimate can exceed the reservation, so an interrupted call is never
 * charged more than it was before this rule.
 */
export const INTERRUPTED_CALL_RULE = Object.freeze({
  // English JSON is about 4 bytes per token; 2 charges at least that much for
  // most scripts and is the realistic floor for dense text.
  bytesPerToken: 2,
  // System policy, request framing and anything the byte count misses.
  inputOverheadTokens: 512,
  // Tokens the provider may generate between the client's abort and the
  // provider noticing it.
  outputSlackTokens: 64,
  // About a short complete answer (the measured guidance card is 197 output
  // tokens).
  minOutputTokens: 256,
  // ...and at least this share of the output reservation (so twice as much on
  // the deep lane). A route that spends hidden reasoning tokens before its
  // first visible text bills them as output but streams none of them, so a
  // cancel right after the first token would otherwise under-charge. This
  // share bounds that exposure; it is a guess until the real routes are
  // measured.
  minOutputShareOfReservation: 0.25,
});

const tokens = (bytes, rule) => Math.ceil(bytes / rule.bytesPerToken);

/**
 * @param {object} call
 * @param {number} call.sentBytes UTF-8 bytes sent to the provider (prompt and output schema).
 * @param {number} call.receivedBytes UTF-8 bytes of streamed output text received, across routes.
 * @param {number} call.multiplier 2 on the deep lane (a fallback can send the prompt again), otherwise 1.
 * @param {{input:number,output:number}} call.reserved The reservation made at admission.
 * @returns {{input:number,output:number}|undefined} The tokens to keep charged, or
 *   undefined when the whole reservation must stay charged.
 */
export function interruptedCharge(
  { sentBytes, receivedBytes, multiplier, reserved },
  rule = INTERRUPTED_CALL_RULE,
) {
  if (!(receivedBytes > 0) || !(sentBytes >= 0)) return undefined;
  const input = (tokens(sentBytes, rule) + rule.inputOverheadTokens) * multiplier;
  const output = Math.max(
    rule.minOutputTokens,
    Math.ceil(reserved.output * rule.minOutputShareOfReservation),
    tokens(receivedBytes, rule) + rule.outputSlackTokens,
  );
  return {
    input: Math.min(reserved.input, input),
    output: Math.min(reserved.output, output),
  };
}
