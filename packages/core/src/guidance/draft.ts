/**
 * Provisional guidance text. While the model is still answering, the
 * unvalidated JSON output is a stream of fragments; the only thing it may be
 * used for is showing the first useful line, clearly marked as a draft, until
 * the validated card replaces it.
 */

const escapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const DRAFT_LIMIT = 350;

/**
 * Reads the top-level `say` string out of a JSON object that may be cut off at
 * any point, returning what has arrived so far. Nested `say` keys (for example
 * inside a `candidates` array) and values that are not strings are ignored,
 * and so is anything that does not look like the start of the expected object.
 */
export function partialSay(json: string): string | undefined {
  let i = 0;
  const skipSpace = () => {
    while (i < json.length && /\s/.test(json[i])) i++;
  };
  /** The string starting at `i` (an opening quote), decoded as far as it goes. */
  const readString = () => {
    let out = "";
    i++;
    while (i < json.length) {
      const c = json[i];
      if (c === '"') {
        i++;
        return { text: out, closed: true };
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const next = json[i + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { text: out, closed: false };
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      if (!(next in escapes)) return { text: out, closed: false };
      out += escapes[next];
      i += 2;
    }
    return { text: out, closed: false };
  };
  /** Skips one value that is not needed, so the next top-level key can be read. */
  const skipValue = (): boolean => {
    skipSpace();
    if (i >= json.length) return false;
    if (json[i] === '"') return readString().closed;
    let depth = 0;
    while (i < json.length) {
      const c = json[i];
      if (c === '"') {
        if (!readString().closed) return false;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) return true;
        depth--;
      } else if (c === "," && depth === 0) return true;
      i++;
    }
    return false;
  };

  skipSpace();
  if (json[i] !== "{") return undefined;
  i++;
  for (;;) {
    skipSpace();
    if (json[i] === ",") i++;
    skipSpace();
    if (json[i] !== '"') return undefined;
    const key = readString();
    if (!key.closed) return undefined;
    skipSpace();
    if (json[i] !== ":") return undefined;
    i++;
    skipSpace();
    if (key.text === "say") {
      if (json[i] !== '"') return undefined;
      const value = readString();
      const text = value.text.trim();
      return text ? text.slice(0, DRAFT_LIMIT) : undefined;
    }
    if (!skipValue()) return undefined;
  }
}

/**
 * Accumulates streamed fragments for one provider attempt. A reset (the
 * service switched routes mid-answer) discards everything received so far.
 */
export class DraftAccumulator {
  private raw = "";
  private shown: string | undefined;
  /** The draft text to display after this fragment, or undefined to show none. */
  push(fragment: string): { text: string | undefined; changed: boolean } {
    this.raw += fragment;
    return this.update();
  }
  reset(): { text: string | undefined; changed: boolean } {
    this.raw = "";
    return this.update();
  }
  private update() {
    const text = partialSay(this.raw);
    const changed = text !== this.shown;
    this.shown = text;
    return { text, changed };
  }
}
