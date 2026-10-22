/**
 * Image-description capability seam.
 *
 * One stored image becomes model-readable text. The seam owns the resolution
 * order a text-only session needs: the session's own route when it accepts
 * image input, otherwise the deployment's configured vision route, otherwise a
 * typed refusal that names which of the two is missing. Providers own the model
 * call; the seam owns the policy, so every consumer asks the same question and
 * receives the same answer.
 *
 * The request never mutates the session: the description is returned to the
 * caller, which decides whether to show it, log it, or forward it.
 * @module @deepseek-ai/dsh-image-description
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'image-description': { kind: 'image-description' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    imageDescription: ImageDescription
  }
}

/** One provider/model route that can read images. */
export interface VisionModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Which route answered the request, so callers can attribute the description. */
export type VisionModelSource = 'session' | 'default'

/** Stable failure reasons a consumer can branch on. */
export type ImageDescriptionFailure =
  | 'NO_VISION_MODEL_CONFIGURED'
  | 'EMPTY_DESCRIPTION'

/** Refusal raised when no route can read the image, or the route returned nothing. */
export class ImageDescriptionUnavailableError extends Error {
  /** Stable machine-routing reason. */
  readonly code: ImageDescriptionFailure

  /**
   * @param message - actionable description naming the missing configuration.
   * @param code - stable machine-routing reason.
   */
  constructor(message: string, code: ImageDescriptionFailure) {
    super(message)
    this.name = 'ImageDescriptionUnavailableError'
    this.code = code
  }
}

/** One image to describe. */
export interface ImageDescriptionRequest {
  /** Owning session id, recorded on the auxiliary request. */
  sessionId: SessionId
  /** Durable normalized image reference to read. */
  ref: ImageAttachmentRef
  /** The route the session currently runs, or undefined when it names none. */
  selection?: VisionModelSelection
  /** Instruction for what to extract; defaults to the deployment's configured prompt. */
  prompt?: string
  /** Cancellation of route resolution and the model call. */
  signal?: AbortSignal
}

/** Successful description plus the route that produced it. */
export interface ImageDescriptionResult {
  /** Model-written description of the image. */
  text: string
  /** Route that read the image. */
  route: VisionModelSelection
  /** Whether the session route or the configured default supplied it. */
  source: VisionModelSource
}

/** Deployment configuration for the seam. */
export interface Config {
  /** Provider of the fallback vision route; omitted disables the fallback. */
  visionProvider?: string
  /** Model of the fallback vision route; omitted disables the fallback. */
  visionModel?: string
  /** Output bound for one description. */
  maxOutputTokens?: number
  /** Instruction sent with every image when the caller states none. */
  prompt?: string
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  visionProvider: z.string(),
  visionModel: z.string(),
  maxOutputTokens: z.natural().default(1024),
  prompt: z.string(),
})

const DEFAULT_PROMPT =
  'Describe this image for a model that cannot see it. Cover what it shows, any text it contains, and the details that matter for the task at hand.'

/** One image-to-text provider; deployments state a fallback route in Config. */
export default class ImageDescription extends Service {
  static readonly inject = ['llm']

  static readonly Config = Config

  private configured: VisionModelSelection | undefined
  private saves: Promise<void> = Promise.resolve()
  private readonly maxOutputTokens: number
  private readonly prompt: string

  /**
   * @param ctx - context carrying the llm service.
   * @param config - deployment fallback route, bounds, and default instruction.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'imageDescription')
    this.maxOutputTokens = config.maxOutputTokens ?? 1024
    this.prompt = config.prompt ?? DEFAULT_PROMPT
    if (config.visionProvider !== undefined && config.visionModel !== undefined) {
      this.configured = { provider: config.visionProvider, model: config.visionModel }
    }
  }

  /**
   * Replace the fallback vision route at runtime, so a settings owner can apply
   * a user choice without remounting the composition.
   * @param selection - the new fallback route, or undefined to clear it.
   */
  configureVisionModel(selection: VisionModelSelection | undefined): void {
    this.configured = selection
  }

  /**
   * The fallback vision route currently in force.
   * @returns the configured route, or undefined when the deployment and any runtime override state none.
   */
  visionModel(): VisionModelSelection | undefined {
    return this.configured
  }

  /**
   * Apply and persist the fallback vision route, so a settings surface can save a
   * user choice into the mounting profile. A deployment without a configuration
   * editor keeps only the runtime value.
   * @param selection - the chosen route, or undefined to clear the stored route.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveVisionModel(selection: VisionModelSelection | undefined): Promise<void> {
    this.configureVisionModel(selection)
    const entry = this.ctx.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = {
      ...this.prompt === undefined ? {} : { prompt: this.prompt },
      maxOutputTokens: this.maxOutputTokens,
      ...selection === undefined ? {} : { visionProvider: selection.provider, visionModel: selection.model },
    }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }

  /**
   * Read one image as text.
   * @param request - image reference, session, current route, and cancellation.
   * @returns the description and the route that produced it.
   * @throws ImageDescriptionUnavailableError when no route can read the image or the route returns no text.
   */
  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const resolved = await this.resolveRoute(request)
    request.signal?.throwIfAborted()
    const messages: Message[] = [createUserMessage({
      content: [
        { type: 'image', attachment: request.ref },
        { type: 'text', text: request.prompt ?? this.prompt },
      ],
      source: { kind: 'image-description' },
    })]
    const call = await this.ctx.llm.prepareCall({
      provider: resolved.route.provider,
      model: resolved.route.model,
      maxTokens: this.maxOutputTokens,
    }, request.signal)
    const options: GenerateOptions = {
      ...call.config,
      messages,
      sessionId: request.sessionId,
      ...request.signal === undefined ? {} : { signal: request.signal },
    }
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream(options)) {
      request.signal?.throwIfAborted()
      assembler.push(chunk)
    }
    request.signal?.throwIfAborted()
    const text = assembler.blocks()
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    if (text === '') {
      throw new ImageDescriptionUnavailableError(
        `The vision route "${resolved.route.provider}/${resolved.route.model}" returned no text for this image.`,
        'EMPTY_DESCRIPTION',
      )
    }
    return { text, route: resolved.route, source: resolved.source }
  }

  /**
   * Pick the route that reads one image: the session route when it declares
   * image input, else the configured fallback, else a refusal naming what is
   * missing.
   * @param request - the image request whose session route decides the order.
   * @returns the chosen route and whether it came from the session.
   * @throws ImageDescriptionUnavailableError when neither route can read images.
   */
  private async resolveRoute(
    request: ImageDescriptionRequest,
  ): Promise<{ route: VisionModelSelection; source: VisionModelSource }> {
    const sessionRoute = request.selection
    if (sessionRoute !== undefined && await this.acceptsImages(sessionRoute)) {
      return { route: sessionRoute, source: 'session' }
    }
    const configured = this.configured
    if (configured !== undefined) return { route: configured, source: 'default' }
    // The preference order ends here: no vision route of ours can read the
    // image. Report that plainly and let the caller continue with whatever the
    // harness already offers, instead of turning our preference into a failure.
    throw new ImageDescriptionUnavailableError(
      sessionRoute === undefined
        ? 'No model route is known for this session and no default vision model is set, so this image cannot be read here. Continue with the means you already have: read a local file with read_image, or ask the user to describe it. A user can set a default vision model in Settings.'
        : `Model "${sessionRoute.model}" does not accept image input and no default vision model is set, so this image cannot be read here. Continue with the means you already have: read a local file with read_image, or ask the user to describe it. A user can set a default vision model in Settings.`,
      'NO_VISION_MODEL_CONFIGURED',
    )
  }

  /**
   * Whether one route declares image input. An unresolvable route is treated as
   * not image-capable: the fallback then decides, and a total failure is
   * reported by {@link resolveRoute} rather than buried in a resolution error.
   * @param route - provider and model to inspect.
   * @returns whether the route reports the image modality.
   */
  private async acceptsImages(route: VisionModelSelection): Promise<boolean> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model)
      return info.inputModalities?.includes('image') ?? false
    } catch (error) {
      // An unknown or unreachable route cannot be proven image-capable; the
      // configured fallback or the refusal path owns the outcome.
      void error
      return false
    }
  }
}
