import { describe, it, expect } from 'vitest'
import { textMenuRequest, type ContextMenuDetails } from '../src/shared/text-menu'
import { splitLinks } from '../src/renderer/lib'

const base: ContextMenuDetails = {
  x: 10, y: 20, linkURL: '', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: false }
}

describe('the right-click menu for text', () => {
  it('offers nothing on plain, unselected text', () => {
    expect(textMenuRequest(base)).toBeNull()
  })

  it('offers a web link, and only a link that can go somewhere', () => {
    expect(textMenuRequest({ ...base, linkURL: 'https://example.com/a' })).toMatchObject({ linkUrl: 'https://example.com/a', canCopy: false })
    expect(textMenuRequest({ ...base, linkURL: 'mailto:a@b.c' })?.linkUrl).toBe('mailto:a@b.c')
    expect(textMenuRequest({ ...base, linkURL: 'file:///C:/secret.txt' })).toBeNull()
    expect(textMenuRequest({ ...base, linkURL: 'javascript:alert(1)' })).toBeNull()
  })

  it('offers copying once something is selected', () => {
    expect(textMenuRequest({ ...base, selectionText: 'some words' })).toMatchObject({ canCopy: true, editable: false, linkUrl: null })
    expect(textMenuRequest({ ...base, selectionText: '   ' })).toBeNull()
  })

  it('offers both on a selected link', () => {
    expect(textMenuRequest({ ...base, selectionText: 'here', linkURL: 'https://x.y' })).toMatchObject({ canCopy: true, linkUrl: 'https://x.y' })
  })

  it('offers cut and paste in a box, as they apply', () => {
    const r = textMenuRequest({ ...base, isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true } })
    expect(r).toMatchObject({ editable: true, canCut: false, canCopy: false, canPaste: true })
  })

  it('passes on spelling suggestions, a handful at most', () => {
    const r = textMenuRequest({ ...base, isEditable: true, misspelledWord: 'speling', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    expect(r?.misspelled).toBe('speling')
    expect(r?.suggestions).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('still says so when a misspelled word has no suggestions', () => {
    expect(textMenuRequest({ ...base, isEditable: true, misspelledWord: 'zzxq' })).toMatchObject({ misspelled: 'zzxq', suggestions: [] })
  })
})

describe('web addresses in your own messages', () => {
  const urls = (t: string): string[] => splitLinks(t).filter(p => p.url).map(p => p.text)

  it('finds them, and keeps every other character as typed', () => {
    const text = 'see https://a.com/x and\nhttp://b.org?q=1 too'
    const parts = splitLinks(text)
    expect(parts.map(p => p.text).join('')).toBe(text)
    expect(urls(text)).toEqual(['https://a.com/x', 'http://b.org?q=1'])
  })

  it('leaves text with no address as it is', () => {
    expect(splitLinks('just words')).toEqual([{ text: 'just words', url: false }])
    expect(splitLinks('')).toEqual([])
    expect(urls('ftp://a.com www.a.com javascript:alert(1)')).toEqual([])
  })

  it('stops before the punctuation around it', () => {
    expect(urls('go to https://a.com.')).toEqual(['https://a.com'])
    expect(urls('(see https://a.com/x), then')).toEqual(['https://a.com/x'])
    expect(urls('is it https://a.com?')).toEqual(['https://a.com'])
    expect(urls('**https://a.com**')).toEqual(['https://a.com'])
  })

  it('keeps a bracket that belongs to the address', () => {
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(urls('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
  })

  it('does not take a bare scheme for an address', () => {
    expect(urls('https:// is the scheme')).toEqual([])
  })
})
