import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  ExternalLink,
  FileAudio,
  FileText,
  FolderOpen,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
  Youtube
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioFile,
  CaptionFile,
  ConversionResult,
  GpuInfo,
  SbvConverterApi,
  TranscribeEvent,
  YouTubeCaptionConversionResult,
  YouTubeCaptionTrack,
  YouTubeCaptionTracksResult
} from "../shared/types";

// ── Types ─────────────────────────────────────────────────────────────────────

type DropFile = File & { path?: string };
type SourceMode = "transcribe" | "files" | "youtube";
type QueueStatus = "ready" | "queued" | "processing" | "converted" | "failed";

interface TranscribeQueueItem {
  file: AudioFile;
  status: QueueStatus;
  progress: number;           // 0–1
  liveSegment: string;
  cueCount?: number;
  outputPath?: string;
  errorMessage?: string;
  elapsedSeconds?: number;    // set when complete
  language?: string | null;   // detected language code
  langProb?: number | null;   // language confidence
}

// ── API shim ──────────────────────────────────────────────────────────────────

const converter: SbvConverterApi =
  window.sbvConverter ?? {
    chooseSbvFiles: async () => [],
    chooseOutputDirectory: async () => null,
    resolveSbvFiles: async () => [],
    convertSbvFiles: async () => { throw new Error("Open in Electron desktop app."); },
    fetchYouTubeCaptions: async () => { throw new Error("Open in Electron desktop app."); },
    convertYouTubeCaption: async () => { throw new Error("Open in Electron desktop app."); },
    chooseAudioFiles: async () => [],
    resolveAudioFiles: async () => [],
    startTranscription: async () => { throw new Error("Open in Electron desktop app."); },
    cancelTranscription: async () => undefined,
    getGpuInfo: async () => ({ gpuName: null, vramGb: null, device: "cpu" }),
    onTranscribeEvent: () => () => undefined,
    revealPath: async () => undefined,
    openFolder: async () => undefined,
    readVttFile: async () => null,
    checkEngine: async () => ({ ready: false, pythonPath: "", scriptPath: "" }),
    runEngineSetup: async () => ({ success: false, error: "Not in Electron" }),
    onEngineSetupLog: () => () => undefined,
    installUpdate: async () => undefined,
    onUpdateAvailable: () => () => undefined,
    onUpdateDownloaded: () => () => undefined,
  };

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, "");
const plannedOutputName = (name: string) => `${stripExtension(name) || "captions"}.vtt`;

const mergeCaptionFiles = (current: CaptionFile[], incoming: CaptionFile[]) => {
  const seen = new Set(current.map((f) => f.path));
  return [...current, ...incoming.filter((f) => !seen.has(f.path))];
};

const mergeAudioFiles = (current: TranscribeQueueItem[], incoming: AudioFile[]): TranscribeQueueItem[] => {
  const seen = new Set(current.map((i) => i.file.path));
  const newItems: TranscribeQueueItem[] = incoming
    .filter((f) => !seen.has(f.path))
    .map((f) => ({ file: f, status: "ready", progress: 0, liveSegment: "" }));
  return [...current, ...newItems];
};

const statusLabel = (status: QueueStatus): string => {
  if (status === "converted") return "Done";
  if (status === "failed") return "Failed";
  if (status === "queued") return "Queued";
  if (status === "processing") return "Processing…";
  return "Ready";
};

const trackKindLabel = (track: YouTubeCaptionTrack) => (track.kind === "auto" ? "Auto" : "Manual");

const WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v2", "large-v3"] as const;
type WhisperModel = (typeof WHISPER_MODELS)[number];

// ── VTT Preview Modal ─────────────────────────────────────────────────────────

function VttPreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void converter.readVttFile(filePath).then((data) => {
      if (!cancelled) { setContent(data); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const fileName = filePath.split(/[/\\]/).pop() ?? "Preview";

  const highlightedContent = useMemo(() => {
    if (!content) return null;
    return content.split("\n").map((line, index) => {
      if (line.startsWith("WEBVTT")) return <span key={index} className="vtt-header">{line}{"\n"}</span>;
      if (line.startsWith("NOTE")) return <span key={index} className="vtt-note">{line}{"\n"}</span>;
      if (line.includes("-->")) return <span key={index} className="vtt-timing">{line}{"\n"}</span>;
      return <span key={index}>{line}{"\n"}</span>;
    });
  }, [content]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <h3 title={fileName}>{fileName}</h3>
          <button className="preview-close" onClick={onClose} title="Close preview (Esc)"><X size={16} /></button>
        </div>
        <div className="preview-content">
          {loading ? (
            <div style={{ display: "grid", placeItems: "center", minHeight: 120 }}>
              <Loader2 className="spin" size={24} />
            </div>
          ) : content ? (
            <pre>{highlightedContent}</pre>
          ) : (
            <p style={{ color: "var(--muted)" }}>Could not load file preview.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── SliderField ──────────────────────────────────────────────────────────────
// A range input with a filled track, endpoint labels, and tick marks.

function SliderField({
  label, value, min, max, step, unit = "", tickCount = 5, onChange, disabled
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  tickCount?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const ticks = Array.from({ length: tickCount }, (_, i) =>
    min + Math.round(((max - min) * i) / (tickCount - 1) / step) * step
  );

  return (
    <label className="field slider-field" style={{ marginTop: 14 }}>
      <div className="slider-label-row">
        <span>{label}</span>
        <strong className="slider-value">{Number.isInteger(value) ? value : value.toFixed(1)}{unit}</strong>
      </div>
      <div className="slider-wrap">
        <input
          type="range"
          className="cue-slider"
          min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
        />
        <div className="slider-ticks">
          {ticks.map((t) => {
            const tp = ((t - min) / (max - min)) * 100;
            return (
              <span key={t} className="slider-tick" style={{ left: `${tp}%` }}>
                <span className="tick-nub" />
                <span className="tick-label">{Number.isInteger(t) ? t : t.toFixed(1)}{unit}</span>
              </span>
            );
          })}
        </div>
      </div>
    </label>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

function GpuBadge({ info }: { info: GpuInfo | null }) {
  if (!info) return (
    <div className="gpu-badge loading"><Loader2 className="spin" size={13} /><span>Detecting GPU…</span></div>
  );
  if (info.device === "cuda" && info.gpuName) return (
    <div className="gpu-badge cuda">
      <span className="gpu-dot" />
      <span>{info.gpuName}{info.vramGb ? ` · ${info.vramGb} GB` : ""}</span>
    </div>
  );
  return (
    <div className="gpu-badge cpu"><Cpu size={13} /><span>CPU mode</span></div>
  );
}

// ── Engine Setup Screen ───────────────────────────────────────────────────────

type SetupPhase = "idle" | "running" | "done" | "error";

function EngineSetupScreen({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<SetupPhase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((line: string) => setLogs((prev) => [...prev, line]), []);

  const handleInstall = useCallback(async () => {
    setPhase("running");
    setLogs([]);
    addLog("Starting engine setup...");
    const unsub = converter.onEngineSetupLog(addLog);
    try {
      const result = await converter.runEngineSetup();
      if (result.success) {
        setPhase("done");
      } else {
        addLog(`Error: ${result.error ?? "Setup failed"}`);
        setPhase("error");
      }
    } catch (err) {
      addLog(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("error");
    } finally {
      unsub();
    }
  }, [addLog]);

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-icon"><Mic size={40} /></div>
        <h1>Engine Setup Required</h1>
        <p className="setup-desc">
          Scribe Studio needs a local AI transcription engine (faster-whisper + PyTorch).
          This is a <strong>one-time download of ~3–4 GB</strong> and takes 5–10 minutes.
          Your GPU will be detected automatically.
        </p>

        {phase === "idle" && (
          <div className="setup-actions">
            <button className="btn-primary" id="btn-install-engine" onClick={() => void handleInstall()}>
              <Play size={18} /><span>Install Engine</span>
            </button>
            <p className="field-hint" style={{ textAlign: "center", marginTop: 8 }}>
              Requires Python 3.10+ on PATH.
            </p>
          </div>
        )}

        {phase === "running" && (
          <div className="setup-running">
            <Loader2 className="spin" size={24} />
            <span>Installing… this takes several minutes</span>
          </div>
        )}

        {phase === "done" && (
          <div className="setup-success">
            <CheckCircle2 size={28} style={{ color: "var(--accent)" }} />
            <span>Engine ready!</span>
            <button className="btn-primary" id="btn-launch-app" onClick={onReady}>
              Launch App →
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="setup-error">
            <AlertCircle size={22} />
            <span>Setup encountered an error — check the log below.</span>
            <button className="btn-secondary" id="btn-retry-setup" onClick={() => void handleInstall()}>
              Retry
            </button>
          </div>
        )}

        {logs.length > 0 && (
          <div className="setup-log" ref={logRef}>
            {logs.map((line, i) => (
              <div key={i} className={`log-line ${
                line.startsWith("✅") ? "success"
                : line.startsWith("❌") || /error|failed/i.test(line) ? "error"
                : ""
              }`}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  // ── Engine readiness (first-run setup gate) ───────────────────────────────
  const [engineReady, setEngineReady] = useState<boolean | null>(null); // null = checking

  useEffect(() => {
    void converter.checkEngine().then((res) => setEngineReady(res.ready));
  }, []);

  const [sourceMode, setSourceMode] = useState<SourceMode>("transcribe");
  const [outputDir, setOutputDir] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // ── Transcribe state ──────────────────────────────────────────────────────
  const [transcribeQueue, setTranscribeQueue] = useState<TranscribeQueueItem[]>([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeModel, setTranscribeModel] = useState<WhisperModel>("large-v3");
  const [wordTimestamps, setWordTimestamps] = useState(true);
  const [maxCueChars, setMaxCueChars] = useState(42);   // ~6-7 words — phrase-level for quote builder
  const [maxCueDuration, setMaxCueDuration] = useState(3.5); // phrase-level, not sentence-level
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [isDraggingAudio, setIsDraggingAudio] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const currentFileRef = useRef<string | null>(null);

  // ── SBV Files state ───────────────────────────────────────────────────────
  const [files, setFiles] = useState<CaptionFile[]>([]);
  const [results, setResults] = useState<ConversionResult[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // ── YouTube state ─────────────────────────────────────────────────────────
  const [youtubeInput, setYoutubeInput] = useState("");
  const [youtubeData, setYoutubeData] = useState<YouTubeCaptionTracksResult | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [youtubeResult, setYoutubeResult] = useState<YouTubeCaptionConversionResult | null>(null);
  const [youtubeError, setYoutubeError] = useState("");
  const [isFetchingCaptions, setIsFetchingCaptions] = useState(false);
  const [isSavingYoutube, setIsSavingYoutube] = useState(false);

  // ── Derived ───────────────────────────────────────────────────────────────
  const resultByPath = useMemo(() => new Map(results.map((r) => [r.sourcePath, r])), [results]);
  const selectedTrack = useMemo(() => youtubeData?.tracks.find((t) => t.id === selectedTrackId) ?? null, [selectedTrackId, youtubeData]);
  const convertedCount = results.filter((r) => r.status === "converted").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const youtubeBusy = isFetchingCaptions || isSavingYoutube;

  const transcribeDoneCount = transcribeQueue.filter((i) => i.status === "converted").length;
  const transcribeFailedCount = transcribeQueue.filter((i) => i.status === "failed").length;
  const transcribeProcessingItem = transcribeQueue.find((i) => i.status === "processing");
  const transcribeReadyCount = transcribeQueue.filter((i) => i.status === "ready" || i.status === "failed").length;

  const defaultOutputLabel = sourceMode === "youtube" ? "Downloads folder" : "Source folder";

  const addLog = (msg: string) => setLogLines((l) => [...l.slice(-199), msg]);

  // ── GPU info on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    void converter.getGpuInfo().then(setGpuInfo);
  }, []);

  // ── Subscribe to transcription events ─────────────────────────────────────
  useEffect(() => {
    const unsub = converter.onTranscribeEvent((event) => {
      switch (event.type) {
        case "gpu_info":
          setGpuInfo({ gpuName: event.gpuName, vramGb: event.vramGb, device: event.device });
          break;

        case "log":
          addLog(event.message);
          break;

        case "file_start":
          // Mark the specific file as processing using its filePath
          setTranscribeQueue((q) =>
            q.map((item) =>
              item.file.path === event.filePath
                ? { ...item, status: "processing", progress: 0, liveSegment: "" }
                : item.status === "ready"
                ? { ...item, status: "queued" }
                : item
            )
          );
          setNotice(`Transcribing ${event.index + 1}/${event.total}: ${event.filePath.split(/[\\/]/).pop()}`);
          break;

        case "segment":
          if (event.filePath) {
            setTranscribeQueue((q) =>
              q.map((item) =>
                item.file.path === event.filePath
                  ? {
                      ...item,
                      progress: event.progress ?? item.progress,
                      liveSegment: event.text ?? item.liveSegment
                    }
                  : item
              )
            );
          }
          break;

        case "complete":
          setTranscribeQueue((q) =>
            q.map((item) =>
              item.file.path === (event.filePath ?? item.file.path) && item.status === "processing"
                ? {
                    ...item,
                    status: "converted",
                    progress: 1,
                    outputPath: event.outputPath,
                    cueCount: event.cueCount,
                    elapsedSeconds: event.elapsedSeconds,
                    language: event.language,
                    langProb: event.languageProbability
                  }
                : item
            )
          );
          setNotice(`✅ ${event.message}`);
          break;

        case "all_complete":
          setIsTranscribing(false);
          setNotice(`✅ ${event.message} (${event.elapsedSeconds}s total)`);
          break;

        case "error":
          setTranscribeQueue((q) =>
            q.map((item) =>
              item.file.path === (event.filePath ?? item.file.path) && item.status === "processing"
                ? { ...item, status: "failed", errorMessage: event.message }
                : item
            )
          );
          addLog(`❌ ${event.message}`);
          if (event.details) addLog(event.details);
          setIsTranscribing(false);
          setNotice(`Error: ${event.message}`);
          // If the engine is missing, drop back to the setup screen so the
          // user can re-run the install without reinstalling the whole app.
          if (event.message?.toLowerCase().includes("engine not found") ||
              event.message?.toLowerCase().includes("setup script")) {
            setEngineReady(false);
          }
          break;

        case "cancelled":
          setTranscribeQueue((q) =>
            q.map((item) =>
              item.status === "processing" || item.status === "queued"
                ? { ...item, status: "ready", progress: 0, liveSegment: "" }
                : item
            )
          );
          setIsTranscribing(false);
          setNotice("Transcription cancelled.");
          break;

        case "ready":
          addLog(event.message);
          setNotice(event.message);
          break;

        case "metadata":
          break;

        default:
          break;
      }
    });
    return unsub;
  }, []);

  // No longer need the queue-watching useEffect — all_complete event handles it

  // ── Transcribe actions ────────────────────────────────────────────────────

  const addAudioFiles = useCallback((incoming: AudioFile[]) => {
    if (incoming.length === 0) { setNotice("No audio files found."); return; }
    setTranscribeQueue((q) => mergeAudioFiles(q, incoming));
    setNotice(`${incoming.length} audio file${incoming.length === 1 ? "" : "s"} added.`);
  }, []);

  const chooseAudioFiles = async () => addAudioFiles(await converter.chooseAudioFiles());

  const removeAudioFile = (filePath: string) => {
    if (isTranscribing) return;
    setTranscribeQueue((q) => q.filter((i) => i.file.path !== filePath));
  };

  const resetTranscribe = useCallback(() => {
    if (isTranscribing) return;
    setTranscribeQueue([]);
    setNotice("Ready");
    currentFileRef.current = null;
  }, [isTranscribing]);

  const startTranscription = async () => {
    const ready = transcribeQueue.filter((i) => i.status === "ready" || i.status === "failed");
    if (ready.length === 0 || isTranscribing) return;

    // Reset failed items to queued, mark all others queued
    setTranscribeQueue((q) => q.map((i) => ({
      ...i,
      status: i.status === "failed" || i.status === "ready" ? "ready" : i.status,
      errorMessage: undefined,
      progress: i.status === "failed" ? 0 : i.progress,
    })));

    setIsTranscribing(true);
    setLogLines([]);
    setNotice("Loading model…");

    // Compute output paths in the renderer so the UI knows them immediately
    const basePath = outputDir?.trim() || null;
    const usedNames = new Set<string>();
    const filePaths: string[] = [];
    const outputPaths: string[] = [];

    for (const item of ready) {
      const dir = basePath ?? item.file.path.replace(/[/\\][^/\\]+$/, "");
      const stem = item.file.name.replace(/\.[^.]+$/, "");
      let candidate = `${dir}/${stem}.vtt`.replace(/\\/g, "/");
      let n = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${dir}/${stem} (${n}).vtt`.replace(/\\/g, "/");
        n++;
      }
      usedNames.add(candidate.toLowerCase());
      filePaths.push(item.file.path);
      outputPaths.push(candidate);
    }

    await converter.startTranscription({
      filePaths,
      outputPaths,
      model: transcribeModel,
      wordTimestamps,
      maxCueChars,
      maxCueDuration,
    });
  };

  const cancelTranscription = async () => {
    await converter.cancelTranscription();
  };

  const onDropAudio = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDraggingAudio(false);
    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((f) => (f as DropFile).path)
      .filter((p): p is string => Boolean(p));
    if (droppedPaths.length === 0) { setNotice("Use Add files for this Electron build."); return; }
    addAudioFiles(await converter.resolveAudioFiles(droppedPaths));
  };

  // ── SBV actions ───────────────────────────────────────────────────────────

  const addSbvFiles = useCallback((incoming: CaptionFile[]) => {
    if (incoming.length === 0) { setNotice("No .sbv files found."); return; }
    setFiles((cur) => mergeCaptionFiles(cur, incoming));
    setResults([]);
    setConversionProgress(0);
    setNotice(`${incoming.length} file${incoming.length === 1 ? "" : "s"} added.`);
  }, []);

  const chooseFiles = async () => addSbvFiles(await converter.chooseSbvFiles());

  const removeFile = (filePath: string) => {
    if (isConverting) return;
    setFiles((cur) => cur.filter((f) => f.path !== filePath));
    setResults((cur) => cur.filter((r) => r.sourcePath !== filePath));
    setNotice("File removed.");
  };

  const resetFiles = useCallback(() => {
    if (isConverting) return;
    setFiles([]); setResults([]); setConversionProgress(0); setNotice("Ready");
  }, [isConverting]);

  const convertFiles = async () => {
    if (files.length === 0 || isConverting) return;
    setIsConverting(true); setResults([]); setConversionProgress(0); setNotice("Converting…");
    try {
      const conversionResults = await converter.convertSbvFiles({
        filePaths: files.map((f) => f.path),
        outputDir: outputDir || undefined,
        overwriteExisting
      });
      setResults(conversionResults);
      setConversionProgress(1);
      const converted = conversionResults.filter((r) => r.status === "converted").length;
      const failed = conversionResults.length - converted;
      setNotice(failed ? `${converted} converted, ${failed} failed.` : `${converted} file${converted === 1 ? "" : "s"} converted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

  const onDropSbv = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault(); setIsDragging(false);
    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((f) => (f as DropFile).path)
      .filter((p): p is string => Boolean(p));
    if (droppedPaths.length === 0) { setNotice("Use Add files for this Electron build."); return; }
    addSbvFiles(await converter.resolveSbvFiles(droppedPaths));
  };

  // ── YouTube actions ───────────────────────────────────────────────────────

  const resetYouTube = useCallback(() => {
    if (youtubeBusy) return;
    setYoutubeInput(""); setYoutubeData(null); setSelectedTrackId("");
    setYoutubeResult(null); setYoutubeError(""); setNotice("Ready");
  }, [youtubeBusy]);

  const fetchYouTubeCaptions = async () => {
    if (!youtubeInput.trim() || isFetchingCaptions) return;
    setIsFetchingCaptions(true); setYoutubeError(""); setYoutubeResult(null);
    setYoutubeData(null); setSelectedTrackId(""); setNotice("Finding captions…");
    try {
      const captions = await converter.fetchYouTubeCaptions(youtubeInput);
      setYoutubeData(captions);
      setSelectedTrackId(captions.tracks[0]?.id ?? "");
      setNotice(`${captions.tracks.length} caption track${captions.tracks.length === 1 ? "" : "s"} found.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load YouTube captions.";
      setYoutubeError(message); setNotice(message);
    } finally {
      setIsFetchingCaptions(false);
    }
  };

  const convertYouTube = async () => {
    if (!selectedTrack || isSavingYoutube) return;
    setIsSavingYoutube(true); setYoutubeError(""); setYoutubeResult(null); setNotice("Downloading captions…");
    try {
      const result = await converter.convertYouTubeCaption({
        videoInput: youtubeInput, track: selectedTrack,
        outputDir: outputDir || undefined, overwriteExisting
      });
      setYoutubeResult(result);
      setNotice(result.status === "converted" ? "YouTube captions converted." : result.message ?? "Caption conversion failed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Caption conversion failed.";
      setYoutubeError(message); setNotice(message);
    } finally {
      setIsSavingYoutube(false);
    }
  };

  // ── Output directory ──────────────────────────────────────────────────────

  const chooseOutputDirectory = async () => {
    const selected = await converter.chooseOutputDirectory();
    if (selected) { setOutputDir(selected); setNotice("Output folder selected."); }
  };

  // ── Busy state ────────────────────────────────────────────────────────────
  const isBusy = isConverting || youtubeBusy || isTranscribing;

  // ── Status icons ──────────────────────────────────────────────────────────
  const queueStatusSbv = (file: CaptionFile): QueueStatus => {
    const result = resultByPath.get(file.path);
    if (result?.status) return result.status;
    return isConverting ? "queued" : "ready";
  };

  const trackStatus = (track: YouTubeCaptionTrack): QueueStatus => {
    if (isSavingYoutube && selectedTrackId === track.id) return "queued";
    if (youtubeResult && selectedTrackId === track.id) return youtubeResult.status;
    return "ready";
  };

  // ── App update banner ─────────────────────────────────────────────────────
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const unsubAvail = converter.onUpdateAvailable((v) => setUpdateVersion(v));
    const unsubDone  = converter.onUpdateDownloaded(() => setUpdateReady(true));
    return () => { unsubAvail(); unsubDone(); };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Show a loading shimmer while we check if the engine is installed
  if (engineReady === null) {
    return (
      <div className="setup-screen">
        <div className="setup-card" style={{ gap: 16 }}>
          <Loader2 className="spin" size={32} style={{ color: "var(--accent)" }} />
          <p style={{ color: "var(--ink-secondary)" }}>Checking engine…</p>
        </div>
      </div>
    );
  }

  // First-run: engine not installed — show setup screen
  if (!engineReady) {
    return <EngineSetupScreen onReady={() => setEngineReady(true)} />;
  }

  return (
    <main className="app-shell">
      {previewPath && (
        <VttPreviewModal filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}

      {/* Topbar */}
      <section className="topbar">
        <div>
          <p className="eyebrow">Vexona Studios</p>
          <h1>Scribe Studio</h1>
        </div>
        <GpuBadge info={gpuInfo} />
        <div className="notice-pill" title={notice}>
          {isBusy ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice}</span>
        </div>
      </section>

      {/* Update banner */}
      {updateVersion && (
        <div className="update-banner">
          <span>
            {updateReady
              ? `✅ Scribe Studio ${updateVersion} downloaded — restart to apply.`
              : `🔄 Scribe Studio ${updateVersion} is downloading in the background…`}
          </span>
          {updateReady && (
            <button
              className="update-banner-btn"
              onClick={() => void converter.installUpdate()}
            >
              Restart & Update
            </button>
          )}
        </div>
      )}

      <section className="workspace">
        {/* Left control panel */}
        <aside className="control-panel">
          {/* Tab bar */}
          <div className="source-tabs" aria-label="Source mode">
            <button
              id="tab-transcribe"
              className={sourceMode === "transcribe" ? "selected" : ""}
              onClick={() => setSourceMode("transcribe")}
            >
              <Mic size={15} />
              <span>Transcribe</span>
            </button>
            <button
              id="tab-sbv"
              className={sourceMode === "files" ? "selected" : ""}
              onClick={() => setSourceMode("files")}
            >
              <FileText size={15} />
              <span>SBV Files</span>
            </button>
            <button
              id="tab-youtube"
              className={sourceMode === "youtube" ? "selected" : ""}
              onClick={() => setSourceMode("youtube")}
            >
              <Youtube size={15} />
              <span>YouTube</span>
            </button>
          </div>

          {/* ── Transcribe panel ── */}
          {sourceMode === "transcribe" && (
            <>
              <div className="panel-heading">
                <Mic size={20} />
                <h2>Audio Files</h2>
              </div>

              <section
                className={`drop-zone ${isDraggingAudio ? "active" : ""}`}
                onDragEnter={(e) => { e.preventDefault(); setIsDraggingAudio(true); }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => setIsDraggingAudio(false)}
                onDrop={onDropAudio}
                aria-label="Drop audio files"
              >
                <FileAudio size={28} />
                <strong>Drop MP3 / M4A / WAV / FLAC</strong>
                <span>{transcribeQueue.length ? `${transcribeQueue.length} queued` : "No files added"}</span>
              </section>

              <div className="button-row">
                <button id="btn-add-audio" className="primary-action" onClick={chooseAudioFiles} disabled={isTranscribing}>
                  <Upload size={18} />
                  <span>Add audio</span>
                </button>
                <button className="icon-button" onClick={resetTranscribe} disabled={isTranscribing} title="Reset queue">
                  <RotateCcw size={18} />
                </button>
              </div>

              {/* Audio queue preview */}
              <div className="file-list" aria-label="Audio queue">
                {transcribeQueue.length === 0 ? (
                  <div className="empty-state">No audio files</div>
                ) : (
                  transcribeQueue.map((item) => (
                    <article className="file-row" key={item.file.path}>
                      <FileAudio size={18} />
                      <div>
                        <strong>{item.file.name}</strong>
                        <span>{formatBytes(item.file.size)}</span>
                        <small>{plannedOutputName(item.file.name)}</small>
                      </div>
                      <button
                        className="remove-file"
                        onClick={() => removeAudioFile(item.file.path)}
                        disabled={isTranscribing}
                        title="Remove"
                      >
                        <Trash2 size={15} />
                      </button>
                    </article>
                  ))
                )}
              </div>

              {/* Model & settings */}
              <div className="panel-heading settings-heading">
                <Settings2 size={20} />
                <h2>Model Settings</h2>
              </div>

              <label className="field">
                <span>Whisper Model</span>
                <div className="select-wrap">
                  <select
                    id="model-select"
                    className="model-select"
                    value={transcribeModel}
                    onChange={(e) => setTranscribeModel(e.target.value as WhisperModel)}
                    disabled={isTranscribing}
                  >
                    <option value="tiny">tiny (75 MB — fastest)</option>
                    <option value="base">base (150 MB)</option>
                    <option value="small">small (490 MB)</option>
                    <option value="medium">medium (1.5 GB)</option>
                    <option value="large-v2">large-v2 (3 GB)</option>
                    <option value="large-v3">large-v3 (3 GB — recommended)</option>
                  </select>
                  <ChevronDown size={14} className="select-chevron" />
                </div>
              </label>

              <label className="toggle" style={{ marginTop: 14 }}>
                <input
                  type="checkbox"
                  checked={wordTimestamps}
                  onChange={(e) => setWordTimestamps(e.target.checked)}
                  disabled={isTranscribing}
                />
                <span>Word-level timestamps (phrase cues)</span>
              </label>

              <SliderField
                label="Max chars per cue"
                value={maxCueChars}
                min={24} max={120} step={4}
                tickCount={6}
                onChange={setMaxCueChars}
                disabled={isTranscribing}
              />

              <SliderField
                label="Max cue duration"
                value={maxCueDuration}
                min={1.5} max={10} step={0.5}
                unit="s"
                tickCount={5}
                onChange={setMaxCueDuration}
                disabled={isTranscribing}
              />

              {/* GPU auto-status — informational only, no tuning needed */}
              <div className="gpu-auto-chip">
                {!gpuInfo ? (
                  <><Loader2 className="spin" size={12} /><span>Detecting GPU…</span></>
                ) : gpuInfo.device === "cuda" ? (
                  <><span className="gpu-dot" /><span><strong>{gpuInfo.gpuName}</strong>{gpuInfo.vramGb ? ` · ${gpuInfo.vramGb} GB` : ""} · GPU active</span></>
                ) : (
                  <><Cpu size={12} /><span>No GPU detected — using CPU</span></>
                )}
              </div>
            </>
          )}

          {/* ── SBV Files panel ── */}
          {sourceMode === "files" && (
            <>
              <div className="panel-heading">
                <FileText size={20} />
                <h2>Source Files</h2>
              </div>

              <section
                className={`drop-zone ${isDragging ? "active" : ""}`}
                onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDropSbv}
                aria-label="Drop SBV files or folders"
              >
                <Upload size={28} />
                <strong>Drop .sbv files or folders</strong>
                <span>{files.length ? `${files.length} selected` : "No files selected"}</span>
              </section>

              <div className="button-row">
                <button className="primary-action" onClick={chooseFiles} title="Add SBV files (Ctrl+O)">
                  <Upload size={18} />
                  <span>Add files</span>
                  <span className="kbd-hint">⌃O</span>
                </button>
                <button className="icon-button" onClick={resetFiles} disabled={isConverting} title="Reset list (Ctrl+R)">
                  <RotateCcw size={18} />
                </button>
              </div>

              <div className="file-list" aria-label="Selected SBV files">
                {files.length === 0 ? (
                  <div className="empty-state">No SBV files</div>
                ) : (
                  files.map((file) => (
                    <article className="file-row" key={file.path}>
                      <FileText size={18} />
                      <div>
                        <strong>{file.name}</strong>
                        <span>{formatBytes(file.size)}</span>
                        <small>{plannedOutputName(file.name)}</small>
                      </div>
                      <button
                        className="remove-file"
                        onClick={() => removeFile(file.path)}
                        disabled={isConverting}
                        title="Remove file"
                      >
                        <Trash2 size={15} />
                      </button>
                    </article>
                  ))
                )}
              </div>
            </>
          )}

          {/* ── YouTube panel ── */}
          {sourceMode === "youtube" && (
            <>
              <div className="panel-heading">
                <Youtube size={20} />
                <h2>YouTube</h2>
              </div>

              <label className="field">
                <span>Video ID or URL</span>
                <input
                  value={youtubeInput}
                  onChange={(e) => setYoutubeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void fetchYouTubeCaptions(); }}
                  placeholder="dQw4w9WgXcQ"
                  disabled={youtubeBusy}
                />
              </label>

              <div className="button-row">
                <button className="primary-action" onClick={fetchYouTubeCaptions} disabled={!youtubeInput.trim() || youtubeBusy}>
                  {isFetchingCaptions ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                  <span>Find captions</span>
                </button>
                <button className="icon-button" onClick={resetYouTube} disabled={youtubeBusy} title="Reset (Ctrl+R)">
                  <RotateCcw size={18} />
                </button>
              </div>

              {youtubeError && (
                <div className="inline-alert">
                  <AlertCircle size={18} />
                  <span>{youtubeError}</span>
                </div>
              )}

              {youtubeData && (
                <div className="video-card">
                  <strong title={youtubeData.title}>{youtubeData.title}</strong>
                  <span>{youtubeData.videoId}</span>
                  <small>{youtubeData.tracks.length} track{youtubeData.tracks.length === 1 ? "" : "s"}</small>
                </div>
              )}
            </>
          )}

          {/* ── Output settings (all modes) ── */}
          <div className="panel-heading settings-heading">
            <FolderOpen size={20} />
            <h2>Output</h2>
          </div>

          <button className="secondary-action" onClick={chooseOutputDirectory} title="Choose output folder">
            <FolderOpen size={18} />
            <span>{outputDir ? "Change folder" : "Choose folder"}</span>
          </button>

          {outputDir && (
            <button
              className="secondary-action"
              style={{ marginTop: 6 }}
              onClick={() => void converter.openFolder(outputDir)}
              title="Open output folder in Explorer"
            >
              <ExternalLink size={18} />
              <span>Open folder</span>
            </button>
          )}

          <div className="path-readout" title={outputDir || defaultOutputLabel}>
            {outputDir || defaultOutputLabel}
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(e) => setOverwriteExisting(e.target.checked)}
              disabled={isBusy}
            />
            <span>Overwrite existing VTT files</span>
          </label>
        </aside>

        {/* ── Right run panel ── */}
        <section className="run-panel">
          {/* ── Transcribe run panel ── */}
          {sourceMode === "transcribe" && (
            <>
              <div className="run-header">
                <div>
                  <p className="eyebrow">Transcription Queue</p>
                  <h2>
                    {transcribeQueue.length
                      ? `${transcribeQueue.length} audio file${transcribeQueue.length === 1 ? "" : "s"}`
                      : "Ready"}
                  </h2>
                </div>
                <div className="run-actions">
                  {transcribeDoneCount > 0 && !isTranscribing && (
                    <button
                      className="icon-button"
                      onClick={() => setTranscribeQueue((q) => q.filter((i) => i.status !== "converted"))}
                      title="Clear completed"
                    >
                      <CheckCircle2 size={18} />
                    </button>
                  )}
                  <button className="icon-button" onClick={resetTranscribe} disabled={isTranscribing} title="Reset queue">
                    <RotateCcw size={18} />
                  </button>
                  {isTranscribing ? (
                    <button id="btn-cancel" className="cancel-action" onClick={cancelTranscription} title="Cancel transcription">
                      <Square size={18} />
                      <span>Cancel</span>
                    </button>
                  ) : (
                    <button
                      id="btn-transcribe"
                      className="start-action"
                      onClick={startTranscription}
                      disabled={transcribeReadyCount === 0}
                      title="Start transcription"
                    >
                      <Play size={18} />
                      <span>Transcribe{transcribeReadyCount > 0 ? ` ${transcribeReadyCount}` : ""}</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="stats-grid">
                <div>
                  <span>Ready</span>
                  <strong>{transcribeReadyCount}</strong>
                </div>
                <div>
                  <span>Done</span>
                  <strong>{transcribeDoneCount}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{transcribeFailedCount}</strong>
                </div>
              </div>

              {/* Live segment display */}
              {transcribeProcessingItem && (
                <div className="segment-live">
                  <span className="segment-label">Processing: {transcribeProcessingItem.file.name}</span>
                  <p>{transcribeProcessingItem.liveSegment || "Loading model…"}</p>
                  <div className="transcribe-progress-track">
                    <div
                      className="transcribe-progress-fill"
                      style={{ width: `${Math.round(transcribeProcessingItem.progress * 100)}%` }}
                    />
                  </div>
                  <span className="segment-pct">{Math.round(transcribeProcessingItem.progress * 100)}%</span>
                </div>
              )}

              <div className="queue-list">
                {transcribeQueue.length === 0 ? (
                  <div className="empty-state large">Add MP3 or audio files to begin.</div>
                ) : (
                  transcribeQueue.map((item) => (
                    <article className={`queue-row ${item.status}`} key={item.file.path}>
                      <div className="status-icon">
                        {item.status === "converted" && <CheckCircle2 size={20} />}
                        {item.status === "failed" && <XCircle size={20} />}
                        {(item.status === "queued" || item.status === "processing") && <Loader2 className="spin" size={20} />}
                        {item.status === "ready" && <FileAudio size={20} />}
                      </div>
                      <div className="queue-main">
                        <div className="queue-title">
                          <strong>{item.file.name}</strong>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            {item.language && (
                              <span className="lang-badge">
                                {item.language.toUpperCase()}
                                {item.langProb != null ? ` ${Math.round(item.langProb * 100)}%` : ""}
                              </span>
                            )}
                            {item.elapsedSeconds != null && (
                              <span className="elapsed-badge">{item.elapsedSeconds}s</span>
                            )}
                            <span>{statusLabel(item.status)}</span>
                          </div>
                        </div>
                        <p title={item.errorMessage || item.outputPath || item.file.path}>
                          {item.status === "failed" && item.errorMessage}
                          {item.status === "converted" && item.cueCount !== undefined && `${item.cueCount} cues`}
                          {item.status === "processing" && (
                            <span className="inline-progress">
                              <span
                                className="inline-progress-fill"
                                style={{ width: `${Math.round(item.progress * 100)}%` }}
                              />
                            </span>
                          )}
                          {(item.status === "ready" || item.status === "queued") && formatBytes(item.file.size)}
                        </p>
                        {item.outputPath && <small title={item.outputPath}>{item.outputPath}</small>}
                      </div>
                      {item.outputPath && (
                        <>
                          <button className="icon-button" onClick={() => setPreviewPath(item.outputPath!)} title="Preview VTT">
                            <Eye size={18} />
                          </button>
                          <button
                            className="icon-button"
                            onClick={() => void navigator.clipboard.writeText(item.outputPath!)}
                            title="Copy path"
                          >
                            <FileText size={18} />
                          </button>
                          <button className="icon-button" onClick={() => void converter.revealPath(item.outputPath!)} title="Reveal file">
                            <ExternalLink size={18} />
                          </button>
                        </>
                      )}
                      {item.status === "failed" && <AlertCircle className="row-alert" size={18} />}
                    </article>
                  ))
                )}
              </div>

              {/* Log drawer */}
              {logLines.length > 0 && (
                <div className="log-drawer">
                  <button className="log-toggle" onClick={() => setShowLog((v) => !v)}>
                    <span>Engine Log ({logLines.length})</span>
                    <ChevronDown size={14} style={{ transform: showLog ? "rotate(180deg)" : "none", transition: "transform 200ms" }} />
                  </button>
                  {showLog && (
                    <div className="log-body">
                      {logLines.map((line, i) => (
                        <div key={i} className="log-line">{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── SBV Files run panel ── */}
          {sourceMode === "files" && (
            <>
              <div className="run-header">
                <div>
                  <p className="eyebrow">Conversion Queue</p>
                  <h2>{files.length ? `${files.length} SBV file${files.length === 1 ? "" : "s"}` : "Ready"}</h2>
                </div>
                <div className="run-actions">
                  <button className="icon-button" onClick={resetFiles} disabled={isConverting} title="Reset (Ctrl+R)">
                    <RotateCcw size={18} />
                  </button>
                  <button
                    className="start-action"
                    onClick={convertFiles}
                    disabled={files.length === 0 || isConverting}
                    title="Convert to VTT (Ctrl+Enter)"
                  >
                    {isConverting ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                    <span>Convert</span>
                    <span className="kbd-hint">⌃↵</span>
                  </button>
                </div>
              </div>

              <div className="stats-grid">
                <div><span>Selected</span><strong>{files.length}</strong></div>
                <div><span>Converted</span><strong>{convertedCount}</strong></div>
                <div><span>Failed</span><strong>{failedCount}</strong></div>
              </div>

              {(isConverting || conversionProgress > 0) && (
                <div className="progress-bar-track">
                  <div
                    className={`progress-bar-fill ${isConverting ? "active" : ""}`}
                    style={{ width: `${isConverting ? 85 : conversionProgress * 100}%` }}
                  />
                </div>
              )}

              <div className="queue-list">
                {files.length === 0 ? (
                  <div className="empty-state large">Add SBV files to begin.</div>
                ) : (
                  files.map((file) => {
                    const result = resultByPath.get(file.path);
                    const status = queueStatusSbv(file);
                    const outputPath = result?.outputPath;
                    return (
                      <article className={`queue-row ${status}`} key={file.path}>
                        <div className="status-icon">
                          {status === "converted" && <CheckCircle2 size={20} />}
                          {status === "failed" && <XCircle size={20} />}
                          {status === "queued" && <Loader2 className="spin" size={20} />}
                          {status === "ready" && <FileText size={20} />}
                        </div>
                        <div className="queue-main">
                          <div className="queue-title">
                            <strong>{file.name}</strong>
                            <span>{statusLabel(status)}</span>
                          </div>
                          <p title={result?.message || outputPath || file.path}>
                            {result?.status === "failed" && result.message}
                            {result?.status === "converted" &&
                              `${result.cueCount ?? 0} cues written${result.bytesWritten ? `, ${formatBytes(result.bytesWritten)}` : ""}`}
                            {!result && (outputDir ? plannedOutputName(file.name) : "Writes beside source")}
                          </p>
                          {outputPath && <small title={outputPath}>{outputPath}</small>}
                        </div>
                        {outputPath && (
                          <>
                            <button className="icon-button" onClick={() => setPreviewPath(outputPath)} title="Preview VTT">
                              <Eye size={18} />
                            </button>
                            <button className="icon-button" onClick={() => converter.revealPath(outputPath)} title="Reveal VTT file">
                              <ExternalLink size={18} />
                            </button>
                          </>
                        )}
                        {status === "failed" && <AlertCircle className="row-alert" size={18} />}
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}

          {/* ── YouTube run panel ── */}
          {sourceMode === "youtube" && (
            <>
              <div className="run-header">
                <div>
                  <p className="eyebrow">Caption Tracks</p>
                  <h2>{youtubeData?.title ?? "Ready"}</h2>
                </div>
                <div className="run-actions">
                  <button className="icon-button" onClick={resetYouTube} disabled={youtubeBusy} title="Reset (Ctrl+R)">
                    <RotateCcw size={18} />
                  </button>
                  <button
                    className="start-action"
                    onClick={convertYouTube}
                    disabled={!selectedTrack || youtubeBusy}
                    title="Convert to VTT (Ctrl+Enter)"
                  >
                    {isSavingYoutube ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                    <span>Convert</span>
                    <span className="kbd-hint">⌃↵</span>
                  </button>
                </div>
              </div>

              <div className="stats-grid">
                <div><span>Tracks</span><strong>{youtubeData?.tracks.length ?? 0}</strong></div>
                <div><span>Selected</span><strong>{selectedTrack ? 1 : 0}</strong></div>
                <div><span>Converted</span><strong>{youtubeResult?.status === "converted" ? 1 : 0}</strong></div>
              </div>

              <div className="queue-list">
                {!youtubeData ? (
                  <div className="empty-state large">Find captions from a YouTube video.</div>
                ) : (
                  youtubeData.tracks.map((track) => {
                    const status = trackStatus(track);
                    const isSelected = selectedTrackId === track.id;
                    const outputPath = isSelected ? youtubeResult?.outputPath : undefined;
                    return (
                      <article
                        className={`queue-row ${status} ${isSelected ? "selected" : ""}`}
                        key={track.id}
                        onClick={() => {
                          if (!youtubeBusy && selectedTrackId !== track.id) {
                            setSelectedTrackId(track.id);
                            setYoutubeResult(null);
                          }
                        }}
                      >
                        <div className="status-icon">
                          {status === "converted" && <CheckCircle2 size={20} />}
                          {status === "failed" && <XCircle size={20} />}
                          {status === "queued" && <Loader2 className="spin" size={20} />}
                          {status === "ready" && <Youtube size={20} />}
                        </div>
                        <div className="queue-main">
                          <div className="queue-title">
                            <strong>{track.label}</strong>
                            <span>{isSelected ? "Selected" : trackKindLabel(track)}</span>
                          </div>
                          <p title={youtubeResult?.message || track.languageCode}>
                            {isSelected && youtubeResult?.status === "failed" && youtubeResult.message}
                            {isSelected && youtubeResult?.status === "converted" &&
                              `${youtubeResult.cueCount ?? 0} cues written${youtubeResult.bytesWritten ? `, ${formatBytes(youtubeResult.bytesWritten)}` : ""}`}
                            {(!isSelected || !youtubeResult) &&
                              `${track.languageCode.toUpperCase()} · ${trackKindLabel(track)}${track.isTranslatable ? " · Translatable" : ""}`}
                          </p>
                          {outputPath && <small title={outputPath}>{outputPath}</small>}
                        </div>
                        {outputPath && (
                          <>
                            <button className="icon-button" onClick={(e) => { e.stopPropagation(); setPreviewPath(outputPath); }} title="Preview VTT">
                              <Eye size={18} />
                            </button>
                            <button className="icon-button" onClick={(e) => { e.stopPropagation(); void converter.revealPath(outputPath); }} title="Reveal VTT file">
                              <ExternalLink size={18} />
                            </button>
                          </>
                        )}
                        {status === "failed" && <AlertCircle className="row-alert" size={18} />}
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
