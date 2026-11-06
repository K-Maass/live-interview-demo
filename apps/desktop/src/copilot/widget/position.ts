interface Point { x: number; y: number }
interface Size { width: number; height: number }
export function widgetPosition(area: Point & Size, size: Size, previous?: Point): Point {
  const margin = 16;
  const left = area.x + margin, top = area.y + margin;
  const right = Math.max(left, area.x + area.width - size.width - margin);
  const bottom = Math.max(top, area.y + area.height - size.height - margin);
  return { x: Math.max(left, Math.min(previous?.x ?? right, right)), y: Math.max(top, Math.min(previous?.y ?? top, bottom)) };
}
