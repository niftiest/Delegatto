/** Text size and typeface choices. Sizes are percentages of the app's own sizes, so 100 is
 *  how it looks untouched, and an empty font name means the app's own fonts. */

export const FONT_SCALE_DEFAULT = 100
export const FONT_SCALE_MIN = 70
export const FONT_SCALE_MAX = 200
export const FONT_SCALE_STEP = 10

export function clampFontScale(value: number): number {
  const stepped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stepped))
}

export function stepFontScale(current: number, direction: 'up' | 'down'): number {
  return clampFontScale(current + (direction === 'up' ? FONT_SCALE_STEP : -FONT_SCALE_STEP))
}

/** A setting's value, or null if it isn't one: too long, or carrying what could break out
 *  of the CSS it goes into. */
export function validFontName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || /["\\;{}<>\n\r]/.test(value)) return null
  return value.trim()
}

/** A chosen font for CSS. The stylesheet puts the current theme's own font behind it, which is
 *  what shows when this one isn't on the PC. */
export function fontStack(name: string): string {
  return `"${name}"`
}
