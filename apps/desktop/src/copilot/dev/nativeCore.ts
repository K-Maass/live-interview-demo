// Served only by Vite's development resolver. Production imports the original API.
import { invoke as nativeInvoke } from "../../../../../node_modules/@tauri-apps/api/core.js";
export * from "../../../../../node_modules/@tauri-apps/api/core.js";
export function invoke<T>(command: string, args?: Record<string, unknown>, options?: Parameters<typeof nativeInvoke>[2]): Promise<T> {
  const preview = (window as unknown as { __LIVE_INTERVIEW_PREVIEW__?: { invoke: typeof nativeInvoke } }).__LIVE_INTERVIEW_PREVIEW__;
  return preview ? preview.invoke<T>(command, args, options) : nativeInvoke<T>(command, args, options);
}
