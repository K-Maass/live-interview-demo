import { STOP_CONFIRM_MS } from "./shortcuts";

/**
 * Stop & save from the keyboard needs two presses: the first only arms it, a second within `windowMs` confirms. A
 * press after the window arms again, so a stray press minutes later never stops a meeting.
 */
export class StopConfirmation {
  private armedAt: number | undefined;
  constructor(private readonly windowMs = STOP_CONFIRM_MS) {}
  press(nowMs: number): "armed" | "confirmed" {
    if (this.armedAt !== undefined && nowMs - this.armedAt <= this.windowMs) {
      this.armedAt = undefined;
      return "confirmed";
    }
    this.armedAt = nowMs;
    return "armed";
  }
  reset() {
    this.armedAt = undefined;
  }
}

/** How long ⌘⌥ must be held, with no other key, before the key list appears. */
export const CHEAT_SHEET_HOLD_MS = 600;

type ModifierEvent = Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey" | "repeat">;
const isModifierKey = (key: string) => key === "Meta" || key === "Alt" || key === "OS";

/**
 * Watches key events for ⌘⌥ held on its own. Pressing any other key (a real shortcut such as ⌘⌥1), releasing either
 * modifier, or the window losing focus cancels the timer and hides the list. Timers are injected so tests run without
 * real time.
 */
export class ModifierHold {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown = false;
  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly holdMs = CHEAT_SHEET_HOLD_MS,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}
  keydown(event: ModifierEvent) {
    const onlyCommandOption = event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey;
    if (!onlyCommandOption || !isModifierKey(event.key)) return this.cancel();
    if (this.timer !== undefined || this.shown) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.set(true);
    }, this.holdMs);
  }
  keyup(event: ModifierEvent) {
    if (isModifierKey(event.key) || !event.metaKey || !event.altKey) this.cancel();
  }
  cancel() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.set(false);
  }
  private set(visible: boolean) {
    if (visible === this.shown) return;
    this.shown = visible;
    this.onChange(visible);
  }
}
