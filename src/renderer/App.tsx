import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CaptionFile, ConversionResult } from "../shared/types";
import type { SbvConverterApi } from "../preload/preload";

type DropFile = File & {
  path?: string;
};

type QueueStatus = "ready" | "queued" | "converted" | "failed";

const converter: SbvConverterApi =
  window.sbvConverter ?? {
    chooseSbvFiles: async () => [],
    chooseOutputDirectory: async () => null,
    resolveSbvFiles: async () => [],
    convertSbvFiles: async () => {
      throw new Error("Open this screen in the Electron desktop app.");
    },
    revealPath: async () => undefined
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

function App() {
  const [files, setFiles] = useState<CaptionFile[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [results, setResults] = useState<ConversionResult[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState("Ready");

  const resultByPath = useMemo(() => new Map(results.map((result) => [result.sourcePath, result])), [results]);
  const convertedCount = results.filter((result) => result.status === "converted").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const canConvert = files.length > 0 && !isConverting;

  const addFiles = (incoming: CaptionFile[]) => {
    if (incoming.length === 0) {
      setNotice("No .sbv files found.");
      return;
    }

    setFiles((current) => mergeFiles(current, incoming));
    setResults([]);
    setNotice(`${incoming.length} file${incoming.length === 1 ? "" : "s"} added.`);
  };

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

  const reset = () => {
    if (isConverting) {
      return;
    }

    setFiles([]);
    setResults([]);
    setNotice("Ready");
  };

  const convertFiles = async () => {
    if (!canConvert) {
      return;
    }

    setIsConverting(true);
    setResults([]);
    setNotice("Converting...");

    try {
      const conversionResults = await converter.convertSbvFiles({
        filePaths: files.map((file) => file.path),
        outputDir: outputDir || undefined,
        overwriteExisting
      });

      setResults(conversionResults);
      const converted = conversionResults.filter((result) => result.status === "converted").length;
      const failed = conversionResults.length - converted;
      setNotice(failed ? `${converted} converted, ${failed} failed.` : `${converted} file${converted === 1 ? "" : "s"} converted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

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

  const queueStatus = (file: CaptionFile): QueueStatus => {
    const result = resultByPath.get(file.path);
    if (result?.status) {
      return result.status;
    }

    return isConverting ? "queued" : "ready";
  };

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Caption batch tool</p>
          <h1>SBV to VTT Converter</h1>
        </div>
        <div className="notice-pill" title={notice}>
          {isConverting ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice}</span>
        </div>
      </section>

      <section className="workspace">
        <aside className="control-panel">
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
            aria-label="Drop SBV files"
          >
            <Upload size={30} />
            <strong>Drop .sbv files</strong>
            <span>{files.length ? `${files.length} selected` : "No files selected"}</span>
          </section>

          <div className="button-row">
            <button className="primary-action" onClick={chooseFiles} title="Add SBV files">
              <Upload size={18} />
              <span>Add files</span>
            </button>
            <button className="icon-button" onClick={reset} disabled={isConverting} title="Reset list">
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

          <div className="panel-heading settings-heading">
            <FolderOpen size={20} />
            <h2>Output</h2>
          </div>

          <button className="secondary-action" onClick={chooseOutputDirectory} title="Choose output folder">
            <FolderOpen size={18} />
            <span>{outputDir ? "Change folder" : "Choose folder"}</span>
          </button>

          <div className="path-readout" title={outputDir || "Source folder"}>
            {outputDir || "Source folder"}
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(event) => setOverwriteExisting(event.target.checked)}
              disabled={isConverting}
            />
            <span>Overwrite existing VTT files</span>
          </label>
        </aside>

        <section className="run-panel">
          <div className="run-header">
            <div>
              <p className="eyebrow">Conversion Queue</p>
              <h2>{files.length ? `${files.length} SBV file${files.length === 1 ? "" : "s"}` : "Ready"}</h2>
            </div>
            <button className="start-action" onClick={convertFiles} disabled={!canConvert} title="Convert to VTT">
              {isConverting ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              <span>Convert</span>
            </button>
          </div>

          <div className="stats-grid">
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
          </div>

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
                      <button className="icon-button" onClick={() => converter.revealPath(outputPath)} title="Reveal VTT file">
                        <ExternalLink size={18} />
                      </button>
                    )}
                    {status === "failed" && <AlertCircle className="row-alert" size={18} />}
                  </article>
                );
              })
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
