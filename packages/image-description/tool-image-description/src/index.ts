/**
 * Model-facing `describe_image`: read one attached image as text.
 *
 * The tool exists for a route that cannot accept images. Such a route receives
 * a deterministic placeholder carrying `attachment sha256:<prefix>` for each
 * occurrence, so the model can quote that handle back and learn what the image
 * contains without switching models. Resolution order, fallback, and the refusal
 * wording belong to the `imageDescription` seam; the tool owns only argument
 * checking and the model-facing result.
 * @module @deepseek-ai/dsh-tool-image-description
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import { ImageDescriptionUnavailableError } from '@deepseek-ai/dsh-image-description'

export const name = 'tool-image-description'

/** Tools registry plus the seam the tool consumes. */
export const inject = ['tools', 'imageDescription']

const DESCRIPTION =
  'Read one attached image as text when your own model cannot accept images. '
  + 'Pass the attachment handle from an image placeholder: the sha256 digest or its leading hex '
  + 'prefix. Returns a description written by a vision-capable model, the model that produced it, and '
  + 'whether your session route or the configured default served it. Read-only: it stores nothing and '
  + 'changes no conversation state.'

/**
 * Register `describe_image` in the mounting scope.
 * @param ctx - context carrying the tools registry and the image-description seam.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: DESCRIPTION,
    parameters: {
      attachment: {
        type: 'string',
        required: true,
        description: 'Attachment handle from an image placeholder: the sha256 digest or its leading hex prefix.',
      },
      prompt: {
        type: 'string',
        description: 'What to extract from the image. Omit for a general description.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true, description: 'Text description of the image.' },
          model: { type: 'string', required: true, description: 'Route that read the image, as provider/model.' },
          source: {
            type: 'string',
            required: true,
            enum: ['session', 'default'],
            description: 'Whether the session route or the configured default vision route produced the description.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.description}\n\n[described by ${value.model} (${value.source === 'session' ? 'session route' : 'default vision route'})]`,
      }],
    },
    async execute(args, exec) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('describe_image requires an attachment store; none is mounted.')
      const resolved = await attachments.resolveImageByContentAddress(args.attachment)
      if (resolved === undefined) {
        throw new Error(`No stored attachment matches "${args.attachment}". Use the handle from an image placeholder.`)
      }
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) throw new Error('describe_image requires an owning agent session')
      const config = agent.session.requestHeader()?.config
      try {
        const result = await ctx.imageDescription.describe({
          session: agent.session,
          ref: resolved.ref,
          ...config === undefined ? {} : { selection: { provider: config.provider, model: config.model } },
          ...args.prompt === undefined ? {} : { prompt: args.prompt },
        })
        return {
          description: result.text,
          model: `${result.route.provider}/${result.route.model}`,
          source: result.source,
        }
      } catch (error) {
        if (error instanceof ImageDescriptionUnavailableError) throw new Error(error.message)
        throw error
      }
    },
  }))
}
