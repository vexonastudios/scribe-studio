import type { SbvConverterApi } from "../shared/types";

declare global {
  interface Window {
    sbvConverter?: SbvConverterApi;
  }
}

export {};
