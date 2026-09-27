import type { PaperVaultApi } from '@shared/api'

declare global {
  interface Window {
    papervault: PaperVaultApi
  }
}

export {}
