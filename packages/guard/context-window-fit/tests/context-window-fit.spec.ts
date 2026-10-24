/** The fit verdict and its model-facing annotation. */
import { expect, it } from 'vitest'
import { overflowNotice, pressureNotice, windowFit } from '../src/index.ts'

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

it('marks an assumed capacity as assumed in the annotation', () => {
  const message = overflowNotice(151_000, 200_000, true)
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).toContain('assumed from configuration')
  expect(text).toContain('200000')
})

it('keeps the annotation free of assumption wording for a declared capacity', () => {
  const message = overflowNotice(151_000, 128_000, false)
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).not.toContain('assumed')
})
it('reports a third tier before the history stops fitting', () => {
  // 80% of a 100k window is 80k; the reserve is already excluded from the budget.
  expect(windowFit(70_000, 100_000, 8_192, 0.8)).toBe('fits')
  expect(windowFit(80_000, 100_000, 8_192, 0.8)).toBe('approaching')
  expect(windowFit(95_000, 100_000, 8_192, 0.8)).toBe('overflows')
})

it('disables the early tier when the ratio is zero', () => {
  expect(windowFit(90_000, 100_000, 8_192, 0)).toBe('fits')
  expect(windowFit(95_000, 100_000, 8_192, 0)).toBe('overflows')
})

it('judges nothing when the route declares no capacity, whatever the ratio', () => {
  expect(windowFit(90_000, undefined, 8_192, 0.8)).toBe('cannot-judge')
})

it('states the usable budget and the ways forward in the early notice', () => {
  const message = pressureNotice(80_000, 100_000, 8_192)
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).toContain('80000')
  expect(text).toContain('91808')
  expect(text).toContain('/compact')
  expect(text).toContain('larger')
  expect(text).not.toContain('does not fit')
})

it('marks an assumed capacity in the early notice too', () => {
  const message = pressureNotice(80_000, 100_000, 8_192, true)
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).toContain('assumed from configuration')
})
