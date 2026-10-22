/**
 * Vision-default section store: the Host `image-description` settings
 * namespace joined with the current model catalog.
 *
 * The section owns two namespace fields — `visionProvider` and `visionModel` —
 * that name the fallback route reading images for a session whose own model
 * cannot. A write makes the Host reload that plugin, so a chosen route applies
 * without a restart; clearing both fields returns the deployment's own
 * composition value, which the settings provider restores from its base layer.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ModelCatalogModel, ModelProviderGroup, RemoteResult, SettingsDescribeValue,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Settings namespace of the Host `image-description` plugin entry. */
export const VISION_MODEL_SETTINGS_NS = 'image-description'

/** Route key of the choice that stores no default route. */
export const AUTOMATIC_ROUTE = ''

/** One exact provider/model route. */
export interface VisionRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** One vision-capable route as the section lists it. */
export interface VisionModelOption extends VisionRoute {
  /** Route identity; select values round-trip through it. */
  readonly key: string
  /** Adapter-owned provider display name. */
  readonly providerName: string
  /** Adapter-owned model display name. */
  readonly modelName: string
}

/** One provider's vision-capable routes. */
export interface VisionModelGroup {
  /** Registered provider route. */
  readonly provider: string
  /** Adapter-owned provider display name. */
  readonly providerName: string
  readonly models: readonly VisionModelOption[]
}

/** Snapshot the vision-default section renders from. */
export interface VisionModelState {
  /**
   * Namespace read state. `unavailable` means this deployment composes no
   * `image-description` entry, so there is no fallback route to choose.
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Why the namespace could not be read. */
  error: string | null
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Vision-capable routes the model catalog advertises, grouped by provider. */
  groups: readonly VisionModelGroup[]
  /** Why the model catalog could not be read; the automatic choice stays offered. */
  catalogError: string | null
  /** Route stored in the namespace, absent while it declares no default. */
  stored: VisionRoute | undefined
  /** Route the select shows; {@link AUTOMATIC_ROUTE} selects no default. */
  draftKey: string
  /** Whether a write is in flight. */
  saving: boolean
  /** Whether the latest write landed. */
  saved: boolean
  /** Why the latest write failed. */
  saveError: string | null
}

/**
 * Stable identity of one exact route.
 * @param route - the provider/model route to identify.
 * @returns an opaque key for select values and lookups.
 */
export function visionRouteKey(route: VisionRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Whether a catalog model declares image input. A model whose provider states
 * no modalities cannot be offered as a vision route.
 * @param model - one catalog model.
 * @returns whether the model lists `image` among its input modalities.
 */
function acceptsImages(model: ModelCatalogModel): boolean {
  return model.inputModalities?.includes('image') === true
}

/**
 * Keep the vision-capable routes, grouped by the provider advertising them.
 * @param groups - provider groups of the Host model catalog.
 * @returns the groups offering at least one vision-capable model.
 */
export function visionModelGroups(groups: readonly ModelProviderGroup[]): VisionModelGroup[] {
  return groups.flatMap((group) => {
    const models = group.models.filter(acceptsImages).map((model): VisionModelOption => ({
      key: visionRouteKey({ provider: group.id, model: model.id }),
      provider: group.id,
      providerName: group.name,
      model: model.id,
      modelName: model.name,
    }))
    return models.length === 0 ? [] : [{ provider: group.id, providerName: group.name, models }]
  })
}

/** Narrowed read of one JSON value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the stored route out of a namespace's redacted resolved value. The
 * schema declares both fields optional, so either one missing means the
 * namespace declares no default route.
 * @param value - the namespace resolved value as the Host reports it.
 * @returns the stored route, or undefined while the namespace declares none.
 */
export function visionStoredRoute(value: JsonValue): VisionRoute | undefined {
  if (!isRecord(value)) return undefined
  const provider = value.visionProvider
  const model = value.visionModel
  return typeof provider === 'string' && provider.length > 0
    && typeof model === 'string' && model.length > 0
    ? { provider, model }
    : undefined
}

/**
 * The stored choice as the select value.
 * @param state - current section snapshot.
 * @returns the route key the namespace stores, or {@link AUTOMATIC_ROUTE}.
 */
export function visionStoredKey(state: VisionModelState): string {
  return state.stored === undefined ? AUTOMATIC_ROUTE : visionRouteKey(state.stored)
}

/** What one namespace write answered. */
type WriteOutcome =
  /** Committed; `stored` is the route the Host now holds. */
  | { readonly ok: true; readonly stored: VisionRoute | undefined }
  /** Refused, with the Host's own diagnostic. */
  | { readonly ok: false; readonly message: string }

const INITIAL: VisionModelState = {
  status: 'idle',
  error: null,
  writable: false,
  groups: [],
  catalogError: null,
  stored: undefined,
  draftKey: AUTOMATIC_ROUTE,
  saving: false,
  saved: false,
  saveError: null,
}

/** The vision-default section controller (one per settings surface). */
export class VisionModelSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<VisionModelState> = createSnapshotStore<VisionModelState>(INITIAL)

  /** Select values the last read offered, resolved back to their route. */
  private routes = new Map<string, VisionRoute>()
  /** Latest read wins; an older response never overwrites a newer one. */
  private generation = 0
  /** Whether the user staged a choice a background read must not discard. */
  private staged = false

  /**
   * @param ctx - the page plugin's context, whose `remote.settings` and
   * `remote.session` namespaces carry the namespace read/write and the model
   * catalog.
   */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Refresh the namespace and the model catalog. A staged choice survives a
   * background refresh; a ready snapshot keeps serving while the read runs.
   * @returns resolution after the current read publishes its snapshot.
   */
  load(): Promise<void> {
    return this.read(++this.generation)
  }

  /**
   * Stage one offered choice. A key the current snapshot does not offer leaves
   * the draft alone, so {@link save} only ever writes a route it can resolve.
   * @param key - one select value: {@link AUTOMATIC_ROUTE} or a route key.
   */
  pick(key: string): void {
    const state = this.store.getSnapshot()
    if (state.saving || key === state.draftKey) return
    if (key !== AUTOMATIC_ROUTE && !this.routes.has(key)) return
    this.staged = true
    this.store.update((s) => {
      s.draftKey = key
      s.saved = false
      s.saveError = null
    })
  }

  /**
   * Write the staged choice. A route sets both fields; {@link AUTOMATIC_ROUTE}
   * clears them. The revision is read immediately before the write, so an
   * external edit cannot leave this section fencing a stale one.
   * @returns resolution after the snapshot reflects the settled write.
   */
  async save(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.saving || state.status !== 'ready' || !state.writable) return
    const key = state.draftKey
    if (key === visionStoredKey(state)) return
    const pending = key === AUTOMATIC_ROUTE ? undefined : this.routes.get(key)
    this.store.update((s) => {
      s.saving = true
      s.saved = false
      s.saveError = null
    })
    let outcome: WriteOutcome
    try {
      outcome = await this.write(pending)
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    if (!outcome.ok) {
      this.store.update((s) => {
        s.saving = false
        s.saveError = outcome.message
      })
      return
    }
    this.staged = false
    if (outcome.stored !== undefined) this.routes.set(visionRouteKey(outcome.stored), outcome.stored)
    this.store.update((s) => {
      s.saving = false
      s.saved = true
      s.stored = outcome.stored
      s.draftKey = outcome.stored === undefined ? AUTOMATIC_ROUTE : visionRouteKey(outcome.stored)
    })
  }

  /** Publish one joined read; a superseded read leaves the current one in charge. */
  private async read(generation: number): Promise<void> {
    // A ready section keeps rendering while it refreshes: only a first read, a
    // retry, or a reopened section shows the loading state.
    this.store.update((s) => {
      if (s.status !== 'ready') s.status = 'loading'
      s.error = null
    })
    let described: RemoteResult<SettingsDescribeValue>
    let catalog: RemoteResult<{ groups: readonly ModelProviderGroup[] }>
    try {
      [described, catalog] = await Promise.all([
        this.ctx.remote.settings.describe(),
        this.ctx.remote.session.modelCatalog(),
      ])
    } catch (error) {
      if (generation !== this.generation) return
      this.failRead(error instanceof Error ? error.message : String(error))
      return
    }
    if (generation !== this.generation) return
    if (!described.ok) {
      this.failRead(described.error.message)
      return
    }
    const namespace = described.value.namespaces.find(view => view.ns === VISION_MODEL_SETTINGS_NS)
    if (namespace === undefined) {
      this.store.update((s) => {
        s.status = 'unavailable'
        s.error = null
        s.groups = []
        s.stored = undefined
        s.draftKey = AUTOMATIC_ROUTE
      })
      return
    }
    this.publish(described.value.writable, namespace, catalog)
  }

  /** Publish one namespace answer joined with the catalog read. */
  private publish(
    writable: boolean,
    namespace: SettingsNamespaceView,
    catalog: RemoteResult<{ groups: readonly ModelProviderGroup[] }>,
  ): void {
    const groups = catalog.ok ? visionModelGroups(catalog.value.groups) : []
    this.routes = new Map(groups.flatMap(group => group.models.map(
      (option): [string, VisionRoute] => [option.key, { provider: option.provider, model: option.model }],
    )))
    const stored = visionStoredRoute(namespace.value)
    if (stored !== undefined) this.routes.set(visionRouteKey(stored), stored)
    const storedKey = stored === undefined ? AUTOMATIC_ROUTE : visionRouteKey(stored)
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.groups = groups
      s.catalogError = catalog.ok ? null : catalog.error.message
      s.stored = stored
      // A staged choice survives the refresh; a draft whose route the current
      // catalog no longer offers falls back to the stored one, so every select
      // value stays resolvable.
      const keepDraft = this.staged && (s.draftKey === AUTOMATIC_ROUTE || this.routes.has(s.draftKey))
      s.draftKey = keepDraft ? s.draftKey : storedKey
    })
  }

  /** Publish one failed read. */
  private failRead(message: string): void {
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }

  /**
   * Read the current revision and write the choice.
   * @param pending - the route to store, or undefined to clear both fields.
   * @returns the settled write outcome.
   */
  private async write(pending: VisionRoute | undefined): Promise<WriteOutcome> {
    // The fence covers the interval between this read and the write; a
    // document this section cannot read leaves the write unfenced, and the
    // Host answers with its own diagnostic.
    const described = await this.ctx.remote.settings.describe()
    const revision = described.ok
      ? described.value.namespaces.find(view => view.ns === VISION_MODEL_SETTINGS_NS)?.revision
      : undefined
    const response = pending === undefined
      ? await this.ctx.remote.settings.mutate(VISION_MODEL_SETTINGS_NS, [
        { op: 'unset', path: ['visionProvider'] },
        { op: 'unset', path: ['visionModel'] },
      ], revision)
      : await this.ctx.remote.settings.update(
        VISION_MODEL_SETTINGS_NS,
        { visionProvider: pending.provider, visionModel: pending.model },
        revision,
      )
    return response.ok
      ? { ok: true, stored: visionStoredRoute(response.value.value) }
      : { ok: false, message: response.error.message }
  }
}
