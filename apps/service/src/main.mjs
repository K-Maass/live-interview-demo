import { loadConfig, readiness } from "./config.mjs";
import { createService } from "./app.mjs";
import { SOCKET_TIMEOUT_MS } from "./deadlines.mjs";
import { createMonitor, installProcessHandlers } from "./monitoring.mjs";
process.umask(0o077);
const config = loadConfig(),
  report = readiness(config),
  monitor = createMonitor(config.errorReporting);
if (config.errorReporting.invalid)
  process.stderr.write(
    '{"code":"errorReportingDisabled","invalid":["ERROR_REPORTING_DSN"]}\n',
  );
// Only when reporting is on: otherwise Node's default crash output stays untouched.
if (monitor.enabled) installProcessHandlers(monitor);
if ((config.production && !report.ready) || config.missing.runtime.length) {
  process.stderr.write(
    `${JSON.stringify({ code: "configurationIncomplete", missing: report.missing })}\n`,
  );
  process.exitCode = 1;
} else {
  let app;
  try {
    app = createService({ config, monitor });
    app.server.on("error", () => {
      process.stderr.write('{"code":"serviceStartFailed"}\n');
      process.exitCode = 1;
      app.close();
    });
    app.server.listen(config.port, config.host, () =>
      process.stdout.write(
        `${JSON.stringify({ code: "serviceListening", port: app.server.address().port, ready: report.ready })}\n`,
      ),
    );
  } catch {
    process.stderr.write('{"code":"serviceStartFailed"}\n');
    process.exitCode = 1;
  }
  if (app) {
    let closing = false;
    function stop() {
      if (closing) return;
      closing = true;
      app.server.close(() => {
        app.close();
      });
      app.server.closeIdleConnections();
      const timer = setTimeout(() => {
        app.server.closeAllConnections();
      }, SOCKET_TIMEOUT_MS);
      timer.unref();
    }
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
}
