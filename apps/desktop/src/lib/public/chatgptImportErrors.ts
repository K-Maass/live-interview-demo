/**
 * Plain-language text for the codes `import_chatgpt_export` returns. A failed import commits
 * nothing, so every message can say that earlier evidence is unchanged.
 */
const MESSAGES: Record<string, string> = {
  importTooLarge:
    "This ChatGPT export is larger than 128 MB, the most Live Interview imports at once. Nothing was imported.",
  grantDeclined: "Import cancelled. Nothing was imported.",
  importUnsupported:
    "This file isn’t a ChatGPT conversations export (conversations.json, or the export .zip that contains it). Nothing was imported.",
};
export const GENERIC_CHATGPT_IMPORT_ERROR =
  "The ChatGPT export couldn’t be imported. Nothing was imported.";
export function chatgptImportErrorMessage(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  return MESSAGES[code] ?? GENERIC_CHATGPT_IMPORT_ERROR;
}
