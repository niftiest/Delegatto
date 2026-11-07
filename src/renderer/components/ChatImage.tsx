import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageSourceUrl, type ComposerImage } from '../lib'

/** Open or closed, closing on Esc. It takes the key before anything else can, or the same
 *  press would also stop Claude or take back a message. */
function useImageViewer(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  return [open, setOpen]
}

/** A picture waiting to be sent: a small preview that opens like one in the chat. */
export function ComposerThumbnail({ image, onRemove }: { image: ComposerImage; onRemove: () => void }) {
  const [open, setOpen] = useImageViewer()
  const url = imageSourceUrl({ type: 'base64', media_type: image.mediaType, data: image.dataBase64 })
  return (
    <div className="composer-thumb">
      <button type="button" className="composer-thumb-open" title={image.name ?? 'View full size'} aria-label="View image full size" onClick={() => setOpen(true)}>
        {url !== null ? <img src={url} alt="" /> : <span aria-hidden="true">🖼</span>}
      </button>
      <button type="button" className="composer-thumb-x" title="Remove image" aria-label="Remove image" onClick={onRemove}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg>
      </button>
      {open && url !== null && createPortal(
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image" onClick={() => setOpen(false)}>
          <img src={url} alt="" />
        </div>,
        document.body
      )}
    </div>
  )
}

/** An image in a chat: a thumbnail that opens up to 80% of the window. Claude Code
 *  stores images in the transcript, so old chats show theirs too. */
export function ChatImage({ source }: { source: unknown }) {
  const [open, setOpen] = useImageViewer()
  const url = imageSourceUrl(source)

  if (url === null) return <div className="chat-image-missing">🖼 Image not available</div>
  return (
    <>
      <button type="button" className="chat-image" title="View full size" aria-label="View image full size" onClick={() => setOpen(true)}>
        <img src={url} alt="" />
      </button>
      {open && createPortal(
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image" onClick={() => setOpen(false)}>
          <img src={url} alt="" />
        </div>,
        document.body
      )}
    </>
  )
}
