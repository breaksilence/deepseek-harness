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
import type {} from '@deepseek-ai/dsh-agent'
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
  /**
   * Capacity to assume for a route that declares none. Off by default: the guard
   * never invents a window. An annotation produced from the assumption says so.
   */
  assumedContextWindow?: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  reserveTokens: z.natural().default(8_192),
  strict: z.boolean().default(false),
  assumedContextWindow: z.natural(),
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
 * @param contextWindow - capacity the route declares, or the assumed capacity in force.
 * @param assumed - whether the capacity came from configuration rather than the route.
 * @returns one user message carrying the explanation.
 */
export function overflowNotice(occupiedTokens: number, contextWindow: number, assumed = false) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'This session history does not fit the current model route: about '
        + `${occupiedTokens} tokens of history against a ${contextWindow}-token context window`
        + `${assumed ? ' (assumed from configuration because the route declares no capacity)' : ''}, `
        + 'and compacting once did not bring it below that. Choose one of these before continuing: '
        + 'compact the session again (/compact) to release more history, switch back to a model with a '
        + 'larger context window, or start a new session for this work.',
    }],
    source: { kind: 'context-window-fit' },
  })
}


/**
 * Register the guard on the agent step boundary.
 * @param ctx - context providing the llm, token meter, and optional compaction service.
 * @param config - reserve headroom and whether to refuse instead of annotating.
 */
export function apply(ctx: Context, config: Config): void {
  // One notice per overflow episode: the entry clears when the history fits again.
  const noticed = new WeakSet<object>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const header = agent.session.requestHeader()?.config
    const provider = header?.provider ?? agent.options.provider
    const model = header?.model ?? agent.options.model
    if (provider === undefined || model === undefined) return decision

    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    const declared = info.context?.contextWindow
    // A route that declares a capacity is authoritative. Configuration may supply
    // one for routes that declare none; without either, the guard stays out of the
    // way because guessing would invent failures.
    const assumed = declared === undefined
    const contextWindow = declared ?? config.assumedContextWindow
    if (contextWindow === undefined) return decision

    const fits = (): boolean => windowFit(
      ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow, config.reserveTokens,
    ) === 'fits'
    if (fits()) {
      noticed.delete(agent)
      return decision
    }

    // One attempt, then re-measure: the guard asks, the compaction service decides
    // how much to release.
    const compaction = ctx.get('compaction')
    if (compaction !== undefined) {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      if (fits()) {
        noticed.delete(agent)
        return decision
      }
    }
    // The notice must be logged, not merely handed to this step: model-visible
    // input has to be reconstructable from the session log, and a logged user
    // message is what a session UI and replay can show.
    if (config.strict) return { kind: 'reject' }
    if (!noticed.has(agent)) {
      noticed.add(agent)
      const notice = overflowNotice(ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow, assumed)
      try {
        agent.session.append('user/message', notice, { surfaceOp: 'append' })
      } catch (error) {
        // A refused surface append must not fail the step; the warning names the
        // notice that could not be logged.
        ctx.logger.warn(`context-window-fit: could not log the overflow notice: ${String(error)}`)
      }
    }
    return decision
  }, { prepend: true })
}
