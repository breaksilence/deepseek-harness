// @vitest-environment jsdom
/** Vision-default section: the model choice, its save states, and its read failures. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { VisionModelSection } from '../src/client/VisionModelSection.tsx'
import type { VisionModelSectionProps } from '../src/client/VisionModelSection.tsx'
import {
  AUTOMATIC_ROUTE, VISION_MODEL_SETTINGS_NS, VisionModelSettingsStore, visionRouteKey,
} from '../src/client/vision-model-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: VisionModelSectionProps['t'] = key => en[key]
const zhT: VisionModelSectionProps['t'] = key => zh[key]

type StoreContext = ConstructorParameters<typeof VisionModelSettingsStore>[0]

function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

function remoteFail(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
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

function storedNamespace(provider: string, model: string): SettingsNamespaceView {
  return { ...VISION_NS, value: { visionProvider: provider, visionModel: model, maxOutputTokens: 1024 } }
}

const CATALOG = {
  default: { provider: 'openai', model: 'gpt-vision' },
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
      models: [{ id: 'gpt-vision', name: 'GPT Vision', inputModalities: ['text', 'image'] }],
    },
    { id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] },
  ],
  failures: [],
}

const GPT_VISION = visionRouteKey({ provider: 'openai', model: 'gpt-vision' })

function scripted(overrides: {
  namespaces?: readonly SettingsNamespaceView[]
  writable?: boolean
  describe?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  modelCatalog?: ReturnType<typeof vi.fn>
} = {}) {
  const document: SettingsDescribeValue = {
    writable: overrides.writable ?? true,
    hasDocument: false,
    namespaces: [...overrides.namespaces ?? [storedNamespace('openai', 'gpt-vision')]],
  }
  const describe = overrides.describe ?? vi.fn(() => Promise.resolve(remoteOk(document)))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(remoteOk(VISION_NS)))
  const update = overrides.update ?? vi.fn(() => Promise.resolve(remoteOk(storedNamespace('openai', 'gpt-vision'))))
  const modelCatalog = overrides.modelCatalog ?? vi.fn(() => Promise.resolve(remoteOk(CATALOG)))
  const remote = { settings: { describe, mutate, update }, session: { modelCatalog } }
  return { describe, mutate, update, modelCatalog, remote }
}

async function mount(face = scripted(), copy: VisionModelSectionProps['t'] = t) {
  const ctx = Object.assign(new Context(), { remote: face.remote }) as StoreContext
  const controller = new VisionModelSettingsStore(ctx)
  await controller.load()
  const props: VisionModelSectionProps = {
    useVisionModel: bindSnapshotSelector(controller.store),
    load: () => { void controller.load() },
    pick: (key) => { controller.pick(key) },
    save: () => { void controller.save() },
    t: copy,
  }
  const view = render(<VisionModelSection {...props} />)
  return { view, controller, face, props }
}

/** The model select of a mounted section. */
function select(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox')
}

/** Every option label the select offers, in order. */
function optionLabels(): (string | null)[] {
  return [...select().querySelectorAll('option')].map(option => option.textContent)
}

describe('VisionModelSection', () => {
  it('offers only image-capable models, grouped by provider', async () => {
    await mount()
    expect(screen.getByRole('heading', { name: en.visionTitle })).toBeTruthy()
    expect(screen.getByText(en.visionIntro)).toBeTruthy()
    expect(optionLabels()).toEqual([
      en.visionAutomatic,
      'DeepSeek Account · Vision One',
      'openai · GPT Vision',
    ])
    expect([...select().querySelectorAll('optgroup')].map(group => group.getAttribute('label')))
      .toEqual(['DeepSeek Account', 'openai'])
    expect(select().value).toBe(GPT_VISION)
  })

  it('names the account route with the page copy', async () => {
    await mount(scripted({ namespaces: [VISION_NS] }), zhT)
    expect(screen.getByText(zh.visionIntro)).toBeTruthy()
    expect(optionLabels()).toEqual([zh.visionAutomatic, 'DeepSeek 账号 · Vision One', 'openai · GPT Vision'])
  })

  it('saves a picked route and reports the settled write', async () => {
    const { face } = await mount(scripted({ namespaces: [VISION_NS] }))
    fireEvent.change(select(), { target: { value: GPT_VISION } })
    const save = screen.getByRole('button', { name: en.apply })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    await waitFor(() => { expect(screen.getByText(en.visionSaved)).toBeTruthy() })
    expect(face.update).toHaveBeenCalledExactlyOnceWith(
      VISION_MODEL_SETTINGS_NS, { visionProvider: 'openai', visionModel: 'gpt-vision' }, 4,
    )
  })

  it('clears the stored route from the automatic choice', async () => {
    const { face } = await mount()
    fireEvent.change(select(), { target: { value: AUTOMATIC_ROUTE } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByText(en.visionSaved)).toBeTruthy() })
    expect(face.mutate).toHaveBeenCalledExactlyOnceWith(VISION_MODEL_SETTINGS_NS, [
      { op: 'unset', path: ['visionProvider'] },
      { op: 'unset', path: ['visionModel'] },
    ], 4)
  })

  it('reports a refused write with the Host diagnostic and keeps the draft', async () => {
    const { face } = await mount(scripted({
      namespaces: [VISION_NS],
      update: vi.fn(() => Promise.resolve(remoteFail('revision changed'))),
    }))
    fireEvent.change(select(), { target: { value: GPT_VISION } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => {
      expect(screen.getByText(en.visionSaveFailed.replace('{reason}', 'revision changed'))).toBeTruthy()
    })
    expect(select().value).toBe(GPT_VISION)
    expect(face.update).toHaveBeenCalledOnce()
  })

  it('keeps a stored route the current catalog no longer advertises', async () => {
    await mount(scripted({
      namespaces: [storedNamespace('acme', 'acme-vision')],
      modelCatalog: vi.fn(() => Promise.resolve(remoteOk({
        ...CATALOG,
        groups: [{ id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] }],
      }))),
    }))
    expect(optionLabels()).toEqual([en.visionAutomatic, 'acme / acme-vision'])
    expect(select().value).toBe(visionRouteKey({ provider: 'acme', model: 'acme-vision' }))
  })

  it('surfaces a failed catalog with a retry that reads again', async () => {
    const modelCatalog = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(remoteFail('catalog unavailable')))
      .mockImplementationOnce(() => Promise.resolve(remoteOk(CATALOG)))
    await mount(scripted({ modelCatalog }))
    expect(screen.getByText(en.visionCatalogFailed)).toBeTruthy()
    // The stored route stays offered even without a catalog to name it.
    expect(optionLabels()).toEqual([en.visionAutomatic, 'openai / gpt-vision'])
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByText('openai · GPT Vision')).toBeTruthy() })
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })

  it('says so when the catalog offers no vision model', async () => {
    await mount(scripted({
      namespaces: [VISION_NS],
      modelCatalog: vi.fn(() => Promise.resolve(remoteOk({
        ...CATALOG,
        groups: [{ id: 'textonly', name: 'Text only', models: [{ id: 'plain', name: 'Plain' }] }],
      }))),
    }))
    expect(screen.getByText(en.visionEmpty)).toBeTruthy()
    expect(optionLabels()).toEqual([en.visionAutomatic])
  })

  it('reports a deployment without the image-description plugin', async () => {
    await mount(scripted({ namespaces: [] }))
    expect(screen.getByText(en.visionUnavailable)).toBeTruthy()
    expect(screen.queryByLabelText(en.visionDefaultModel)).toBeNull()
  })

  it('reports a failed namespace read and retries it', async () => {
    const describe = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(remoteFail('settings unavailable')))
      .mockImplementationOnce(() => Promise.resolve(remoteOk({
        writable: true, hasDocument: false, namespaces: [VISION_NS],
      })))
    await mount(scripted({ describe }))
    expect(screen.getByText(`${en.visionLoadFailed}: settings unavailable`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByLabelText(en.visionDefaultModel)).toBeTruthy() })
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('disables the controls on a read-only document', async () => {
    await mount(scripted({ namespaces: [VISION_NS], writable: false }))
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(select()).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.apply })).toHaveProperty('disabled', true)
  })

  it('mounts nothing without its injected face', () => {
    const { container } = render(<VisionModelSection />)
    expect(container.innerHTML).toBe('')
  })

  it('loads the section on first mount', async () => {
    const face = scripted({ namespaces: [VISION_NS] })
    const ctx = Object.assign(new Context(), { remote: face.remote }) as StoreContext
    const controller = new VisionModelSettingsStore(ctx)
    render(<VisionModelSection
      useVisionModel={bindSnapshotSelector(controller.store)}
      load={() => { void controller.load() }}
      pick={(key) => { controller.pick(key) }}
      save={() => { void controller.save() }}
      t={t}
    />)
    await waitFor(() => { expect(screen.getByLabelText(en.visionDefaultModel)).toBeTruthy() })
    expect(face.describe).toHaveBeenCalledOnce()
    expect(face.modelCatalog).toHaveBeenCalledOnce()
  })
})
