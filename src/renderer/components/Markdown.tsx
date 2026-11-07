import { memo, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { common } from 'lowlight'
import apache from 'highlight.js/lib/languages/apache'
import dos from 'highlight.js/lib/languages/dos'
import powershell from 'highlight.js/lib/languages/powershell'
import { api } from '../api'
import { splitLinks } from '../lib'

/** Claude's replies, rendered as the terminal would format them. Choices come from
 *  a scan of 10,742 real replies:
 *  - singleTilde off: 157 of them say "~2,000" for "about", which GFM's default
 *    would pair up into strikethrough. "~~x~~" still works.
 *  - remark-breaks: Claude's single newlines are meant as line breaks.
 *  - Raw HTML stays visible text: replies mention tags like <summary> as words, and
 *    nothing in a transcript should be able to inject markup.
 *  - Images aren't fetched: opening a chat shouldn't contact whatever a reply names.
 *  - The highlight languages are the ones replies use, on top of the common set. */

const REMARK = [[remarkGfm, { singleTilde: false }], remarkBreaks] as ComponentProps<typeof ReactMarkdown>['remarkPlugins']
const REHYPE = [[rehypeHighlight, { languages: { ...common, apache, dos, bat: dos, powershell, ps1: powershell }, detect: false }]] as ComponentProps<typeof ReactMarkdown>['rehypePlugins']

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const language = /language-([\w+#-]+)/.exec(String((children as { props?: { className?: string } } | undefined)?.props?.className ?? ''))?.[1] ?? null
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language ?? ''}</span>
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ''))
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** A table keeps whole words in its cells, and breaks them only while the chat is too
 *  narrow for that, so it never needs a scrollbar. */
function Table({ children }: { children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = wrap.current, table = box?.firstElementChild as HTMLElement | null | undefined
    if (box == null || table == null) return
    let needs = 0 // the width the table took with whole words, while it's breaking them
    const check = () => {
      if (needs === 0) {
        if (table.offsetWidth > box.clientWidth + 1) { needs = table.offsetWidth; box.classList.add('tight') }
      } else if (box.clientWidth >= needs) { needs = 0; box.classList.remove('tight'); check() }
    }
    const watch = new ResizeObserver(check)
    watch.observe(box); watch.observe(table)
    return () => watch.disconnect()
  }, [])
  return <div className="md-table" ref={wrap}><table>{children}</table></div>
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => <Table>{children}</Table>,
  // Never navigates the app's own window; the main process only opens web and mail links.
  a: ({ href, children }) => (
    <a href={href} title={href} onClick={e => {
      e.preventDefault()
      if (href !== undefined) void api.openLink(href)
    }}>{children}</a>
  ),
  img: ({ src, alt }) => <span className="md-image-ref">🖼 {alt !== undefined && alt !== '' ? alt : typeof src === 'string' ? src : 'image'}</span>
}

/** A message of the user's: their text as typed, with any web addresses as working links. */
export function TextWithLinks({ text }: { text: string }) {
  return <>{splitLinks(text).map((part, i) => part.url
    ? <a key={i} className="bubble-link" href={part.text} title={part.text} onClick={e => { e.preventDefault(); void api.openLink(part.text) }}>{part.text}</a>
    : part.text)}</>
}

export const Markdown = memo(function Markdown({ text, highlight = true, className = '', anchor }: {
  text: string
  /** The message this is, so the chat can scroll to it. */
  anchor?: string
  /** Off while streaming: colouring half a code block on every token isn't worth it. */
  highlight?: boolean
  className?: string
}) {
  return (
    <div className={`md ${className}`} data-msg={anchor}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={highlight ? REHYPE : []} components={COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
})
