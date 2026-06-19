import type { FigmaFontName } from '#core/figma-api/fonts'
import { parseFontStyle } from '#core/text/face'

function familiesForMatch(family: string): string[] {
  const normalized = family.replace(/\s+(Variable|\d+(?:pt|px|em))$/i, '')
  return normalized !== family ? [family, normalized] : [family]
}

export function chooseLocalFontMatch<T extends FigmaFontName>(
  fonts: T[],
  family: string,
  style?: string
): T | undefined {
  const families = familiesForMatch(family)
  const requested = parseFontStyle(style)

  for (const f of families) {
    const exact = style ? fonts.find((x) => x.family === f && x.style === style) : undefined
    if (exact) return exact

    const candidates = fonts.filter((x) => x.family === f)
    const sameStyle = candidates.find((x) => {
      const parsed = parseFontStyle(x.style)
      return parsed.weight === requested.weight && parsed.italic === requested.italic
    })
    if (sameStyle) return sameStyle

    if (style) continue

    const sameSlant = candidates.filter((x) => parseFontStyle(x.style).italic === requested.italic)
    if (sameSlant.length > 0) return sameSlant[0]

    if (candidates.length > 0) return candidates[0]
  }

  return undefined
}
