import { expect, test } from "vitest";
import {
  chatgptImportErrorMessage,
  GENERIC_CHATGPT_IMPORT_ERROR,
} from "./chatgptImportErrors";
test("an export over the size limit says so instead of calling it unsupported", () => {
  expect(chatgptImportErrorMessage("importTooLarge")).toMatch(/larger than 128 MB/);
  expect(chatgptImportErrorMessage("importUnsupported")).toMatch(
    /isn’t a ChatGPT conversations export/,
  );
});
test("unknown or non-string errors keep the generic message", () => {
  expect(chatgptImportErrorMessage("importFailed")).toBe(
    GENERIC_CHATGPT_IMPORT_ERROR,
  );
  expect(chatgptImportErrorMessage(new Error("x"))).toBe(
    GENERIC_CHATGPT_IMPORT_ERROR,
  );
});
