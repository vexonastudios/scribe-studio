import type { SbvConverterApi } from "../preload/preload";

declare global {
  interface Window {
    sbvConverter?: SbvConverterApi;
  }
}

export {};
