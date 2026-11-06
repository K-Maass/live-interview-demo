import { expect, test, vi } from "vitest";
import { installPreview } from "../../src/copilot/dev/installPreview";
test("native preview works with frozen Tauri IPC and never forwards business commands", async () => {
  const realInvoke = vi.fn(async () => ({}));
  const actual = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, runCallback: () => {} };
  Object.defineProperty(actual, "invoke", { value: realInvoke });
  const win: Record<string, any> = {};
  Object.defineProperty(win, "__TAURI_INTERNALS__", { value: actual });
  vi.stubGlobal("window", win); vi.stubGlobal("location", { search: "?preview=full&state=live" });
  try {
    expect(() => installPreview()).not.toThrow();
    const preview = win.__LIVE_INTERVIEW_PREVIEW__;
    await preview.invoke("current_local_session");
    await expect(preview.invoke("unknown_business_write")).rejects.toThrow("Preview rejected unknown command");
    expect(realInvoke).not.toHaveBeenCalled();
    expect(win.__TAURI_INTERNALS__).toBe(actual);
  } finally { vi.unstubAllGlobals(); }
});
