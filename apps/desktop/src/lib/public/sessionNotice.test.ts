import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SIGNED_OUT_ALL_MESSAGE, sessionNotice, signOutAllErrorMessage } from "./sessionNotice";

const now = Date.UTC(2026, 10, 4, 9);
const day = 86400000;

test("no note while the sign-in is far from expiry or renewal is working", () => {
  expect(sessionNotice(undefined, now)).toBeUndefined();
  expect(sessionNotice({ renewalFailed: true }, now)).toBeUndefined();
  expect(sessionNotice({ expiresAtMs: now + 20 * day, renewalFailed: true }, now)).toBeUndefined();
  expect(sessionNotice({ expiresAtMs: now + 3 * day, renewalFailed: false }, now)).toBeUndefined();
});

test("a failed renewal near expiry is a calm warning that recording is unaffected", () => {
  const text = sessionNotice({ expiresAtMs: now + 3 * day, renewalFailed: true }, now)!;
  expect(text).toMatch(/ends on/);
  expect(text).toMatch(/keeps trying/);
  expect(text).toMatch(/Recording and transcription keep working/);
  expect(text).not.toMatch(/!|error|failed/i);
});

test("the end of the sign-in lifetime asks to sign in again before that day", () => {
  const end = now + 2 * day;
  const text = sessionNotice({ expiresAtMs: end, signInRequiredAtMs: end, renewalFailed: false }, now)!;
  expect(text).toMatch(/sign in again on this Mac before/);
  expect(text).toMatch(/Recording and transcription keep working/);
});

test("signing out of all Macs reports plain results", () => {
  expect(SIGNED_OUT_ALL_MESSAGE).toMatch(/Signed out of all Macs/);
  expect(signOutAllErrorMessage("serviceUnavailable")).toMatch(/nothing changed and this Mac is still signed in/);
  expect(signOutAllErrorMessage("unauthenticated")).toMatch(/already signed out/);
  for (const code of ["serviceUnavailable", "unauthenticated", "rateLimited"])
    expect(signOutAllErrorMessage(code)).not.toContain(code);
});

test("sign out of all Macs is a registered, permitted native command behind a confirmation", () => {
  const tauri = join(__dirname, "../../../src-tauri");
  expect(readFileSync(join(tauri, "src/lib.rs"), "utf8")).toContain("public_service::public_sign_out_all,");
  expect(readFileSync(join(tauri, "permissions/main-existing.toml"), "utf8")).toContain('"public_sign_out_all",');
  const settings = readFileSync(join(__dirname, "../../copilot/screens/PublicSettings.tsx"), "utf8");
  expect(settings).toContain("p.signOutAll()");
  expect(settings).toContain("SIGN_OUT_ALL_CONFIRM");
});
