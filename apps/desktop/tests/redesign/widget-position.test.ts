import { expect, test } from "vitest";
import { widgetPosition } from "../../src/copilot/widget/position";

test("reset uses the current work area including a negative monitor origin", () => {
  expect(widgetPosition({ x: -1440, y: 25, width: 1440, height: 875 }, { width: 480, height: 390 })).toEqual({ x: -496, y: 41 });
});
test("reopening clamps an off-screen widget without changing an in-bounds position", () => {
  const area = { x: 1920, y: 30, width: 1280, height: 690 };
  const size = { width: 480, height: 390 };
  expect(widgetPosition(area, size, { x: 3500, y: -100 })).toEqual({ x: 2704, y: 46 });
  expect(widgetPosition(area, size, { x: 2000, y: 100 })).toEqual({ x: 2000, y: 100 });
});
