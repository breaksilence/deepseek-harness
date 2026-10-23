/**
 * Context-window fit guard.
 *
 * A session can outgrow the window its route advertises — most visibly after a
 * model switch from a large-window route to a small one, and earlier when an
 * adapter's declared window is stale. The provider then refuses the request,
 * compaction retries once, and a history that still cannot fit surfaces as a
 * failed turn. This guard answers the question before the request leaves: does
 * the current history fit the route about to read it?
 *
 * It reads the two halves from their existing owners — occupancy from the token
 * meter, capacity from the resolved model route — compacts once when the answer
 * is no, and then either annotates the step with what the session can do next
 * (the default) or refuses it (opt-in). A route that declares no capacity is not
 * judged at all: guessing a window would invent failures.
 * @module @deepseek-ai/dsh-guard-context-window-fit
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-compaction'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-window-fit': { kind: 'context-window-fit' }
  }
}

/** Deployment configuration for the guard. */
export interface Config {
  /** Tokens kept free below the route capacity, so the answer itself can be sent. */
  reserveTokens: number
  /** Refuse the step instead of annotating it when the history still does not fit. */
  strict: boolean
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  reserveTokens: z.natural().default(8_192),
  strict: z.boolean().default(false),
})

export const name = 'context-window-fit'

/** Model-call resolution plus the occupancy measurement this guard reads. */
export const inject = ['llm', 'tokenMeter']

/** What the guard concluded about one step. */
export type WindowFitVerdict = 'fits' | 'cannot-judge' | 'overflows'

/**
 * Decide whether a measured history fits the capacity the route declares.
 * @param occupiedTokens - measured pressure of the current surface.
 * @param contextWindow - capacity the route declares, or undefined when it states none.
 * @param reserveTokens - headroom kept free below the capacity.
 * @returns `cannot-judge` without a declared capacity, so the guard stays out of the way.
 */
export function windowFit(
  occupiedTokens: number,
  contextWindow: number | undefined,
  reserveTokens: number,
): WindowFitVerdict {
  if (contextWindow === undefined) return 'cannot-judge'
  return occupiedTokens + reserveTokens <= contextWindow ? 'fits' : 'overflows'
}

/**
 * The annotation this guard adds when the history does not fit even after one
 * compaction attempt. It names the shortfall and the ways forward rather than
 * presenting the situation as a failure.
 * @param occupiedTokens - measured pressure of the current surface.
 * @param contextWindow - capacity the route declares.
 * @returns one user message carrying the explanation.
 */
export function overflowNotice(occupiedTokens: number, contextWindow: number) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'This session history does not fit the current model route: about '
        + `${occupiedTokens} tokens of history against a ${contextWindow}-token context window, `
        + 'and compacting once did not bring it below that. Choose one of these before continuing: '
        + 'compact the session again (/compact) to release more history, switch back to a model with a '
        + 'larger context window, or start a new session for this work.',
    }],
    source: { kind: 'context-window-fit' },
  })
}

/**
 * Whether the step already carries this guard's annotation, so a multi-step turn
 * states the situation once instead of once per step.
 * @param decision - the step decision assembled by the waterfall.
 * @returns whether an annotation is already present.
 */
function alreadyAnnotated(decision: PreStepDecision): boolean {
  if (decision.kind !== 'enter') return false
  return decision.messages.some(message => message.content.some(
    block => block.type === 'text' && block.text.startsWith('This session history does not fit the current model route:'),
  ))
}

/**
 * Register the guard on the agent step boundary.
 * @param ctx - context providing the llm, token meter, and optional compaction service.
 * @param config - reserve headroom and whether to refuse instead of annotating.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const header = agent.session.requestHeader()?.config
    const provider = header?.provider ?? agent.options.provider
    const model = header?.model ?? agent.options.model
    if (provider === undefined || model === undefined) return decision

    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    const contextWindow = info.context?.contextWindow
    // An undeclared capacity cannot be judged; the provider error path owns it.
    if (contextWindow === undefined) return decision

    const fits = (): boolean => windowFit(
      ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow, config.reserveTokens,
    ) === 'fits'
    if (fits()) return decision

    // One attempt, then re-measure: the guard asks, the compaction service decides
    // how much to release.
    const compaction = ctx.get('compaction')
    if (compaction !== undefined) {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      if (signal.aborted) return decision
      if (fits()) return decision
    }
    if (alreadyAnnotated(decision)) return decision
    if (config.strict) return { kind: 'reject' }
    if (decision.kind !== 'enter') return decision
    return {
      ...decision,
      messages: [...decision.messages, overflowNotice(ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow)],
    }
  }, { prepend: true })
}
