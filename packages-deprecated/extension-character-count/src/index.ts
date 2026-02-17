import { CharacterCount } from '@tiptap/extensions'
import type { CharacterCountStorage } from '@tiptap/extensions'

export type { CharacterCountOptions } from '@tiptap/extensions'
export { CharacterCount } from '@tiptap/extensions'

declare module '@tiptap/core' {
  interface Storage {
    characterCount: CharacterCountStorage
  }
}

export default CharacterCount
