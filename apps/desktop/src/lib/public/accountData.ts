// Copy and error wording for exporting or deleting the service account (Settings > Account & plan).
// Pure so the promises made to the person are testable: the service account and the data on this Mac are separate.
export const LOCAL_DATA_FOLDER = "~/Library/Application Support/LiveInterview";
export const KEYCHAIN_SERVICE = "com.karim.liveinterview.public";

export const LOCAL_DATA_NOTE =
  "Transcripts, audio, notes, meeting records, plans and the document index live only on this Mac. The service never receives them, so exporting or deleting your account does not read, change or delete any of it.";

export const SERVICE_DATA_NOTE =
  "The service stores your sign-in details (email and name from your login provider), your plan and billing status, your monthly usage counts, and a record of your signed-in sessions. Payment details, invoices and receipts are held by Stripe.";

export const DELETE_EFFECTS = [
  "You are signed out everywhere and every session stops working at once.",
  "Your subscription is cancelled immediately and your Stripe customer record is deleted. There is no automatic refund for the current period.",
  "Your sign-in details, plan, usage counts and session records are erased from the service. This cannot be undone.",
  "Stripe keeps the invoices and payment records it must retain as the payment processor. The service keeps none of them.",
  "Your login provider account is not changed. Signing in again later creates a new, empty account.",
  "Nothing on this Mac is deleted. Recording and transcription keep working.",
];

export const LOCAL_DELETE_STEPS = [
  "Quit Live Interview.",
  `In Finder choose Go > Go to Folder and open ${LOCAL_DATA_FOLDER}. Moving this folder to the Trash deletes your meeting records, transcripts, notes, plans, document index and downloaded speech models.`,
  `In Keychain Access search for ${KEYCHAIN_SERVICE} and delete those items to remove saved calendar connections.`,
  "Folders you connected to the app, and any notes already added to them, are your own files and stay where they are. Delete them in Finder if you want them gone.",
];

const signedOut = new Set(["unauthenticated", "signInRequired", "sessionExpired", "sessionChanged"]);
const billing = new Set(["billingUnavailable", "billingNotConfigured", "billingOwnershipMismatch"]);

function code(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

export function exportErrorMessage(error: unknown): string {
  const c = code(error);
  if (signedOut.has(c)) return "You are signed out. Sign in to export your account data.";
  if (c === "rateLimited") return "Too many exports. Try again in an hour.";
  if (c === "exportWriteFailed") return "The export could not be saved to your Downloads folder. Nothing was changed.";
  return "The export is unavailable right now. Check the service connection and try again. Nothing was changed.";
}

export function deleteErrorMessage(error: unknown): string {
  const c = code(error);
  if (signedOut.has(c)) return "You are signed out, so the service cannot confirm a deletion. Sign in again, then delete the account.";
  if (billing.has(c)) return "Stripe could not be reached or confirmed, so nothing was deleted. Your account and subscription are unchanged. Try again later.";
  if (c === "rateLimited") return "Too many attempts. Try again in an hour. Nothing was deleted.";
  return "The deletion was not confirmed. Refresh your account to see whether you are still signed in. If you are, try again; repeating the deletion is safe.";
}

export function deletedMessage(result: { stripeCustomerDeleted: boolean }): string {
  return result.stripeCustomerDeleted
    ? "Your account was deleted and your subscription cancelled. Stripe keeps the invoices it must retain. Data on this Mac was not touched."
    : "Your account was deleted. You had no billing record. Data on this Mac was not touched.";
}

export function exportedMessage(result: { path: string }): string {
  return `Saved to ${result.path}. The file is readable only by you; delete it when you no longer need it.`;
}
