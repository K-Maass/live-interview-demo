import { loadConfig, readiness } from "./config.mjs";
const report = readiness(loadConfig());
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.ready ? 0 : 1;
