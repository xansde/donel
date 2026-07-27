import type { DonelApi } from '../../shared';

// Tipagem global de `window.donel`, exposto pelo preload via contextBridge
// (src/preload/index.ts). Sem isso o TS trata `window.donel` como `any`.
declare global {
  interface Window {
    donel: DonelApi;
  }
}

export {};
