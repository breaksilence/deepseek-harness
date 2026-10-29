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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  /**
   * Share of the usable budget above which the guard tells the session it is
   * approaching the window. `0` disables the early notice.
   */
  pressureRatio: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  reserveTokens: z.natural().default(8_192),
  strict: z.boolean().default(false),
  assumedContextWindow: z.natural(),
  pressureRatio: z.number().min(0).max(1).default(0.8),
})

export const name = 'context-window-fit'

/** Model-call resolution plus the occupancy measurement this guard reads. */
export const inject = ['llm', 'tokenMeter']

/** What the guard concluded about one step. */
export type WindowFitVerdict = 'fits' | 'approaching' | 'cannot-judge' | 'overflows'

/**
 * Decide whether a measured history fits the capacity the route declares.
 * @param occupiedTokens - measured pressure of the current surface.
 * @param contextWindow - capacity the route declares, or undefined when it states none.
 * @param reserveTokens - headroom kept free below the capacity.
 * @param pressureRatio - share of the usable budget that counts as approaching; `0` disables it.
 * @returns `cannot-judge` without a declared capacity, so the guard stays out of the way.
 */
export function windowFit(
  occupiedTokens: number,
  contextWindow: number | undefined,
  reserveTokens: number,
  pressureRatio = 0,
): WindowFitVerdict {
  if (contextWindow === undefined) return 'cannot-judge'
  const usable = contextWindow - reserveTokens
  if (occupiedTokens > usable) return 'overflows'
  if (pressureRatio > 0 && usable > 0 && occupiedTokens >= usable * pressureRatio) return 'approaching'
  return 'fits'
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
export function overflowNotice(occupiedTokens: number, contextWindow: number, assumed = false): UserMessage {
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
 * The earlier, cheaper annotation: the history still fits, but the usable budget
 * is closing in. It states the figures and the same ways forward without
 * presenting a failure.
 * @param occupiedTokens - measured pressure of the current surface.
 * @param contextWindow - capacity the route declares, or the assumed capacity in force.
 * @param reserveTokens - headroom the guard keeps free below the capacity.
 * @param assumed - whether the capacity came from configuration rather than the route.
 * @returns one user message carrying the early warning.
 */
export function pressureNotice(
  occupiedTokens: number,
  contextWindow: number,
  reserveTokens: number,
  assumed = false,
): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'This session history is approaching the current model route context window: about '
        + `${occupiedTokens} of the ${contextWindow - reserveTokens} usable tokens`
        + `${assumed ? ' (capacity assumed from configuration because the route declares none)' : ''}. `
        + 'The next turns still work, but compacting soon (/compact) or switching to a model with a larger '
        + 'context window keeps them working without a refusal.',
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
  // One notice per episode: an entry clears as soon as the history is back below
  // that tier, so a session that recovers can be told again later.
  const overflowNoticed = new WeakSet<object>()
  const pressureNoticed = new WeakSet<object>()
  const logNotice = (agent: Agent, notice: UserMessage): void => {
    try {
      agent.session.append('user/message', notice, { surfaceOp: 'append' })
    } catch (error) {
      // A refused surface append must not fail the step; the warning names the
      // notice that could not be logged.
      ctx.logger.warn(`context-window-fit: could not log a window notice: ${String(error)}`)
    }
  }
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

    const verdict = (): WindowFitVerdict => windowFit(
      ctx.tokenMeter.measure(agent.session).totalTokens,
      contextWindow,
      config.reserveTokens,
      config.pressureRatio,
    )
    const tier = verdict()
    if (tier === 'fits') {
      overflowNoticed.delete(agent)
      pressureNoticed.delete(agent)
      return decision
    }
    if (tier === 'approaching') {
      // Earlier, cheaper tier: the history still fits, so the guard only says the
      // budget is closing in and leaves the choice to the session.
      if (!pressureNoticed.has(agent)) {
        pressureNoticed.add(agent)
        logNotice(agent, pressureNotice(ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow, config.reserveTokens, assumed))
      }
      return decision
    }

    // One attempt, then re-measure: the guard asks, the compaction service decides
    // how much to release.
    const compaction = ctx.get('compaction')
    if (compaction !== undefined) {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      if (verdict() === 'fits') {
        overflowNoticed.delete(agent)
        pressureNoticed.delete(agent)
        return decision
      }
    }
    // The notice must be logged, not merely handed to this step: model-visible
    // input has to be reconstructable from the session log, and a logged user
    // message is what a session UI and replay can show.
    if (config.strict) return { kind: 'reject' }
    if (!overflowNoticed.has(agent)) {
      overflowNoticed.add(agent)
      logNotice(agent, overflowNotice(ctx.tokenMeter.measure(agent.session).totalTokens, contextWindow, assumed))
    }
    return decision
  }, { prepend: true })
}
