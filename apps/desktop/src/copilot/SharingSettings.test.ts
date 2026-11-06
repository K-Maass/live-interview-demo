import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { MeetingRecord } from "@live-interview/core";
import { fullRecords, showExportedBundle } from "./SharingSettings";

const desktop = join(__dirname, "../..");

describe("showExportedBundle", () => {
  test("reports the saved path and reveals it in Finder", async () => {
    const statuses: string[] = [];
    const revealed: string[] = [];
    await showExportedBundle("/outbox/a.json", (s) => statuses.push(s), async (p) => { revealed.push(p); });
    expect(revealed).toEqual(["/outbox/a.json"]);
    expect(statuses).toEqual(["Portable text bundle saved in the app outbox: /outbox/a.json"]);
  });

  test("a refused reveal is reported, keeping the path, instead of failing silently", async () => {
    const statuses: string[] = [];
    await showExportedBundle("/outbox/a.json", (s) => statuses.push(s), () => Promise.reject(new Error("not allowed")));
    expect(statuses.at(-1)).toBe("Portable text bundle saved in the app outbox, but Finder could not show it: /outbox/a.json");
  });
});

test("product code only uses opener calls that the main window capability grants", () => {
  const capability = JSON.parse(readFileSync(join(desktop, "src-tauri/capabilities/default.json"), "utf8"));
  const granted: string[] = capability.permissions;
  // opener:default allows open_url (http/https/mailto/tel) and reveal_item_in_dir, not open_path.
  expect(granted).toContain("opener:default");
  expect(granted.some((p) => /^opener:allow-open-path/.test(p))).toBe(false);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const offenders = walk(join(desktop, "src"))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => /\bopenPath\b/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

describe("fullRecords", () => {
  test("an export loads each listed summary in full and keeps records that are already full", async () => {
    const loaded: string[] = [];
    const summary = { id: "a", summary: true, segments: [] } as unknown as MeetingRecord;
    const full = { id: "b", segments: [{ segmentId: "s" }] } as unknown as MeetingRecord;
    const records = await fullRecords([summary, full], async (id) => { loaded.push(id); return { id, segments: [{ segmentId: "t" }] } as unknown as MeetingRecord; });
    expect(loaded).toEqual(["a"]);
    expect(records.map((r) => [r.id, r.segments.length])).toEqual([["a", 1], ["b", 1]]);
  });
});
