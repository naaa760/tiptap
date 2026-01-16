import { type EditorOptions, Editor } from '@tiptap/core'
import type { DependencyList, MutableRefObject } from 'react'
import { useDebugValue, useEffect, useRef, useState } from 'react'
import { useSyncExternalStore } from 'use-sync-external-store/shim/index.js'

import { useEditorState } from './useEditorState.js'

// @ts-ignore
const isDev = process.env.NODE_ENV !== 'production'
const isSSR = typeof window === 'undefined'
const isNext = isSSR || Boolean(typeof window !== 'undefined' && (window as any).next)

/**
 * The options for the `useEditor` hook.
 */
export type UseEditorOptions = Partial<EditorOptions> & {
  /**
   * Whether to render the editor on the first render.
   * If client-side rendering, set this to `true`.
   * If server-side rendering, set this to `false`.
   * @default true
   */
  immediatelyRender?: boolean
  /**
   * Whether to re-render the editor on each transaction.
   * This is legacy behavior that will be removed in future versions.
   * @default false
   */
  shouldRerenderOnTransaction?: boolean
}

/**
 * This class handles the creation, destruction, and re-creation of the editor instance.
 */
class EditorInstanceManager {
  /**
   * The current editor instance.
   */
  private editor: Editor | null = null

  /**
   * The most recent options to apply to the editor.
   */
  private options: MutableRefObject<UseEditorOptions>

  /**
   * The subscriptions to notify when the editor instance
   * has been created or destroyed.
   */
  private subscriptions = new Set<() => void>()

  /**
   * A timeout to destroy the editor if it was not mounted within a time frame.
   */
  private scheduledDestructionTimeout: ReturnType<typeof setTimeout> | undefined

  /**
   * Whether the editor has been mounted.
   */
  private isComponentMounted = false

  /**
   * The most recent dependencies array.
   */
  private previousDeps: DependencyList | null = null

  /**
   * The unique instance ID. This is used to identify the editor instance. And will be re-generated for each new instance.
   */
  public instanceId = ''

  constructor(options: MutableRefObject<UseEditorOptions>) {
    this.options = options
    this.subscriptions = new Set<() => void>()
    this.setEditor(this.getInitialEditor())
    this.scheduleDestroy()

    this.getEditor = this.getEditor.bind(this)
    this.getServerSnapshot = this.getServerSnapshot.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.refreshEditorInstance = this.refreshEditorInstance.bind(this)
    this.scheduleDestroy = this.scheduleDestroy.bind(this)
    this.onRender = this.onRender.bind(this)
    this.createEditor = this.createEditor.bind(this)
  }

  private setEditor(editor: Editor | null) {
    this.editor = editor
    this.instanceId = Math.random().toString(36).slice(2, 9)
    this.subscriptions.forEach(cb => cb())
  }

  private getInitialEditor() {
    if (this.options.current.immediatelyRender === undefined) {
      if (isSSR || isNext) {
        if (isDev) {
          throw new Error(
            'Tiptap Error: SSR has been detected, please set `immediatelyRender` explicitly to `false` to avoid hydration mismatches.',
          )
        }

        return null
      }

      return this.createEditor()
    }

    if (this.options.current.immediatelyRender && isSSR && isDev) {
      throw new Error(
        'Tiptap Error: SSR has been detected, and `immediatelyRender` has been set to `true` this is an unsupported configuration that may result in errors, explicitly set `immediatelyRender` to `false` to avoid hydration mismatches.',
      )
    }

    if (this.options.current.immediatelyRender) {
      return this.createEditor()
    }

    return null
  }

  private getWrappedOptions(additionalOptions?: Partial<EditorOptions>): Partial<EditorOptions> {
    const currentOptions = this.options.current || {}
    
    return {
      ...currentOptions,
      ...additionalOptions,
      onBeforeCreate: (...args) => this.options.current?.onBeforeCreate?.(...args),
      onBlur: (...args) => this.options.current?.onBlur?.(...args),
      onCreate: (...args) => this.options.current?.onCreate?.(...args),
      onDestroy: (...args) => this.options.current?.onDestroy?.(...args),
      onFocus: (...args) => this.options.current?.onFocus?.(...args),
      onSelectionUpdate: (...args) => this.options.current?.onSelectionUpdate?.(...args),
      onTransaction: (...args) => this.options.current?.onTransaction?.(...args),
      onUpdate: (...args) => this.options.current?.onUpdate?.(...args),
      onContentError: (...args) => this.options.current?.onContentError?.(...args),
      onDrop: (...args) => this.options.current?.onDrop?.(...args),
      onPaste: (...args) => this.options.current?.onPaste?.(...args),
      onDelete: (...args) => this.options.current?.onDelete?.(...args),
    }
  }

  private createEditor(): Editor {
    const optionsToApply = this.getWrappedOptions()
    const editor = new Editor(optionsToApply)

    return editor
  }

  /**
   * Get the current editor instance.
   */
  getEditor(): Editor | null {
    return this.editor
  }

  /**
   * Always disable the editor on the server-side.
   */
  getServerSnapshot(): null {
    return null
  }

  /**
   * Subscribe to the editor instance's changes.
   */
  subscribe(onStoreChange: () => void) {
    this.subscriptions.add(onStoreChange)

    return () => {
      this.subscriptions.delete(onStoreChange)
    }
  }

  static compareOptions(a: UseEditorOptions, b: UseEditorOptions) {
    return (Object.keys(a) as (keyof UseEditorOptions)[]).every(key => {
      if (
        [
          'onCreate',
          'onBeforeCreate',
          'onDestroy',
          'onUpdate',
          'onTransaction',
          'onFocus',
          'onBlur',
          'onSelectionUpdate',
          'onContentError',
          'onDrop',
          'onPaste',
        ].includes(key)
      ) {
        return true
      }

      if (key === 'extensions' && a.extensions && b.extensions) {
        if (a.extensions.length !== b.extensions.length) {
          return false
        }
        return a.extensions.every((extension, index) => {
          if (extension !== b.extensions?.[index]) {
            return false
          }
          return true
        })
      }
      if (a[key] !== b[key]) {
        return false
      }
      return true
    })
  }

  /**
   * On each render, we will create, update, or destroy the editor instance.
   * @param deps The dependencies to watch for changes
   * @returns A cleanup function
   */
  onRender(deps: DependencyList) {
    return () => {
      this.isComponentMounted = true
      clearTimeout(this.scheduledDestructionTimeout)

      if (this.editor && !this.editor.isDestroyed && deps.length === 0) {
        if (!EditorInstanceManager.compareOptions(this.options.current, this.editor.options)) {
          this.editor.setOptions(this.getWrappedOptions({
            editable: this.editor.isEditable,
          }))
        }
      } else {
        this.refreshEditorInstance(deps)
      }

      return () => {
        this.isComponentMounted = false
        this.scheduleDestroy()
      }
    }
  }

  /**
   * Recreate the editor instance if the dependencies have changed.
   */
  private refreshEditorInstance(deps: DependencyList) {
    if (this.editor && !this.editor.isDestroyed) {
      if (this.previousDeps === null) {
        this.previousDeps = deps
        return
      }
      const depsAreEqual =
        this.previousDeps.length === deps.length && this.previousDeps.every((dep, index) => dep === deps[index])

      if (depsAreEqual) {
        return
      }
    }

    if (this.editor && !this.editor.isDestroyed) {
      this.editor.destroy()
    }

    this.setEditor(this.createEditor())
    this.previousDeps = deps
  }

  /**
   * Schedule the destruction of the editor instance.
   * This will only destroy the editor if it was not mounted on the next tick.
   * This is to avoid destroying the editor instance when it's actually still mounted.
   */
  private scheduleDestroy() {
    const currentInstanceId = this.instanceId
    const currentEditor = this.editor

    this.scheduledDestructionTimeout = setTimeout(() => {
      if (this.isComponentMounted && this.instanceId === currentInstanceId) {
        if (currentEditor) {
          currentEditor.setOptions(this.getWrappedOptions())
        }
        return
      }
      if (currentEditor && !currentEditor.isDestroyed) {
        currentEditor.destroy()
        if (this.instanceId === currentInstanceId) {
          this.setEditor(null)
        }
      }
    }, 1)
  }
}

/**
 * This hook allows you to create an editor instance.
 * @param options The editor options
 * @param deps The dependencies to watch for changes
 * @returns The editor instance
 * @example const editor = useEditor({ extensions: [...] })
 */
export function useEditor(
  options: UseEditorOptions & { immediatelyRender: false },
  deps?: DependencyList,
): Editor | null

/**
 * This hook allows you to create an editor instance.
 * @param options The editor options
 * @param deps The dependencies to watch for changes
 * @returns The editor instance
 * @example const editor = useEditor({ extensions: [...] })
 */
export function useEditor(options: UseEditorOptions, deps?: DependencyList): Editor

export function useEditor(options: UseEditorOptions = {}, deps: DependencyList = []): Editor | null {
  const mostRecentOptions = useRef(options)

  mostRecentOptions.current = options

  const [instanceManager] = useState(() => new EditorInstanceManager(mostRecentOptions))

  const editor = useSyncExternalStore(
    instanceManager.subscribe,
    instanceManager.getEditor,
    instanceManager.getServerSnapshot,
  )

  useDebugValue(editor)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(instanceManager.onRender(deps))

  useEditorState({
    editor,
    selector: ({ transactionNumber }) => {
      if (options.shouldRerenderOnTransaction === false || options.shouldRerenderOnTransaction === undefined) {
        return null
      }

      if (options.immediatelyRender && transactionNumber === 0) {
        return 0
      }
      return transactionNumber + 1
    },
  })

  return editor
}
