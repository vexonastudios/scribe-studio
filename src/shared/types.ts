export type CaptionFile = {
  path: string;
  name: string;
  size: number;
};

export type ConversionRequest = {
  filePaths: string[];
  outputDir?: string;
  overwriteExisting: boolean;
};

export type ConversionResult = {
  sourcePath: string;
  sourceName: string;
  status: "converted" | "failed";
  outputPath?: string;
  cueCount?: number;
  bytesWritten?: number;
  message?: string;
};

export type YouTubeCaptionTrack = {
  id: string;
  label: string;
  languageCode: string;
  kind: "manual" | "auto";
  isTranslatable: boolean;
  baseUrl: string;
};

export type YouTubeCaptionTracksResult = {
  videoId: string;
  title: string;
  tracks: YouTubeCaptionTrack[];
};

export type YouTubeCaptionConversionRequest = {
  videoInput: string;
  track: YouTubeCaptionTrack;
  outputDir?: string;
  overwriteExisting: boolean;
};

export type YouTubeCaptionConversionResult = {
  videoId: string;
  title: string;
  trackLabel: string;
  languageCode: string;
  status: "converted" | "failed";
  outputPath?: string;
  cueCount?: number;
  bytesWritten?: number;
  message?: string;
};

// ── MP3 Transcription ────────────────────────────────────────────────────────

export type AudioFile = {
  path: string;
  name: string;
  size: number;
};

export type TranscribeRequest = {
  filePaths: string[];
  outputPaths: string[];   // parallel array — must match filePaths length
  model: string;
  wordTimestamps: boolean;
  maxCueChars: number;
  maxCueDuration: number;
  language?: string;
  initialPrompt?: string;
};

export type GpuInfo = {
  gpuName: string | null;
  vramGb: number | null;
  device: "cuda" | "cpu";
};

// ── Events streamed from the Python engine ────────────────────────────────────

export type TranscribeEventReady = {
  type: "ready";
  message: string;
  duration?: number | null;
  jobCount?: number;
};
export type TranscribeEventLog = { type: "log"; message: string };
export type TranscribeEventGpuInfo = { type: "gpu_info" } & GpuInfo;
export type TranscribeEventMetadata = {
  type: "metadata";
  filePath?: string;
  duration?: number | null;
  language?: string | null;
  languageProbability?: number | null;
};
/** Fired before each file begins transcribing (model already loaded). */
export type TranscribeEventFileStart = {
  type: "file_start";
  filePath: string;
  outputPath: string;
  index: number;
  total: number;
  duration?: number | null;
};
export type TranscribeEventSegment = {
  type: "segment";
  filePath?: string;
  text: string;
  currentTime: number;
  duration?: number | null;
  progress?: number | null;
};
export type TranscribeEventComplete = {
  type: "complete";
  filePath?: string;
  message: string;
  outputPath: string;
  transcriptPath: string;
  cueCount: number;
  progress: number;
  duration?: number | null;
  language?: string | null;
  languageProbability?: number | null;
  elapsedSeconds?: number;
  index?: number;
  total?: number;
};
/** Fired once after ALL files in the batch are done. */
export type TranscribeEventAllComplete = {
  type: "all_complete";
  message: string;
  totalFiles: number;
  totalCues: number;
  elapsedSeconds: number;
};
export type TranscribeEventError = {
  type: "error";
  filePath?: string;
  message: string;
  details?: string;
  index?: number;
  total?: number;
};
export type TranscribeEventCancelled = { type: "cancelled"; message: string };

export type TranscribeEvent =
  | TranscribeEventReady
  | TranscribeEventLog
  | TranscribeEventGpuInfo
  | TranscribeEventMetadata
  | TranscribeEventFileStart
  | TranscribeEventSegment
  | TranscribeEventComplete
  | TranscribeEventAllComplete
  | TranscribeEventError
  | TranscribeEventCancelled;

// ── SbvConverterApi ───────────────────────────────────────────────────────────
// Kept in shared so the renderer never needs to import from preload.ts
// (preload.ts imports 'electron' which Vite cannot resolve in the browser context)
export type SbvConverterApi = {
  chooseSbvFiles: () => Promise<CaptionFile[]>;
  chooseOutputDirectory: () => Promise<string | null>;
  resolveSbvFiles: (filePaths: string[]) => Promise<CaptionFile[]>;
  convertSbvFiles: (request: ConversionRequest) => Promise<ConversionResult[]>;
  fetchYouTubeCaptions: (videoInput: string) => Promise<YouTubeCaptionTracksResult>;
  convertYouTubeCaption: (request: YouTubeCaptionConversionRequest) => Promise<YouTubeCaptionConversionResult>;
  chooseAudioFiles: () => Promise<AudioFile[]>;
  resolveAudioFiles: (filePaths: string[]) => Promise<AudioFile[]>;
  startTranscription: (request: TranscribeRequest) => Promise<void>;
  cancelTranscription: () => Promise<void>;
  getGpuInfo: () => Promise<GpuInfo>;
  onTranscribeEvent: (callback: (event: TranscribeEvent) => void) => () => void;
  revealPath: (targetPath: string) => Promise<void>;
  openFolder: (folderPath: string) => Promise<void>;
  readVttFile: (filePath: string) => Promise<string | null>;
  checkEngine: () => Promise<{ ready: boolean; pythonPath: string; scriptPath: string }>;
  runEngineSetup: () => Promise<{ success: boolean; error?: string }>;
  onEngineSetupLog: (cb: (line: string) => void) => () => void;
  installUpdate: () => Promise<void>;
  onUpdateAvailable: (cb: (version: string) => void) => () => void;
  onUpdateDownloaded: (cb: () => void) => () => void;
};
