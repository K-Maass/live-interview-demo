import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accountActionMessage } from "./PublicSettings";

test("every sign-in rejection the native flow returns gets its own plain words", () => {
  const generic = accountActionMessage("somethingElse");
  expect(generic).toMatch(/service configuration/);
  for (const code of ["signInCancelled", "signInExpired", "browserUnavailable", "signInAlreadyPending", "slowDown"]) {
    const text = accountActionMessage(code);
    expect(text, code).not.toBe(generic);
    expect(text, code).not.toContain(code);
  }
  expect(accountActionMessage("signInCancelled")).toBe("Sign-in cancelled.");
});

test("the pending sign-in can be cancelled through a registered, permitted native command", () => {
  const tauri = join(__dirname, "../../../src-tauri");
  expect(readFileSync(join(tauri, "src/lib.rs"), "utf8")).toContain("public_service::public_cancel_sign_in,");
  expect(readFileSync(join(tauri, "permissions/main-existing.toml"), "utf8")).toContain('"public_cancel_sign_in",');
  expect(readFileSync(join(__dirname, "PublicSettings.tsx"), "utf8")).toContain("p.cancelSignIn()");
});
