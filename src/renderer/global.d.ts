import type { CodePiApi } from '../shared/contracts'

declare global {
  interface Window {
    codePi: CodePiApi
  }
}

export {}
