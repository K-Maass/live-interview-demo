/** USD per million tokens. */
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}
export const costOf = (price: Price, usage: { input: number; output: number }) =>
  (usage.input * price.inputPerMTok + usage.output * price.outputPerMTok) / 1e6;
/** Rough token estimate for budgeting before a run; real usage is metered afterwards. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export class CostCapReached extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`Cost cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}`);
  }
}
export class CostMeter {
  spent = { generator: 0, judge: 0 };
  private tripped = false;
  constructor(readonly capUsd: number) {}
  get total() {
    return this.spent.generator + this.spent.judge;
  }
  /** Refuses the next call when its estimate would cross the cap. */
  reserve(estimateUsd: number) {
    if (this.tripped || this.total + estimateUsd > this.capUsd) this.trip();
  }
  add(kind: "generator" | "judge", usd: number) {
    this.spent[kind] += usd;
    if (this.total > this.capUsd) this.trip();
  }
  /** Rethrows a cap hit that a caller (e.g. requestGuidance) swallowed. */
  assertOpen() {
    if (this.tripped) this.trip();
  }
  private trip(): never {
    this.tripped = true;
    throw new CostCapReached(this.total, this.capUsd);
  }
}
