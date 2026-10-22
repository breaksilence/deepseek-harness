/** The seam prefers the session route, then the configured default, then hands back to the caller. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import ImageDescription from '../src/index.ts'
import type { ImageDescriptionUnavailableError } from '../src/index.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}

/** Deployment config with no fallback route, so each case states only its own choice. */
const NO_ROUTE = { visionProvider: '', visionModel: '', maxOutputTokens: 1024 }

/**
 * Mount the seam against a stub llm service.
 * @param imageCapable - routes that declare image input, as `provider/model`.
 * @param config - deployment config for the mounted plugin.
 * @returns the mounted context and the prepareCall spy.
 */
async function mount(
  imageCapable: readonly string[],
  config: Record<string, unknown> = NO_ROUTE,
): Promise<{ ctx: Context; prepareCall: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const prepareCall = vi.fn(async (call: unknown) => ({ config: call, stream: async function* () {} }))
  ctx.provide('llm', {
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      name: model,
      inputModalities: imageCapable.includes(`${provider}/${model}`) ? ['text', 'image'] : ['text'],
    }),
    prepareCall,
  } as never)
  await ctx.plugin(ImageDescription, config as never)
  return { ctx, prepareCall }
}

it('reads with the session route when that route accepts images', async () => {
  const { ctx, prepareCall } = await mount(['p/vision'])

  await expect(ctx.imageDescription.describe({
    sessionId: SessionId('session-1'),
    ref: REF,
    selection: { provider: 'p', model: 'vision' },
  })).rejects.toMatchObject({ code: 'EMPTY_DESCRIPTION' })
  expect(prepareCall).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'p', model: 'vision' }),
    undefined,
  )
})

it('falls back to the configured route when the session route is text only', async () => {
  const { ctx, prepareCall } = await mount(['p/fallback'], NO_ROUTE)
  ctx.imageDescription.configureVisionModel({ provider: 'p', model: 'fallback' })

  await expect(ctx.imageDescription.describe({
    sessionId: SessionId('session-1'),
    ref: REF,
    selection: { provider: 'p', model: 'plain' },
  })).rejects.toMatchObject({ code: 'EMPTY_DESCRIPTION' })
  expect(prepareCall).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'p', model: 'fallback' }),
    undefined,
  )
})

it('names the missing configuration and starts no call when no route reads images', async () => {
  const { ctx, prepareCall } = await mount([], NO_ROUTE)

  const failure = await ctx.imageDescription.describe({
    sessionId: SessionId('session-1'),
    ref: REF,
    selection: { provider: 'p', model: 'plain' },
  }).catch((error: unknown) => error as ImageDescriptionUnavailableError)

  expect(failure).toMatchObject({ code: 'NO_VISION_MODEL_CONFIGURED' })
  expect((failure as Error).message).toContain('read_image')
  expect(prepareCall).not.toHaveBeenCalled()
})

it('reports the route in force and accepts a runtime override', async () => {
  const { ctx } = await mount([])

  expect(ctx.imageDescription.visionModel()).toBeUndefined()
  ctx.imageDescription.configureVisionModel({ provider: 'p', model: 'override' })
  expect(ctx.imageDescription.visionModel()).toEqual({ provider: 'p', model: 'override' })
  ctx.imageDescription.configureVisionModel(undefined)
  expect(ctx.imageDescription.visionModel()).toBeUndefined()
})
