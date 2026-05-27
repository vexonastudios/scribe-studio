import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioFile,
  CaptionFile,
  ConversionRequest,
  ConversionResult,
  GpuInfo,
  TranscribeEvent,
  TranscribeRequest,
  YouTubeCaptionConversionRequest,
  YouTubeCaptionConversionResult,
  YouTubeCaptionTracksResult
} from "../shared/types";

const api = {
  // ── SBV file conversion ──────────────────────────────────────────────────
  chooseSbvFiles: (): Promise<CaptionFile[]> => ipcRenderer.invoke("dialog:choose-sbv"),
  chooseOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:choose-output-directory"),
  resolveSbvFiles: (filePaths: string[]): Promise<CaptionFile[]> => ipcRenderer.invoke("files:resolve-sbv", filePaths),
  convertSbvFiles: (request: ConversionRequest): Promise<ConversionResult[]> =>
    ipcRenderer.invoke("conversion:convert-sbv", request),

  // ── YouTube captions ─────────────────────────────────────────────────────
  fetchYouTubeCaptions: (videoInput: string): Promise<YouTubeCaptionTracksResult> =>
    ipcRenderer.invoke("youtube:fetch-captions", videoInput),
  convertYouTubeCaption: (request: YouTubeCaptionConversionRequest): Promise<YouTubeCaptionConversionResult> =>
    ipcRenderer.invoke("youtube:convert-caption", request),

  // ── MP3 transcription ────────────────────────────────────────────────────
  chooseAudioFiles: (): Promise<AudioFile[]> => ipcRenderer.invoke("dialog:choose-audio"),
  resolveAudioFiles: (filePaths: string[]): Promise<AudioFile[]> =>
    ipcRenderer.invoke("files:resolve-audio", filePaths),
  startTranscription: (request: TranscribeRequest): Promise<void> =>
    ipcRenderer.invoke("transcribe:start", request),
  cancelTranscription: (): Promise<void> => ipcRenderer.invoke("transcribe:cancel"),
  getGpuInfo: (): Promise<GpuInfo> => ipcRenderer.invoke("transcribe:get-gpu-info"),

  /** Subscribe to streaming transcription events. Returns an unsubscribe function. */
  onTranscribeEvent: (callback: (event: TranscribeEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: TranscribeEvent) => callback(event);
    ipcRenderer.on("transcribe:event", handler);
    return () => ipcRenderer.removeListener("transcribe:event", handler);
  },

  // ── Utilities ────────────────────────────────────────────────────────────
  revealPath: (targetPath: string): Promise<void> => ipcRenderer.invoke("shell:reveal-path", targetPath),
  openFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke("shell:open-folder", folderPath),
  readVttFile: (filePath: string): Promise<string | null> => ipcRenderer.invoke("files:read-vtt", filePath),

  // ── Engine setup ─────────────────────────────────────────────────────────
  checkEngine: (): Promise<{ ready: boolean; pythonPath: string; scriptPath: string }> =>
    ipcRenderer.invoke("engine:check"),
  runEngineSetup: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("engine:setup"),
  onEngineSetupLog: (cb: (line: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on("engine:setup-log", handler);
    return () => ipcRenderer.removeListener("engine:setup-log", handler);
  },
  // ── Updates ───────────────────────────────────────────────────────────────
  installUpdate: (): Promise<void> => ipcRenderer.invoke("update:install"),
  onUpdateAvailable: (cb: (version: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, version: string) => cb(version);
    ipcRenderer.on("update:available", handler);
    return () => ipcRenderer.removeListener("update:available", handler);
  },
  onUpdateDownloaded: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("update:downloaded", handler);
    return () => ipcRenderer.removeListener("update:downloaded", handler);
  }
};

contextBridge.exposeInMainWorld("sbvConverter", api);

export type { SbvConverterApi } from "../shared/types";
