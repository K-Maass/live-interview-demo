import { expect, test } from "vitest";
import {
  DELETE_EFFECTS,
  LOCAL_DATA_NOTE,
  LOCAL_DELETE_STEPS,
  SERVICE_DATA_NOTE,
  deleteErrorMessage,
  deletedMessage,
  exportErrorMessage,
  exportedMessage,
} from "./accountData";

test("the explanation separates the service account from the data on the Mac", () => {
  expect(LOCAL_DATA_NOTE).toMatch(/only on this Mac/);
  for (const word of ["Transcripts", "audio", "notes"]) expect(LOCAL_DATA_NOTE).toContain(word);
  expect(LOCAL_DATA_NOTE).toMatch(/does not read, change or delete/);
  expect(SERVICE_DATA_NOTE).toMatch(/Stripe/);
  expect(DELETE_EFFECTS.join(" ")).toMatch(/Nothing on this Mac is deleted/);
  expect(DELETE_EFFECTS.join(" ")).toMatch(/Stripe keeps the invoices/);
  expect(DELETE_EFFECTS.join(" ")).toMatch(/cannot be undone/);
});

test("local deletion steps name the real data folder and Keychain service of the public edition", () => {
  const steps = LOCAL_DELETE_STEPS.join("\n");
  expect(steps).toContain("~/Library/Application Support/LiveInterview");
  expect(steps).not.toContain("LiveInterviewDev");
  expect(steps).toContain("com.karim.liveinterview.public");
  expect(steps).toMatch(/your own files/);
});

test("delete failures never claim a deletion that was not confirmed", () => {
  expect(deleteErrorMessage("billingUnavailable")).toMatch(/nothing was deleted/i);
  expect(deleteErrorMessage("rateLimited")).toMatch(/Nothing was deleted/);
  expect(deleteErrorMessage("sessionExpired")).toMatch(/cannot confirm/);
  const unknown = deleteErrorMessage(new Error("serviceUnavailable"));
  expect(unknown).toMatch(/not confirmed/);
  expect(unknown).toMatch(/repeating the deletion is safe/);
  expect(unknown).not.toMatch(/was deleted/);
});

test("export failures say nothing was changed and success shows where the file is", () => {
  expect(exportErrorMessage("rateLimited")).toMatch(/hour/);
  expect(exportErrorMessage("unauthenticated")).toMatch(/signed out/);
  expect(exportErrorMessage("exportWriteFailed")).toMatch(/Downloads/);
  expect(exportErrorMessage("serviceUnavailable")).toMatch(/Nothing was changed/);
  expect(exportedMessage({ path: "/Users/x/Downloads/e.json" })).toContain("/Users/x/Downloads/e.json");
});

test("the confirmation message states what Stripe keeps only when a billing record existed", () => {
  expect(deletedMessage({ stripeCustomerDeleted: true })).toMatch(/Stripe keeps the invoices/);
  expect(deletedMessage({ stripeCustomerDeleted: false })).not.toMatch(/Stripe/);
  expect(deletedMessage({ stripeCustomerDeleted: false })).toMatch(/not touched/);
});
