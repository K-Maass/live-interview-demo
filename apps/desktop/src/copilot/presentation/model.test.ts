import { expect, test } from "vitest";
import { captureMessages, captureRows } from "./model";

test("low disk space on both lanes is announced once, not once per lane", () => {
  const detail = "Disk space is low on the recording disk (2 GB left). Recording continues; free space soon.";
  const rows = captureRows({ me: { code: "diskSpaceLow", detail }, remote: { code: "diskSpaceLow", detail } }, { me: 1, remote: 1 }, false, true);
  expect(rows.filter((row) => row.message).length).toBe(2);
  expect(captureMessages(rows)).toEqual([{ tone: "notice", text: detail }]);
});

test("different lane messages are all kept, in lane order", () => {
  const rows = captureRows({ me: { code: "journalRetrying" }, remote: { code: "captureStalled" } }, {}, false, true);
  expect(captureMessages(rows).map((m) => m.tone)).toEqual(["notice", "alert"]);
});

test("a silent microphone is a calm line that clears when sound returns, and the lane keeps recording", () => {
  const silent = captureRows({ me: { code: "mic-silent" } }, { me: 1 }, false, true)[0];
  expect(silent.status).toBe("active");
  expect(silent.message).toEqual({ tone: "notice", text: "Your microphone is sending silence. Check mute or input device." });
  const back = captureRows({ me: { code: "microphoneSignal" } }, { me: 1 }, false, true)[0];
  expect(back.status).toBe("active");
  expect(back.message).toBeUndefined();
});

test("denied microphone access at recording start needs attention and says where to turn it on", () => {
  const denied = captureRows({ me: { code: "microphoneDenied", detail: "denied" } }, { me: 1 }, false, true)[0];
  expect(denied.status).toBe("unavailable");
  expect(denied.message?.tone).toBe("alert");
  expect(denied.message?.text).toBe("Microphone access is off, so the microphone records silence. Turn it on in System Settings › Privacy & Security › Microphone. Recording continues.");
});
