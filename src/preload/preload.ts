import { contextBridge, ipcRenderer } from "electron";
import type { CaptionFile, ConversionRequest, ConversionResult } from "../shared/types";

const api = {
  chooseSbvFiles: (): Promise<CaptionFile[]> => ipcRenderer.invoke("dialog:choose-sbv"),
  chooseOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:choose-output-directory"),
  resolveSbvFiles: (filePaths: string[]): Promise<CaptionFile[]> => ipcRenderer.invoke("files:resolve-sbv", filePaths),
  convertSbvFiles: (request: ConversionRequest): Promise<ConversionResult[]> =>
    ipcRenderer.invoke("conversion:convert-sbv", request),
  revealPath: (targetPath: string): Promise<void> => ipcRenderer.invoke("shell:reveal-path", targetPath)
};

contextBridge.exposeInMainWorld("sbvConverter", api);

export type SbvConverterApi = typeof api;
