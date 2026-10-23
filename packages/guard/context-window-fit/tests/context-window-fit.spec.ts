/** The fit verdict and its model-facing annotation. */
import { expect, it } from 'vitest'
import { overflowNotice, windowFit } from '../src/index.ts'

it('fits when the measured history plus reserve stays inside the declared capacity', () => {
  expect(windowFit(1_000, 100_000, 8_192)).toBe('fits')
})

it('overflows when the measured history plus reserve exceeds the declared capacity', () => {
  expect(windowFit(120_000, 128_000, 8_192)).toBe('overflows')
})

it('cannot judge a route that declares no capacity', () => {
  // Guessing a window would invent failures; the provider error path owns this case.
  expect(windowFit(120_000, undefined, 8_192)).toBe('cannot-judge')
})

it('names both figures and the ways forward in the annotation', () => {
  const message = overflowNotice(151_000, 128_000)
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).toContain('151000')
  expect(text).toContain('128000')
  expect(text).toContain('compact')
  expect(text).toContain('larger context window')
  expect(text).toContain('new session')
})

it('reserves headroom even when the history alone would fit', () => {
  // Exactly at capacity leaves no room for the answer itself.
  expect(windowFit(2_000, 2_000, 8_192)).toBe('overflows')
})
