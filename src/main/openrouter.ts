/** OpenRouter image generation for AI chat avatars. One REST call to the
 *  dedicated images endpoint -- no SDK. Pure helpers (request body + response
 *  parse) are split out so they unit-test without any network. */

const IMAGE_ENDPOINT = 'https://openrouter.ai/api/v1/images'

export type GenerateResult = { ok: true; dataUrl: string } | { ok: false; error: string }

/** The request body OpenRouter's /api/v1/images expects: `{model, prompt}` and,
 *  only when the caller explicitly chose one, a `size` ("1024x1024"). Size is
 *  omitted by default so we never 400 on a model that doesn't accept it (and so
 *  avatars just take the model's native output, which gets downscaled anyway).
 *  The Files "Create Image" tool passes a size when the user picks one. */
export function buildImageRequestBody(model: string, prompt: string, size?: string): { model: string; prompt: string; size?: string } {
  return size !== undefined && size.length > 0 ? { model, prompt, size } : { model, prompt }
}

/** Turn an OpenRouter images response into a `data:` URL, or null if it carried
 *  no usable image. Tolerant of shape drift: accepts `b64_json` (documented)
 *  and defaults the media type to png. */
export function dataUrlFromImageResponse(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return null
  const first = data[0] as { b64_json?: unknown; media_type?: unknown } | undefined
  const b64 = first?.b64_json
  if (typeof b64 !== 'string' || b64.length === 0) return null
  const media = typeof first?.media_type === 'string' && first.media_type.length > 0 ? first.media_type : 'image/png'
  return `data:${media};base64,${b64}`
}

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string
}) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>

/** Live pricing/metadata for an OpenRouter image-output model, for the settings
 *  comparison panel. Prices are USD; `imageOutput` is per generated image (flat)
 *  and `prompt`/`completion` are per token -- a model may price by one or both,
 *  so both are surfaced and the UI shows whichever apply. */
export type ImageModelInfo = {
  id: string
  name: string
  imageOutput: number | null
  prompt: number | null
  completion: number | null
}

function isObj2(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function num(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Parse an OpenRouter /api/v1/models response into the image-output models
 *  only (architecture.output_modalities includes "image"). Pure + tolerant. */
export function parseImageModels(json: unknown): ImageModelInfo[] {
  const data = isObj2(json) ? json.data : null
  if (!Array.isArray(data)) return []
  const out: ImageModelInfo[] = []
  for (const raw of data) {
    if (!isObj2(raw) || typeof raw.id !== 'string') continue
    const arch = isObj2(raw.architecture) ? raw.architecture : {}
    const mods = Array.isArray(arch.output_modalities) ? arch.output_modalities : []
    if (!mods.includes('image')) continue
    const pricing = isObj2(raw.pricing) ? raw.pricing : {}
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      imageOutput: num(pricing.image_output),
      prompt: num(pricing.prompt),
      completion: num(pricing.completion)
    })
  }
  return out
}

/** OpenRouter account usage for this key: lifetime spend and remaining balance
 *  (remaining is null when the account has no credit cap, e.g. pure pay-as-you-go). */
export type OpenRouterUsage = { usage: number; remaining: number | null }

/** Parse GET /api/v1/credits ({ data: { total_credits, total_usage } }). */
export function parseCredits(json: unknown): OpenRouterUsage | null {
  const d = isObj2(json) ? json.data : null
  if (!isObj2(d)) return null
  const used = num(d.total_usage)
  if (used === null) return null
  const total = num(d.total_credits)
  return { usage: used, remaining: total !== null ? total - used : null }
}

type GetFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>
type AuthGetFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/** Fetch this key's OpenRouter spend + remaining balance. Returns null with no
 *  key or on any failure (the settings panel shows an unavailable note). */
export async function fetchUsage(apiKey: string, fetchFn?: AuthGetFetch): Promise<OpenRouterUsage | null> {
  if (apiKey.length === 0) return null
  const doGet = fetchFn ?? (globalThis.fetch as unknown as AuthGetFetch)
  try {
    const res = await doGet('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return null
    return parseCredits(await res.json())
  } catch { return null }
}

/** Fetch the current image-output models + pricing from OpenRouter's public
 *  models endpoint (no key required). Returns [] on any failure -- the settings
 *  panel falls back to the static list. */
export async function fetchImageModels(fetchFn?: GetFetch): Promise<ImageModelInfo[]> {
  const doGet = fetchFn ?? (globalThis.fetch as unknown as GetFetch)
  try {
    const res = await doGet('https://openrouter.ai/api/v1/models')
    if (!res.ok) return []
    return parseImageModels(await res.json())
  } catch { return [] }
}

/** Generate one avatar image from a prompt. Never throws across the IPC
 *  boundary -- every failure (no key, HTTP error, empty result, network
 *  exception) resolves to `{ ok:false, error }` the dialog can show. */
export async function generateAvatar(opts: {
  apiKey: string
  model: string
  prompt: string
  /** Optional explicit size ("1024x1024"); omitted -> model's native output. */
  size?: string
  fetchFn?: FetchLike
}): Promise<GenerateResult> {
  const prompt = opts.prompt.trim()
  if (opts.apiKey.length === 0) return { ok: false, error: 'No OpenRouter API key set — add one in Settings → OpenRouter.' }
  if (opts.model.length === 0) return { ok: false, error: 'No image model selected in Settings → OpenRouter.' }
  if (prompt.length === 0) return { ok: false, error: 'Enter a description for the avatar.' }

  const doFetch = (opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike))
  try {
    const res = await doFetch(IMAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers (optional but recommended).
        'HTTP-Referer': 'https://github.com/niftiest/Delegatto',
        'X-Title': 'Delegatto'
      },
      body: JSON.stringify(buildImageRequestBody(opts.model, prompt, opts.size))
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `OpenRouter error ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}` }
    }
    const dataUrl = dataUrlFromImageResponse(await res.json())
    return dataUrl !== null ? { ok: true, dataUrl } : { ok: false, error: 'OpenRouter returned no image.' }
  } catch (err) {
    return { ok: false, error: `Request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
