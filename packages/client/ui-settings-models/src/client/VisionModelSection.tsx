/**
 * Vision-default settings section: the model that describes an image when a
 * session's own model cannot read it, chosen from the current model catalog.
 * The catalog is filtered to routes declaring image input; choosing
 * "automatic" stores no default and leaves the deployment's own composition
 * value in place. Saving writes the `image-description` settings namespace,
 * which makes the Host reload that plugin, so the new route applies at once.
 */

import { useId, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { AUTOMATIC_ROUTE, visionStoredKey } from './vision-model-store.ts'
import type { VisionModelState } from './vision-model-store.ts'
import type { en } from './locales.ts'
import styles from './VisionModelSection.module.css'

/** Injected dependencies of {@link VisionModelSection} (slot `inject`). */
export interface VisionModelSectionInjected {
  hooks: {
    /** Section snapshot bound by the UI renderer as useVisionModel. */
    visionModel: SnapshotStore<VisionModelState>
  }
  /** Read the namespace and the model catalog. */
  load: () => void
  /** Stage one select value. */
  pick: (key: string) => void
  /** Write the staged choice. */
  save: () => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet. The inject face arrives flat (the
 * renderer erases the share boundary at the render call), and a direct render
 * that forgets it mounts nothing rather than failing at a missing member.
 */
export type VisionModelSectionProps = Partial<InjectFace<VisionModelSectionInjected>>

/** Replace the one reason placeholder in the save-failure copy. */
function saveFailureCopy(template: string, reason: string): string {
  return template.replace('{reason}', () => reason)
}

/**
 * Render the vision-default section.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function VisionModelSection(props: VisionModelSectionProps): ReactNode {
  const { useVisionModel, load, pick, save, t } = props
  if (
    useVisionModel === undefined || load === undefined || pick === undefined
    || save === undefined || t === undefined
  ) return null
  return <Loaded injected={{ useVisionModel, load, pick, save, t }} />
}

function Loaded({ injected }: { injected: InjectFace<VisionModelSectionInjected> }): ReactNode {
  const { useVisionModel, load, pick, save, t } = injected
  const state = useVisionModel(value => value)
  const selectId = useId()
  if (state.status === 'idle') load()

  const header = (
    <>
      <h2 className={styles['title']}>{t('visionTitle')}</h2>
      <p className={styles['intro']}>{t('visionIntro')}</p>
    </>
  )

  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        {header}
        <p role="alert" className={styles['error']}>{`${t('visionLoadFailed')}: ${errorText}`}</p>
        <div className={styles['actions']}>
          <button type="button" className={styles['secondaryButton']} onClick={load}>{t('retry')}</button>
        </div>
      </div>
    )
  }
  if (state.status !== 'ready') {
    return (
      <div className={styles['section']}>
        {header}
        {state.status === 'unavailable' ? <p className={styles['notice']}>{t('visionUnavailable')}</p> : null}
      </div>
    )
  }

  // The account route's catalog name is the adapter's own label; the rest of
  // the settings page names it the same way this does.
  const groups = state.groups.map(group => group.provider === 'deepseek-account'
    ? { ...group, providerName: t('deepSeekAccount') }
    : group)
  const storedKey = visionStoredKey(state)
  // A stored route the current catalog no longer advertises stays visible and
  // selected instead of silently reading as "automatic".
  const orphan = state.stored !== undefined
    && !state.groups.some(group => group.models.some(option => option.key === storedKey))
    ? state.stored
    : undefined
  const dirty = state.draftKey !== storedKey

  return (
    <div className={styles['section']}>
      {header}
      {state.writable ? null : <p className={styles['notice']}>{t('readOnly')}</p>}
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={selectId}>{t('visionDefaultModel')}</label>
        <select
          id={selectId}
          className={`${styles['input']} ${styles['selectInput']}`}
          value={state.draftKey}
          disabled={!state.writable || state.saving}
          onChange={(event) => { pick(event.target.value) }}
        >
          <option value={AUTOMATIC_ROUTE}>{t('visionAutomatic')}</option>
          {orphan === undefined
            ? null
            : <option value={storedKey}>{`${orphan.provider} / ${orphan.model}`}</option>}
          {groups.map(group => (
            <optgroup key={group.provider} label={group.providerName}>
              {group.models.map(option => (
                <option key={option.key} value={option.key}>{`${group.providerName} · ${option.modelName}`}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {state.catalogError === null ? null : (
        <div className={styles['catalogFailure']} role="alert">
          <p className={styles['error']}>{t('visionCatalogFailed')}</p>
          <button type="button" className={styles['secondaryButton']} onClick={load}>{t('retry')}</button>
        </div>
      )}
      {state.fallback && groups.length > 0
        ? <p className={styles['notice']}>{t('visionFallbackAll')}</p>
        : null}
      {state.catalogError === null && groups.length === 0
        ? <p className={styles['notice']}>{t('visionEmpty')}</p>
        : null}
      <div className={styles['actions']}>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={!state.writable || state.saving || !dirty}
          onClick={save}
        >
          {state.saving ? t('applying') : t('apply')}
        </button>
        {state.saved
          ? <p role="status" aria-live="polite" className={styles['savedNotice']}>{t('visionSaved')}</p>
          : null}
        {state.saveError === null
          ? null
          : <p role="alert" className={styles['error']}>{saveFailureCopy(t('visionSaveFailed'), state.saveError)}</p>}
      </div>
    </div>
  )
}
