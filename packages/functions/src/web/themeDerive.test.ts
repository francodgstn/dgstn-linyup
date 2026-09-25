import assert from 'node:assert/strict'
import {
  deriveCustomPreset,
  hexToHsl,
  resolveThemePreset,
  SURFACE_THEME_PRESETS,
} from '@linyup/shared'

// The derivation turns a studio's own colors into a page that is still
// READABLE. These tests are about that guarantee, and about the color a studio
// picks reaching the page unchanged when it safely can.

function luminance(hex: string): number {
  const hsl = hexToHsl(hex)
  assert.ok(hsl, `unparseable: ${hex}`)
  return hsl!.l
}

/** A gradient background carries no single hex — pull the base color a light
 *  test can read from either form. */
function bgHex(background: string): string {
  const m = background.match(/#[0-9a-f]{6}/gi)
  return m ? m[m.length - 1] : background
}

describe('deriveCustomPreset — the color you pick is the page', () => {
  it('uses a light color verbatim as the light page', () => {
    const p = deriveCustomPreset({ light: '#eef2ff' })!
    assert.equal(p.light.background, '#eef2ff')
    assert.equal(p.light.scheme, 'dark')
  })

  it('uses an explicit dark color verbatim as the dark page', () => {
    const p = deriveCustomPreset({ light: '#eef2ff', dark: '#101425' })!
    assert.equal(p.dark.background, '#101425')
    assert.equal(p.dark.scheme, 'light')
    assert.equal(p.adaptive, true)
  })

  it('derives a dark that CORRELATES with the light when none is given', () => {
    const p = deriveCustomPreset({ light: '#f0f7f2' })!
    const lightHue = hexToHsl('#f0f7f2')!.h
    const darkHue = hexToHsl(p.dark.background)!.h
    assert.ok(Math.abs(lightHue - darkHue) < 8, `dark hue ${darkHue} vs light ${lightHue}`)
    assert.ok(luminance(p.dark.background) <= 20, 'and be actually dark')
  })

  it('single: one color, one look, non-adaptive', () => {
    const p = deriveCustomPreset({ light: '#12162a', single: true })!
    assert.equal(p.light.background, '#12162a')
    assert.deepEqual(p.light, p.dark)
    assert.equal(p.adaptive, false)
    assert.equal(p.light.scheme, 'light')
  })

  it('single with a light color gives a light site', () => {
    const p = deriveCustomPreset({ light: '#fdf2f6', single: true })!
    assert.equal(p.light.scheme, 'dark')
    assert.equal(p.adaptive, false)
  })

  it('the surface always separates from the page', () => {
    for (const light of ['#eef2ff', '#12162a', '#ffffff', '#000000']) {
      const p = deriveCustomPreset({ light })!
      assert.notEqual(p.light.background, p.light.surface, light)
    }
  })

  it('pushes an unreadable mid-tone to a readable edge, keeping the hue', () => {
    const p = deriveCustomPreset({ light: '#808080', single: true })!
    const l = luminance(bgHex(p.light.background))
    assert.ok(l <= 40 || l >= 66, `mid L=${l} would carry no text`)
  })

  it('returns null for a color that will not parse', () => {
    assert.equal(deriveCustomPreset({ light: 'chartreuse' }), null)
    assert.equal(deriveCustomPreset({ light: '' }), null)
  })
})

describe('deriveCustomPreset — lighting', () => {
  it('turns the background into a gradient, leaving the surface a solid', () => {
    const flat = deriveCustomPreset({ light: '#eef2ff' })!
    const lit = deriveCustomPreset({ light: '#eef2ff', lighting: true })!
    assert.ok(!flat.light.background.includes('gradient'))
    assert.ok(lit.light.background.includes('gradient'))
    assert.ok(lit.light.surface.startsWith('#'))
  })

  it('does not change the readable scheme', () => {
    const lit = deriveCustomPreset({ light: '#12162a', lighting: true })!
    assert.equal(lit.light.scheme, 'light')
  })
})

describe('hexToHsl', () => {
  it('accepts shorthand and full hex, with or without the hash', () => {
    for (const v of ['#fff', 'fff', '#ffffff', 'FFFFFF']) assert.equal(hexToHsl(v)?.l, 100, v)
  })
  it('returns null for anything that is not a hex color', () => {
    for (const v of ['', 'red', 'rgb(0,0,0)', '#12345', 'linear-gradient(red, blue)', '#ggg']) {
      assert.equal(hexToHsl(v), null, v)
    }
  })
})

describe('resolveThemePreset — one door for both kinds', () => {
  it('resolves a registry id', () => {
    assert.equal(resolveThemePreset({ presetId: 'ocean' })?.id, 'ocean')
  })

  it('derives for custom, carrying every field', () => {
    const p = resolveThemePreset({ presetId: 'custom', light: '#12162a', single: true })
    assert.equal(p?.id, 'custom')
    assert.equal(p?.adaptive, false)
  })

  it('returns null when nothing is chosen, so the legacy fallback runs', () => {
    assert.equal(resolveThemePreset({}), null)
    assert.equal(resolveThemePreset({ presetId: null }), null)
    assert.equal(resolveThemePreset({ presetId: 'not-a-preset' }), null)
  })

  it('returns null for custom with no or an unusable color', () => {
    assert.equal(resolveThemePreset({ presetId: 'custom' }), null)
    assert.equal(resolveThemePreset({ presetId: 'custom', light: 'nope' }), null)
  })

  it('every preset resolves, and its dark half shares the light half hue', () => {
    for (const preset of SURFACE_THEME_PRESETS) {
      assert.equal(resolveThemePreset({ presetId: preset.id })?.id, preset.id)
      if (preset.adaptive) {
        const lh = hexToHsl(preset.light.background)
        const dh = hexToHsl(preset.dark.background)
        if (lh && dh && lh.s > 4 && dh.s > 4) {
          assert.ok(Math.abs(lh.h - dh.h) < 20, `${preset.id}: dark hue ${dh.h} vs light ${lh.h}`)
        }
      }
    }
  })

  it("dropped 'mono' — the duplicate white preset is gone", () => {
    assert.equal(SURFACE_THEME_PRESETS.find((p) => p.id === ('mono' as string)), undefined)
  })
})

// Neutrality is measured by RGB CHROMA (max-min channel), not HSL saturation:
// near white, HSL saturation balloons on a one-point channel spread, so #fdfcfc
// reads as "20% saturated" while being visibly neutral. Chroma is what the eye
// actually sees.
function chroma(hex: string): number {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return Math.max(r, g, b) - Math.min(r, g, b)
}

describe('deriveCustomPreset — the card is neutral, so it comes out of the page', () => {
  it('a strongly-tinted page gets a near-hueless card', () => {
    const p = deriveCustomPreset({ light: '#0a3d0a' })! // saturated green
    assert.ok(chroma(p.dark.surface) <= 20, `card chroma ${chroma(p.dark.surface)} should be near-neutral`)
    assert.ok(chroma(p.dark.surface) < chroma('#0a3d0a'), 'and far less colored than the page')
  })

  it('a light page gets a near-white card, a dark page a light-neutral one', () => {
    const light = deriveCustomPreset({ light: '#f0f7f2' })!
    const dark = deriveCustomPreset({ light: '#0b1410', single: true })!
    assert.ok(luminance(light.light.surface) >= 95, 'light card is near white')
    assert.ok(luminance(dark.light.surface) > luminance('#0b1410'), 'dark card is lighter than its page')
  })

  it('every preset card is neutral too — one rule', () => {
    for (const preset of SURFACE_THEME_PRESETS) {
      for (const half of [preset.light, preset.dark]) {
        assert.ok(chroma(half.surface) <= 20, `${preset.id} surface not neutral (chroma ${chroma(half.surface)})`)
      }
    }
  })
})
