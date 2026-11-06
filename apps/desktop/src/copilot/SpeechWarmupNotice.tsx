import { LoaderCircle } from "lucide-react";
import { warmupNotice } from "../lib/public/speechWarmup";

/**
 * The local speech load, said where a person would wonder why transcript text is late. A plain note, not an alert or a
 * live region: the announcer already speaks the status once, and this stays on screen only while it is true. The
 * spinner shows only while a load runs within its usual time; once it is overdue or has stopped, the note says so and
 * offers Retry (#58), which never touches recording.
 */
export function SpeechWarmupNotice({ status, onRetry }: { status: string; onRetry?: () => void }) {
  const notice = warmupNotice(status);
  if (!notice) return null;
  return <div className="speech-warmup-notice" role="note">{notice.busy && <LoaderCircle size={16} aria-hidden />}<div><strong>{notice.title}</strong><span>{notice.detail}</span>{notice.retry && onRetry && <button type="button" className="link-button" onClick={onRetry}>Retry local speech</button>}</div></div>;
}
