import { expect, test, vi } from "vitest";
import { installPreview } from "../../copilot/dev/installPreview";
test("public fictional preview simulates revisioned plans, artifacts and unavailable setup without native business calls", async () => {
  const realInvoke = vi.fn(async () => ({}));
  const actual = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    invoke: realInvoke,
    transformCallback: () => 1,
    unregisterCallback: () => {},
    runCallback: () => {},
  };
  const win: Record<string, any> = { __TAURI_INTERNALS__: actual };
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", {
    search: "?preview=full&state=service-unavailable",
  });
  try {
    installPreview();
    const api = win.__LIVE_INTERVIEW_PREVIEW__.invoke;
    expect((await api("public_account_status")).configured).toBe(false);
    const all = await api("public_list_meeting_plans");
    expect(all.length).toBeGreaterThan(0);
    const plan = all[0];
    const saved = await api("public_save_meeting_plan", { plan });
    expect(saved.revision).toBe(plan.revision + 1);
    await expect(api("public_save_meeting_plan", { plan })).rejects.toThrow(
      "staleRevision",
    );
    const artifact = {
      meetingId: "customer-discovery",
      kind: "synthesis",
      recordRevision: 1,
      status: "ready",
      text: "Human summary",
      evidence: [],
      humanEdited: true,
      updatedAtMs: 0,
    };
    const edited = await api("public_save_artifact", { artifact });
    await expect(
      api("public_save_artifact", {
        artifact: { ...edited, text: "Late generated", humanEdited: false },
      }),
    ).rejects.toThrow("humanEdited");
    expect(realInvoke).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
