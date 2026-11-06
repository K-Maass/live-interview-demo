import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const dir of ["src", "scripts", "test"])
  for (const file of await readdir(new URL(`../${dir}/`, import.meta.url))) {
    if (!file.endsWith(".mjs")) continue;
    const check = spawnSync(process.execPath, ["--check", `${dir}/${file}`], {
      stdio: "inherit",
    });
    if (check.status !== 0) process.exit(check.status ?? 1);
  }
await import("../src/app.mjs");
process.stdout.write("Service modules parse and load successfully.\n");
