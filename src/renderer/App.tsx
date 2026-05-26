import {
  AlertCircle,
  CheckCircle2,
  Eye,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
  Youtube
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaptionFile, ConversionResult, YouTubeCaptionConversionResult, YouTubeCaptionTrack, YouTubeCaptionTracksResult } from "../shared/types";
import type { SbvConverterApi } from "../preload/preload";

type DropFile = File & {
  path?: string;
};

type SourceMode = "files" | "youtube";
type QueueStatus = "ready" | "queued" | "converted" | "failed";

const converter: SbvConverterApi =
  window.sbvConverter ?? {
    chooseSbvFiles: async () => [],
    chooseOutputDirectory: async () => null,
    resolveSbvFiles: async () => [],
    convertSbvFiles: async () => {
      throw new Error("Open this screen in the Electron desktop app.");
    },
    fetchYouTubeCaptions: async () => {
      throw new Error("Open this screen in the Electron desktop app.");
    },
    convertYouTubeCaption: async () => {
      throw new Error("Open this screen in the Electron desktop app.");
    },
    revealPath: async () => undefined,
    readVttFile: async () => null
  };

const formatBytes = (bytes: number) => {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, "");

const plannedOutputName = (name: string) => `${stripExtension(name) || "captions"}.vtt`;

const mergeFiles = (current: CaptionFile[], incoming: CaptionFile[]) => {
  const seen = new Set(current.map((file) => file.path));
  const merged = [...current];

  incoming.forEach((file) => {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      merged.push(file);
    }
  });

  return merged;
};

const statusLabel = (status: QueueStatus) => {
  if (status === "converted") {
    return "Converted";
  }

  if (status === "failed") {
    return "Failed";
  }

  if (status === "queued") {
    return "Queued";
  }

  return "Ready";
};

const trackKindLabel = (track: YouTubeCaptionTrack) => (track.kind === "auto" ? "Auto" : "Manual");

function VttPreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void converter.readVttFile(filePath).then((data) => {
      if (!cancelled) {
        setContent(data);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const fileName = filePath.split(/[/\\]/).pop() ?? "Preview";

  const highlightedContent = useMemo(() => {
    if (!content) {
      return null;
    }

    return content.split("\n").map((line, index) => {
      if (line.startsWith("WEBVTT")) {
        return <span key={index} className="vtt-header">{line}{"\n"}</span>;
      }

      if (line.startsWith("NOTE")) {
        return <span key={index} className="vtt-note">{line}{"\n"}</span>;
      }

      if (line.includes("-->")) {
        return <span key={index} className="vtt-timing">{line}{"\n"}</span>;
      }

      return <span key={index}>{line}{"\n"}</span>;
    });
  }, [content]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="preview-header">
          <h3 title={fileName}>{fileName}</h3>
          <button className="preview-close" onClick={onClose} title="Close preview (Esc)">
            <X size={16} />
          </button>
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

function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("files");
  const [files, setFiles] = useState<CaptionFile[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [results, setResults] = useState<ConversionResult[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState("Ready");

  const [youtubeInput, setYoutubeInput] = useState("");
  const [youtubeData, setYoutubeData] = useState<YouTubeCaptionTracksResult | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [youtubeResult, setYoutubeResult] = useState<YouTubeCaptionConversionResult | null>(null);
  const [youtubeError, setYoutubeError] = useState("");
  const [isFetchingCaptions, setIsFetchingCaptions] = useState(false);
  const [isSavingYoutube, setIsSavingYoutube] = useState(false);

  // Progress tracking for batch conversion
  const [conversionProgress, setConversionProgress] = useState(0);

  // VTT preview
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const resultByPath = useMemo(() => new Map(results.map((result) => [result.sourcePath, result])), [results]);
  const selectedTrack = useMemo(
    () => youtubeData?.tracks.find((track) => track.id === selectedTrackId) ?? null,
    [selectedTrackId, youtubeData]
  );
  const convertedCount = results.filter((result) => result.status === "converted").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const youtubeBusy = isFetchingCaptions || isSavingYoutube;
  const canConvertFiles = files.length > 0 && !isConverting;
  const canConvertYoutube = Boolean(selectedTrack) && !youtubeBusy;
  const canConvert = sourceMode === "files" ? canConvertFiles : canConvertYoutube;
  const defaultOutputLabel = sourceMode === "youtube" ? "Downloads folder" : "Source folder";

  const addFiles = useCallback((incoming: CaptionFile[]) => {
    if (incoming.length === 0) {
      setNotice("No .sbv files found.");
      return;
    }

    setFiles((current) => mergeFiles(current, incoming));
    setResults([]);
    setConversionProgress(0);
    setNotice(`${incoming.length} file${incoming.length === 1 ? "" : "s"} added.`);
  }, []);

  const chooseFiles = async () => {
    addFiles(await converter.chooseSbvFiles());
  };

  const chooseOutputDirectory = async () => {
    const selected = await converter.chooseOutputDirectory();
    if (selected) {
      setOutputDir(selected);
      setNotice("Output folder selected.");
    }
  };

  const removeFile = (filePath: string) => {
    if (isConverting) {
      return;
    }

    setFiles((current) => current.filter((file) => file.path !== filePath));
    setResults((current) => current.filter((result) => result.sourcePath !== filePath));
    setNotice("File removed.");
  };

  const resetFiles = useCallback(() => {
    if (isConverting) {
      return;
    }

    setFiles([]);
    setResults([]);
    setConversionProgress(0);
    setNotice("Ready");
  }, [isConverting]);

  const resetYouTube = useCallback(() => {
    if (youtubeBusy) {
      return;
    }

    setYoutubeInput("");
    setYoutubeData(null);
    setSelectedTrackId("");
    setYoutubeResult(null);
    setYoutubeError("");
    setNotice("Ready");
  }, [youtubeBusy]);

  const resetActiveMode = useCallback(() => {
    if (sourceMode === "files") {
      resetFiles();
    } else {
      resetYouTube();
    }
  }, [sourceMode, resetFiles, resetYouTube]);

  const convertFiles = async () => {
    if (!canConvertFiles) {
      return;
    }

    setIsConverting(true);
    setResults([]);
    setConversionProgress(0);
    setNotice("Converting...");

    try {
      const conversionResults = await converter.convertSbvFiles({
        filePaths: files.map((file) => file.path),
        outputDir: outputDir || undefined,
        overwriteExisting
      });

      setResults(conversionResults);
      setConversionProgress(1);
      const converted = conversionResults.filter((result) => result.status === "converted").length;
      const failed = conversionResults.length - converted;
      setNotice(failed ? `${converted} converted, ${failed} failed.` : `${converted} file${converted === 1 ? "" : "s"} converted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

  const fetchYouTubeCaptions = async () => {
    if (!youtubeInput.trim() || isFetchingCaptions) {
      return;
    }

    setIsFetchingCaptions(true);
    setYoutubeError("");
    setYoutubeResult(null);
    setYoutubeData(null);
    setSelectedTrackId("");
    setNotice("Finding captions...");

    try {
      const captions = await converter.fetchYouTubeCaptions(youtubeInput);
      setYoutubeData(captions);
      setSelectedTrackId(captions.tracks[0]?.id ?? "");
      setNotice(`${captions.tracks.length} caption track${captions.tracks.length === 1 ? "" : "s"} found.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load YouTube captions.";
      setYoutubeError(message);
      setNotice(message);
    } finally {
      setIsFetchingCaptions(false);
    }
  };

  const convertYouTube = async () => {
    if (!selectedTrack || isSavingYoutube) {
      return;
    }

    setIsSavingYoutube(true);
    setYoutubeError("");
    setYoutubeResult(null);
    setNotice("Downloading captions...");

    try {
      const result = await converter.convertYouTubeCaption({
        videoInput: youtubeInput,
        track: selectedTrack,
        outputDir: outputDir || undefined,
        overwriteExisting
      });

      setYoutubeResult(result);
      setNotice(result.status === "converted" ? "YouTube captions converted." : result.message ?? "Caption conversion failed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Caption conversion failed.";
      setYoutubeError(message);
      setNotice(message);
    } finally {
      setIsSavingYoutube(false);
    }
  };

  const convertActiveMode = useCallback(() => {
    if (sourceMode === "files") {
      void convertFiles();
    } else {
      void convertYouTube();
    }
  }, [sourceMode, canConvertFiles, canConvertYoutube, files, outputDir, overwriteExisting, youtubeInput, selectedTrack]);

  const onDrop = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);

    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((file) => (file as DropFile).path)
      .filter((filePath): filePath is string => Boolean(filePath));

    if (droppedPaths.length === 0) {
      setNotice("Use Add files for this Electron build.");
      return;
    }

    addFiles(await converter.resolveSbvFiles(droppedPaths));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCtrl = event.ctrlKey || event.metaKey;

      if (isCtrl && event.key === "o") {
        event.preventDefault();
        void chooseFiles();
        return;
      }

      if (isCtrl && event.key === "Enter") {
        event.preventDefault();
        if (canConvert) {
          convertActiveMode();
        }
        return;
      }

      if (isCtrl && event.key === "r") {
        event.preventDefault();
        resetActiveMode();
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [canConvert, convertActiveMode, resetActiveMode]);

  const queueStatus = (file: CaptionFile): QueueStatus => {
    const result = resultByPath.get(file.path);
    if (result?.status) {
      return result.status;
    }

    return isConverting ? "queued" : "ready";
  };

  const trackStatus = (track: YouTubeCaptionTrack): QueueStatus => {
    if (isSavingYoutube && selectedTrackId === track.id) {
      return "queued";
    }

    if (youtubeResult && selectedTrackId === track.id) {
      return youtubeResult.status;
    }

    return "ready";
  };

  return (
    <main className="app-shell">
      {previewPath && (
        <VttPreviewModal filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}

      <section className="topbar">
        <div>
          <p className="eyebrow">Caption batch tool</p>
          <h1>SBV to VTT Converter</h1>
        </div>
        <div className="notice-pill" title={notice}>
          {isConverting || youtubeBusy ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice}</span>
        </div>
      </section>

      <section className="workspace">
        <aside className="control-panel">
          <div className="source-tabs" aria-label="Source mode">
            <button className={sourceMode === "files" ? "selected" : ""} onClick={() => setSourceMode("files")}>
              <FileText size={17} />
              <span>Files</span>
            </button>
            <button className={sourceMode === "youtube" ? "selected" : ""} onClick={() => setSourceMode("youtube")}>
              <Youtube size={17} />
              <span>YouTube</span>
            </button>
          </div>

          {sourceMode === "files" ? (
            <>
              <div className="panel-heading">
                <FileText size={20} />
                <h2>Source Files</h2>
              </div>

              <section
                className={`drop-zone ${isDragging ? "active" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
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
          ) : (
            <>
              <div className="panel-heading">
                <Youtube size={20} />
                <h2>YouTube</h2>
              </div>

              <label className="field">
                <span>Video ID or URL</span>
                <input
                  value={youtubeInput}
                  onChange={(event) => setYoutubeInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void fetchYouTubeCaptions();
                    }
                  }}
                  placeholder="dQw4w9WgXcQ"
                  disabled={youtubeBusy}
                />
              </label>

              <div className="button-row">
                <button className="primary-action" onClick={fetchYouTubeCaptions} disabled={!youtubeInput.trim() || youtubeBusy}>
                  {isFetchingCaptions ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                  <span>Find captions</span>
                </button>
                <button className="icon-button" onClick={resetYouTube} disabled={youtubeBusy} title="Reset YouTube input (Ctrl+R)">
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

          <div className="panel-heading settings-heading">
            <FolderOpen size={20} />
            <h2>Output</h2>
          </div>

          <button className="secondary-action" onClick={chooseOutputDirectory} title="Choose output folder">
            <FolderOpen size={18} />
            <span>{outputDir ? "Change folder" : "Choose folder"}</span>
          </button>

          <div className="path-readout" title={outputDir || defaultOutputLabel}>
            {outputDir || defaultOutputLabel}
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(event) => setOverwriteExisting(event.target.checked)}
              disabled={isConverting || youtubeBusy}
            />
            <span>Overwrite existing VTT files</span>
          </label>
        </aside>

        <section className="run-panel">
          <div className="run-header">
            <div>
              <p className="eyebrow">{sourceMode === "files" ? "Conversion Queue" : "Caption Tracks"}</p>
              <h2>
                {sourceMode === "files"
                  ? files.length
                    ? `${files.length} SBV file${files.length === 1 ? "" : "s"}`
                    : "Ready"
                  : youtubeData?.title ?? "Ready"}
              </h2>
            </div>
            <div className="run-actions">
              <button className="icon-button" onClick={resetActiveMode} disabled={isConverting || youtubeBusy} title="Reset (Ctrl+R)">
                <RotateCcw size={18} />
              </button>
              <button className="start-action" onClick={convertActiveMode} disabled={!canConvert} title="Convert to VTT (Ctrl+Enter)">
                {isConverting || isSavingYoutube ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                <span>Convert</span>
                <span className="kbd-hint">⌃↵</span>
              </button>
            </div>
          </div>

          <div className="stats-grid">
            {sourceMode === "files" ? (
              <>
                <div>
                  <span>Selected</span>
                  <strong>{files.length}</strong>
                </div>
                <div>
                  <span>Converted</span>
                  <strong>{convertedCount}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{failedCount}</strong>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span>Tracks</span>
                  <strong>{youtubeData?.tracks.length ?? 0}</strong>
                </div>
                <div>
                  <span>Selected</span>
                  <strong>{selectedTrack ? 1 : 0}</strong>
                </div>
                <div>
                  <span>Converted</span>
                  <strong>{youtubeResult?.status === "converted" ? 1 : 0}</strong>
                </div>
              </>
            )}
          </div>

          {/* Progress bar for batch conversion */}
          {sourceMode === "files" && (isConverting || conversionProgress > 0) && (
            <div className="progress-bar-track">
              <div
                className={`progress-bar-fill ${isConverting ? "active" : ""}`}
                style={{ width: `${isConverting ? 85 : conversionProgress * 100}%` }}
              />
            </div>
          )}

          {sourceMode === "files" ? (
            <div className="queue-list">
              {files.length === 0 ? (
                <div className="empty-state large">Add SBV files to begin.</div>
              ) : (
                files.map((file) => {
                  const result = resultByPath.get(file.path);
                  const status = queueStatus(file);
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
                          <button
                            className="icon-button"
                            onClick={() => setPreviewPath(outputPath)}
                            title="Preview VTT"
                          >
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
          ) : (
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
                        if (!youtubeBusy) {
                          if (selectedTrackId !== track.id) {
                            setSelectedTrackId(track.id);
                            setYoutubeResult(null);
                          }
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
                          {isSelected &&
                            youtubeResult?.status === "converted" &&
                            `${youtubeResult.cueCount ?? 0} cues written${
                              youtubeResult.bytesWritten ? `, ${formatBytes(youtubeResult.bytesWritten)}` : ""
                            }`}
                          {(!isSelected || !youtubeResult) &&
                            `${track.languageCode.toUpperCase()} · ${trackKindLabel(track)}${
                              track.isTranslatable ? " · Translatable" : ""
                            }`}
                        </p>
                        {outputPath && <small title={outputPath}>{outputPath}</small>}
                      </div>
                      {outputPath && (
                        <>
                          <button
                            className="icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPreviewPath(outputPath);
                            }}
                            title="Preview VTT"
                          >
                            <Eye size={18} />
                          </button>
                          <button
                            className="icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void converter.revealPath(outputPath);
                            }}
                            title="Reveal VTT file"
                          >
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
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
