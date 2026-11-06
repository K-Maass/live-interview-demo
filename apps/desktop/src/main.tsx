import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/dm-sans';
document.documentElement.lang = 'en';
async function mount() {
  const params = new URLSearchParams(location.search);
  const isPreview = import.meta.env.DEV && params.get('preview') === 'full';
  let PreviewTools: React.ComponentType | undefined;
  if (import.meta.env.DEV && isPreview) {
    const { installPreview } = await import('./copilot/dev/installPreview');
    installPreview();
    PreviewTools = (await import("./copilot/dev/PreviewTools")).PreviewTools;
  }
  const label = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  const widget = label === 'live-assistance-widget' || (import.meta.env.DEV && params.get('window') === 'widget');
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (widget) {
    document.documentElement.classList.add('widget-document');
    const { WidgetApp } = await import('./copilot/widget/WidgetApp');
    if (import.meta.env.DEV && isPreview) (await import("./copilot/dev/widgetBackdrop")).installWidgetBackdrop();
    root.render(<WidgetApp />);
  } else root.render(isPreview ? <><App />{PreviewTools && <PreviewTools />}</> : <React.StrictMode><App /></React.StrictMode>);
}
void mount().catch((error: unknown) => {
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === 'full') {
    const root = document.getElementById('root');
    if (root) root.textContent = 'Preview initialization failed: ' + (error instanceof Error ? error.message : 'unknown error');
  } else throw error;
});
