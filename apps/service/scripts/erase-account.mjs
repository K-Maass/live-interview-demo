// Operator erasure for the runbook in docs/public/activation.md: erases one account from the
// database exactly as the in-app deletion does, without a session. Run it with the service's
// DATABASE_PATH (and DELETION_LOG_PATH if set) after the Stripe customer is dealt with.
import { loadConfig } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
const args = process.argv.slice(2),
  option = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
const issuer = option("issuer"),
  subject = option("subject"),
  stripeHandled = args.includes("--stripe-handled");
const config = loadConfig();
if (!issuer || !subject || config.databasePath === ":memory:") {
  process.stderr.write(
    "usage: DATABASE_PATH=/path/service.sqlite node scripts/erase-account.mjs --issuer <issuer> --subject <subject> [--stripe-handled]\n",
  );
  process.exit(64);
}
const store = new Store(config.databasePath, {
  deletionLogPath: config.deletionLogPath,
});
try {
  const user = store.get(
    "SELECT * FROM users WHERE issuer=? AND subject=?",
    issuer,
    subject,
  );
  if (!user) {
    process.stdout.write('{"erased":false,"reason":"noSuchAccount"}\n');
  } else if (user.customer && !stripeHandled) {
    process.stderr.write(
      `Stripe customer ${user.customer} is on this account. Delete it in the Stripe dashboard (right mode, owner metadata ${user.id}), then rerun with --stripe-handled.\n`,
    );
    process.exitCode = 2;
  } else {
    store.deleteAccount(user, undefined, 0, Date.now());
    process.stdout.write('{"erased":true}\n');
  }
} finally {
  store.close();
}
