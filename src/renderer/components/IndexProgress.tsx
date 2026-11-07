import type { IndexProgress as Progress } from '../../shared/ipc'
import { AppLogo } from './AppLogo'

/** First-run / indexing screen (command-deck redesign §8): a full-bleed rail
 *  overlay with the logo, a progress bar, session/byte counts, and the current
 *  file being read. Shown while the initial catalog index runs. */
export function IndexProgress({ progress }: { progress: Progress }) {
  // Byte estimates come from a directory walk that can undercount (files written
  // mid-index); clamp so a late overshoot never renders a >100% bar.
  const pct = progress.bytesTotal === 0
    ? 0
    : Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
  const mb = (n: number): string => (n / 1048576).toFixed(0)
  // Just the file name tail of the current JSONL, so the path line stays short.
  const current = progress.current.split(/[\\/]/).slice(-2).join('/')

  return (
    <div className="firstrun">
      <div className="firstrun-col">
        <AppLogo size={52} className="firstrun-logo" />
        <h2 className="firstrun-title">Reading your projects</h2>
        <div className="firstrun-bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="firstrun-nums">
          <span>{progress.done} of {progress.total} sessions</span>
          <span>{mb(progress.bytesDone)} MB / {mb(progress.bytesTotal)} MB</span>
        </div>
        {current && <div className="firstrun-path" title={progress.current}>{current}</div>}
        <p className="firstrun-note">Indexing keeps running in the background.</p>
      </div>
    </div>
  )
}
