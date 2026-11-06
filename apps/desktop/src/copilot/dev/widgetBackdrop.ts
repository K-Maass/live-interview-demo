import backdrop from "./assets/zoom-backdrop.png";
export function installWidgetBackdrop() {
  const label = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (label && !label.startsWith("__preview-")) return;
  document.documentElement.classList.add("preview-widget");
  const background = document.createElement("div"); background.className = "widget-preview-background";
  const image = document.createElement("img"); image.src = backdrop; image.alt = "Fictional Zoom call background";
  background.append(image); document.body.prepend(background);
}
