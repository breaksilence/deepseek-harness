/** Vision-default store: the image-description namespace joined with the model catalog. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RemoteResult, SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import {
  AUTOMATIC_ROUTE, VISION_MODEL_SETTINGS_NS, VisionModelSettingsStore, visionModelGroups,
  visionRouteKey, visionStoredKey, visionStoredRoute,
} from '../src/client/vision-model-store.ts'

type StoreContext = ConstructorParameters<typeof VisionModelSettingsStore>[0]

function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

function remoteFail(message: string, code: 'settings/conflict' | 'gateway/internal' = 'gateway/internal') {
  return {
    ok: false as const,
    error: code === 'settings/conflict'
      ? new RemoteError('settings/conflict', message, { ns: VISION_MODEL_SETTINGS_NS, expected: 1, actual: 2 })
      : new RemoteError('gateway/internal', message, {}),
  }
}

const VISION_NS: SettingsNamespaceView = {
  ns: VISION_MODEL_SETTINGS_NS,
  autoGenerate: false,
  schema: {},
  value: {},
  applies: 'live',
  secrets: [],
  revision: 4,
}

const ACCOUNT_NAMESPACE: SettingsNamespaceView = { ...VISION_NS, ns: 'llm-deepseek' }

function documentOf(
  namespaces: readonly SettingsNamespaceView[] = [ACCOUNT_NAMESPACE, VISION_NS],
  writable = true,
): SettingsDescribeValue {
  return { writable, hasDocument: false, namespaces: [...namespaces] }
}

const CATALOG = {
  default: { provider: 'deepseek-account', model: 'vision-one' },
  routableProviders: ['deepseek-account', 'openai', 'textonly'],
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [
        { id: 'vision-one', name: 'Vision One', inputModalities: ['text', 'image'] },
        { id: 'text-one', name: 'Text One', inputModalities: ['text'] },
      ],
    },
    {
      id: 'openai',
      name: 'openai',
      models: [
        { id: 'gpt-vision', name: 'GPT Vision', inputModalities: ['text', 'image'] },
        { id: 'gpt-plain', name: 'GPT Plain', inputModalities: ['text'] },
      ],
    },
    { id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] },
  ],
  failures: [],
}

/** The image-description namespace carrying a stored route. */
function visionWith(provider: string, model: string, revision = 4): SettingsNamespaceView {
  return { ...VISION_NS, value: { visionProvider: provider, visionModel: model, maxOutputTokens: 1024 }, revision }
}

function scripted(overrides: {
  describe?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  modelCatalog?: ReturnType<typeof vi.fn>
} = {}) {
  const describe = overrides.describe ?? vi.fn(() => Promise.resolve(remoteOk(documentOf())))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(remoteOk(VISION_NS)))
  const update = overrides.update ?? vi.fn(() => Promise.resolve(remoteOk(VISION_NS)))
  const modelCatalog = overrides.modelCatalog ?? vi.fn(() => Promise.resolve(remoteOk(CATALOG)))
  const remote = { settings: { describe, mutate, update }, session: { modelCatalog } }
  return { describe, mutate, update, modelCatalog, remote }
}

/** The page plugin's context, scripted down to the two namespaces this store reaches. */
function storeOn(remote: object): { store: VisionModelSettingsStore; ctx: StoreContext } {
  const ctx: StoreContext = Object.assign(new Context(), { remote }) as StoreContext
  return { store: new VisionModelSettingsStore(ctx), ctx }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('vision catalog filtering', () => {
  it('keeps only image-capable models, grouped by provider', () => {
    const groups = visionModelGroups(CATALOG.groups)
    expect(groups.map(group => group.provider)).toEqual(['deepseek-account', 'openai'])
    expect(groups[0]!.models.map(model => model.model)).toEqual(['vision-one'])
    expect(groups[0]!.models[0]).toMatchObject({
      provider: 'deepseek-account',
      providerName: 'DeepSeek Account',
      modelName: 'Vision One',
    })
    expect(groups[0]!.models[0]!.key).toBe(visionRouteKey({ provider: 'deepseek-account', model: 'vision-one' }))
  })

  it('offers no group for a provider without a vision model', () => {
    expect(visionModelGroups([{ id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] }]))
      .toEqual([])
  })
})

describe('stored route reading', () => {
  it('needs both fields before a route is stored', () => {
    expect(visionStoredRoute({ visionProvider: 'p', visionModel: 'm' })).toEqual({ provider: 'p', model: 'm' })
    expect(visionStoredRoute({ visionProvider: 'p' })).toBeUndefined()
    expect(visionStoredRoute({ visionModel: 'm' })).toBeUndefined()
    expect(visionStoredRoute({ visionProvider: '', visionModel: 'm' })).toBeUndefined()
    expect(visionStoredRoute([])).toBeUndefined()
  })

  it('treats a non-object value as no stored route', () => {
    for (const value of [null, 'route', 3, true] satisfies JsonValue[]) {
      expect(visionStoredRoute(value)).toBeUndefined()
    }
  })

  it('projects the stored route onto the select value', () => {
    const { store } = storeOn(scripted().remote)
    expect(visionStoredKey(store.store.getSnapshot())).toBe(AUTOMATIC_ROUTE)
    store.store.update((s) => { s.stored = { provider: 'p', model: 'm' } })
    expect(visionStoredKey(store.store.getSnapshot())).toBe(visionRouteKey({ provider: 'p', model: 'm' }))
  })
})

describe('loading', () => {
  it('publishes the vision routes and the stored choice', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.resolve(remoteOk(documentOf([visionWith('openai', 'gpt-vision')])))) })
    const { store } = storeOn(face.remote)
    expect(store.store.getSnapshot().status).toBe('idle')
    const loading = store.load()
    expect(store.store.getSnapshot().status).toBe('loading')
    await loading
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      writable: true,
      catalogError: null,
      stored: { provider: 'openai', model: 'gpt-vision' },
      draftKey: visionRouteKey({ provider: 'openai', model: 'gpt-vision' }),
    })
    expect(store.store.getSnapshot().groups.map(group => group.provider)).toEqual(['deepseek-account', 'openai'])
  })

  it('reports a deployment that composes no image-description entry', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.resolve(remoteOk(documentOf([ACCOUNT_NAMESPACE])))) })
    const { store } = storeOn(face.remote)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'unavailable', error: null, groups: [], stored: undefined, draftKey: AUTOMATIC_ROUTE,
    })
  })

  it('reports a refused describe read', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.resolve(remoteFail('settings unavailable'))) })
    const { store } = storeOn(face.remote)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings unavailable' })
  })

  it('reports a rejected describe read as diagnostics rather than an escaping rejection', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.reject(new Error('carrier down'))) })
    const { store } = storeOn(face.remote)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'carrier down' })
  })

  it('keeps the automatic choice offered when the model catalog fails', async () => {
    const face = scripted({ modelCatalog: vi.fn(() => Promise.resolve(remoteFail('catalog unavailable'))) })
    const { store } = storeOn(face.remote)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', groups: [], catalogError: 'catalog unavailable', draftKey: AUTOMATIC_ROUTE,
    })
  })

  it('lets the newest read win over an older answer', async () => {
    const first = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    const describe = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve(remoteOk(documentOf([visionWith('openai', 'gpt-vision', 9)]))))
    const face = scripted({ describe })
    const { store } = storeOn(face.remote)
    const older = store.load()
    await store.load()
    first.resolve(remoteOk(documentOf()))
    await older
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', stored: { provider: 'openai', model: 'gpt-vision' },
    })
  })
})

describe('staging a choice', () => {
  it('stages an offered route and clears the settled notice', async () => {
    const { store } = storeOn(scripted().remote)
    await store.load()
    store.store.update((s) => { s.saved = true })
    const key = visionRouteKey({ provider: 'openai', model: 'gpt-vision' })
    store.pick(key)
    expect(store.store.getSnapshot()).toMatchObject({ draftKey: key, saved: false, saveError: null })
    // Picking the staged value again is a no-op, not a reset.
    store.pick(key)
    expect(store.store.getSnapshot().draftKey).toBe(key)
  })

  it('ignores a route the current catalog does not offer', async () => {
    const { store } = storeOn(scripted().remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'gone', model: 'gone' }))
    expect(store.store.getSnapshot().draftKey).toBe(AUTOMATIC_ROUTE)
  })

  it('ignores a pick while a write is in flight', async () => {
    const write = Promise.withResolvers<RemoteResult<SettingsNamespaceView>>()
    const face = scripted({ update: vi.fn(() => write.promise) })
    const { store } = storeOn(face.remote)
    await store.load()
    const stored = visionRouteKey({ provider: 'deepseek-account', model: 'vision-one' })
    const other = visionRouteKey({ provider: 'openai', model: 'gpt-vision' })
    store.pick(other)
    const saving = store.save()
    expect(store.store.getSnapshot().saving).toBe(true)
    store.pick(stored)
    expect(store.store.getSnapshot().draftKey).toBe(other)
    write.resolve(remoteOk({ ...VISION_NS, value: { visionProvider: 'openai', visionModel: 'gpt-vision' } }))
    await saving
  })

  it('keeps a staged choice across a refresh and drops one the catalog no longer offers', async () => {
    const face = scripted()
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.load()
    expect(store.store.getSnapshot().draftKey).toBe(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    face.modelCatalog.mockImplementation(() => Promise.resolve(remoteOk({
      ...CATALOG,
      groups: [{ id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] }],
    })))
    await store.load()
    // No model declares image input, so the page offers the whole catalog and
    // marks the list as a fallback; the staged route is gone, so the draft
    // returns to the automatic choice.
    expect(store.store.getSnapshot()).toMatchObject({ draftKey: AUTOMATIC_ROUTE, fallback: true })
    expect(store.store.getSnapshot().groups).toHaveLength(1)
  })

  it('falls back to the stored route when a staged one disappears from the catalog', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.resolve(remoteOk(documentOf([visionWith('openai', 'gpt-vision')])))) })
    const { store } = storeOn(face.remote)
    await store.load()
    face.describe.mockImplementation(() => Promise.resolve(remoteOk(documentOf([
      visionWith('acme', 'acme-vision'),
    ]))))
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      draftKey: visionRouteKey({ provider: 'acme', model: 'acme-vision' }),
      stored: { provider: 'acme', model: 'acme-vision' },
    })
  })
})

describe('saving', () => {
  it('writes the chosen route fenced by the revision read just before it', async () => {
    const face = scripted({ update: vi.fn(() => Promise.resolve(remoteOk({
      ...VISION_NS, value: { visionProvider: 'openai', visionModel: 'gpt-vision' }, revision: 5,
    }))) })
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.save()
    expect(face.update).toHaveBeenCalledExactlyOnceWith(
      VISION_MODEL_SETTINGS_NS, { visionProvider: 'openai', visionModel: 'gpt-vision' }, 4,
    )
    expect(store.store.getSnapshot()).toMatchObject({
      saving: false,
      saved: true,
      saveError: null,
      stored: { provider: 'openai', model: 'gpt-vision' },
      draftKey: visionRouteKey({ provider: 'openai', model: 'gpt-vision' }),
    })
  })

  it('clears both fields for the automatic choice', async () => {
    const face = scripted({
      describe: vi.fn(() => Promise.resolve(remoteOk(documentOf([visionWith('openai', 'gpt-vision')])))),
      mutate: vi.fn(() => Promise.resolve(remoteOk(VISION_NS))),
    })
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(AUTOMATIC_ROUTE)
    await store.save()
    expect(face.mutate).toHaveBeenCalledExactlyOnceWith(VISION_MODEL_SETTINGS_NS, [
      { op: 'unset', path: ['visionProvider'] },
      { op: 'unset', path: ['visionModel'] },
    ], 4)
    expect(store.store.getSnapshot()).toMatchObject({
      saved: true, stored: undefined, draftKey: AUTOMATIC_ROUTE,
    })
  })

  it('keeps the draft and reports a refused write', async () => {
    const face = scripted({ update: vi.fn(() => Promise.resolve(remoteFail('revision changed', 'settings/conflict'))) })
    const { store } = storeOn(face.remote)
    await store.load()
    const key = visionRouteKey({ provider: 'openai', model: 'gpt-vision' })
    store.pick(key)
    await store.save()
    expect(store.store.getSnapshot()).toMatchObject({
      saving: false, saved: false, saveError: 'revision changed', draftKey: key,
    })
  })

  it('reports a rejected write instead of leaving the section saving', async () => {
    const face = scripted({ update: vi.fn(() => Promise.reject(new Error('carrier down'))) })
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.save()
    expect(store.store.getSnapshot()).toMatchObject({ saving: false, saveError: 'carrier down' })
  })

  it('writes unfenced when the revision cannot be read', async () => {
    const describe = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(remoteOk(documentOf())))
      .mockImplementationOnce(() => Promise.resolve(remoteFail('document unavailable')))
    const face = scripted({ describe })
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.save()
    expect(face.update).toHaveBeenCalledExactlyOnceWith(
      VISION_MODEL_SETTINGS_NS, { visionProvider: 'openai', visionModel: 'gpt-vision' }, undefined,
    )
  })

  it('writes nothing while the section is not ready, read-only, unchanged, or already saving', async () => {
    const face = scripted()
    const { store } = storeOn(face.remote)
    // Not ready yet.
    await store.save()
    await store.load()
    expect(face.update).not.toHaveBeenCalled()
    // Unchanged: the draft already names the stored route.
    await store.save()
    expect(face.update).not.toHaveBeenCalled()
    // Read-only deployment.
    face.describe.mockImplementation(() => Promise.resolve(remoteOk(documentOf(undefined, false))))
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.save()
    expect(face.update).not.toHaveBeenCalled()
  })

  it('leaves the store alone when the deployment composes no image-description entry', async () => {
    const face = scripted({ describe: vi.fn(() => Promise.resolve(remoteOk(documentOf([ACCOUNT_NAMESPACE])))) })
    const { store } = storeOn(face.remote)
    await store.load()
    store.pick(visionRouteKey({ provider: 'openai', model: 'gpt-vision' }))
    await store.save()
    expect(store.store.getSnapshot().draftKey).toBe(AUTOMATIC_ROUTE)
    expect(face.update).not.toHaveBeenCalled()
  })
})
