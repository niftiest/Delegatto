import { describe, it, expect } from 'vitest'
import { buildImageRequestBody, dataUrlFromImageResponse, generateAvatar, parseImageModels, parseCredits } from '../src/main/openrouter'

describe('buildImageRequestBody', () => {
  it('is the minimal shape by default (no size)', () => {
    expect(buildImageRequestBody('openai/gpt-image-1', 'a panda')).toEqual({ model: 'openai/gpt-image-1', prompt: 'a panda' })
    expect(buildImageRequestBody('m', 'p', '')).toEqual({ model: 'm', prompt: 'p' }) // empty size omitted
  })
  it('includes size only when explicitly provided', () => {
    expect(buildImageRequestBody('m', 'p', '1024x1536')).toEqual({ model: 'm', prompt: 'p', size: '1024x1536' })
  })
})

describe('dataUrlFromImageResponse', () => {
  it('builds a data URL from b64_json + media_type', () => {
    expect(dataUrlFromImageResponse({ data: [{ b64_json: 'AAAA', media_type: 'image/jpeg' }] })).toBe('data:image/jpeg;base64,AAAA')
  })
  it('defaults the media type to png', () => {
    expect(dataUrlFromImageResponse({ data: [{ b64_json: 'AAAA' }] })).toBe('data:image/png;base64,AAAA')
  })
  it('returns null for missing / empty / malformed data', () => {
    expect(dataUrlFromImageResponse({})).toBeNull()
    expect(dataUrlFromImageResponse({ data: [] })).toBeNull()
    expect(dataUrlFromImageResponse({ data: [{ b64_json: 123 }] })).toBeNull()
    expect(dataUrlFromImageResponse(null)).toBeNull()
  })
})

describe('parseImageModels', () => {
  const resp = {
    data: [
      { id: 'openai/gpt-image-1', name: 'GPT Image 1', architecture: { output_modalities: ['image'] },
        pricing: { prompt: '0.00001', completion: '0.00001' } },
      { id: 'google/gemini-2.5-flash-image', name: 'Gemini Flash Image', architecture: { output_modalities: ['image', 'text'] },
        pricing: { image_output: '0.00006' } },
      { id: 'anthropic/claude', name: 'Claude', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000003' } }
    ]
  }
  it('keeps only image-output models and parses pricing to numbers', () => {
    const models = parseImageModels(resp)
    expect(models.map(m => m.id)).toEqual(['openai/gpt-image-1', 'google/gemini-2.5-flash-image']) // text-only dropped
    expect(models[0]).toMatchObject({ name: 'GPT Image 1', completion: 0.00001, imageOutput: null })
    expect(models[1]).toMatchObject({ imageOutput: 0.00006, completion: null })
  })
  it('returns [] for malformed input', () => {
    expect(parseImageModels(null)).toEqual([])
    expect(parseImageModels({ data: 'nope' })).toEqual([])
  })
})

describe('parseCredits', () => {
  it('derives spend + remaining from total_credits/total_usage', () => {
    expect(parseCredits({ data: { total_credits: 20, total_usage: 12.5 } })).toEqual({ usage: 12.5, remaining: 7.5 })
  })
  it('leaves remaining null when there is no credit total (pay-as-you-go)', () => {
    expect(parseCredits({ data: { total_usage: 3 } })).toEqual({ usage: 3, remaining: null })
  })
  it('returns null for malformed input', () => {
    expect(parseCredits({})).toBeNull()
    expect(parseCredits(null)).toBeNull()
  })
})

describe('generateAvatar', () => {
  const okFetch = () => Promise.resolve({
    ok: true, status: 200, text: () => Promise.resolve(''),
    json: () => Promise.resolve({ data: [{ b64_json: 'ZZZZ', media_type: 'image/png' }] })
  })

  it('errors without a key, model, or prompt (never calls fetch)', async () => {
    let called = false
    const spy = () => { called = true; return okFetch() }
    expect((await generateAvatar({ apiKey: '', model: 'm', prompt: 'p', fetchFn: spy })).ok).toBe(false)
    expect((await generateAvatar({ apiKey: 'k', model: '', prompt: 'p', fetchFn: spy })).ok).toBe(false)
    expect((await generateAvatar({ apiKey: 'k', model: 'm', prompt: '   ', fetchFn: spy })).ok).toBe(false)
    expect(called).toBe(false)
  })

  it('returns a data URL on success', async () => {
    const res = await generateAvatar({ apiKey: 'k', model: 'openai/gpt-image-1', prompt: 'a panda', fetchFn: okFetch })
    expect(res).toEqual({ ok: true, dataUrl: 'data:image/png;base64,ZZZZ' })
  })

  it('surfaces an HTTP error with status + body', async () => {
    const res = await generateAvatar({
      apiKey: 'k', model: 'm', prompt: 'p',
      fetchFn: () => Promise.resolve({ ok: false, status: 402, text: () => Promise.resolve('insufficient credits'), json: () => Promise.resolve({}) })
    })
    expect(res.ok).toBe(false)
    if (!res.ok) { expect(res.error).toContain('402'); expect(res.error).toContain('insufficient credits') }
  })

  it('catches a thrown/rejected fetch rather than throwing across IPC', async () => {
    const res = await generateAvatar({ apiKey: 'k', model: 'm', prompt: 'p', fetchFn: () => Promise.reject(new Error('offline')) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('offline')
  })

  it('errors when the response carries no image', async () => {
    const res = await generateAvatar({
      apiKey: 'k', model: 'm', prompt: 'p',
      fetchFn: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(''), json: () => Promise.resolve({ data: [] }) })
    })
    expect(res.ok).toBe(false)
  })
})
