import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, net, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { convertSbvToVtt } from "../shared/sbv";
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
  YouTubeCaptionTrack,
  YouTubeCaptionTracksResult
} from "../shared/types";

let mainWindow: BrowserWindow | null = null;

// ── Fix userData path before app is ready ─────────────────────────────────────
// Electron derives userData from package.json "name" ("scribe-studio"), giving
// %APPDATA%\scribe-studio — but setup-engine.ps1 writes the .venv to
// %APPDATA%\Scribe Studio. Override here so both sides agree on the same path.
app.setPath("userData", path.join(app.getPath("appData"), "Scribe Studio"));

// Last known VRAM from GPU probe — used to pick optimal batch size
let lastKnownVramGb: number | null = null;

const supportedCaptionExtensions = new Set([".sbv"]);
const supportedAudioExtensions = new Set([".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".opus", ".wma"]);
const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;

// ── Active transcription process ─────────────────────────────────────────────
let activeTranscribeProcess: ChildProcess | null = null;

// ── Path helpers ─────────────────────────────────────────────────────────────
//
// THREE distinct roots — mixing them up is what caused the blank-screen bug:
//
//  appRoot()       →  dist/ files (inside app.asar)  → app.getAppPath()
//  resourcesRoot() →  engine/, scripts/ (extraResources, outside asar) → process.resourcesPath
//  userDataRoot()  →  .venv, models (writable; Program Files is read-only) → app.getPath("userData")

function appRoot(): string {
  // Packed: app.getAppPath() = .../resources/app.asar  (Electron handles asar transparently)
  // Dev:    process.cwd()   = project root
  return app.isPackaged ? app.getAppPath() : process.cwd();
}

function resourcesRoot(): string {
  // extraResources (engine/, scripts/) land beside app.asar in resources/
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function userDataRoot(): string {
  // Always writable — %APPDATA%\Scribe Studio
  // Used for .venv and whisper model cache
  return app.getPath("userData");
}

function preloadPath(): string {
  return path.join(appRoot(), "dist", "preload", "preload.js");
}

function venvPythonPath(): string {
  const root = userDataRoot();
  return process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
}

function transcribeScriptPath(): string {
  return path.join(resourcesRoot(), "engine", "transcribe.py");
}

function setupScriptPath(): string {
  return path.join(resourcesRoot(), "scripts", "setup-engine.ps1");
}

function isEngineReady(): boolean {
  return fs.existsSync(venvPythonPath()) && fs.existsSync(transcribeScriptPath());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: "#0b0e14",
    title: "Scribe Studio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath()
    }
  });

  // Security: set Content-Security-Policy (production only — CSP blocks Vite HMR in dev)
  if (app.isPackaged) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://www.youtube.com https://*.youtube.com; img-src 'self' data:"
          ]
        }
      });
    });
  }

  if (app.isPackaged) {
    mainWindow.loadURL("app://./index.html");
  } else {
    mainWindow.loadURL("http://127.0.0.1:5173");
    if (process.env.OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }

  // ── Auto-update (production only) ───────────────────────────────────────────
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update:available", info.version);
      }
    });

    autoUpdater.on("update-downloaded", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update:downloaded");
      }
    });

    autoUpdater.on("error", (err) => {
      console.error("[auto-updater]", err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update:error", err.message);
      }
    });

    // Check immediately, then every 4 hours
    void autoUpdater.checkForUpdates();
    setInterval(() => { void autoUpdater.checkForUpdates(); }, 4 * 60 * 60 * 1000);
  }
}

// ── Caption file helpers ──────────────────────────────────────────────────────

function isSbvFile(filePath: string) {
  return supportedCaptionExtensions.has(path.extname(filePath).toLowerCase());
}

function isAudioFile(filePath: string) {
  return supportedAudioExtensions.has(path.extname(filePath).toLowerCase());
}

function fileToCaptionFile(filePath: string): CaptionFile {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size
  };
}

function fileToAudioFile(filePath: string): AudioFile {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size
  };
}

/** Recursively collect .sbv files from a directory. */
function collectSbvFromDir(dirPath: string, maxDepth: number = 5): string[] {
  if (maxDepth <= 0) {
    return [];
  }

  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && isSbvFile(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(...collectSbvFromDir(fullPath, maxDepth - 1));
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return results;
}

/** Recursively collect audio files from a directory. */
function collectAudioFromDir(dirPath: string, maxDepth: number = 5): string[] {
  if (maxDepth <= 0) {
    return [];
  }

  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && isAudioFile(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(...collectAudioFromDir(fullPath, maxDepth - 1));
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return results;
}

function resolveCaptionFiles(filePaths: string[]) {
  const seen = new Set<string>();
  const files: CaptionFile[] = [];

  filePaths.forEach((filePath) => {
    if (!filePath || seen.has(filePath)) {
      return;
    }

    if (!fs.existsSync(filePath)) {
      return;
    }

    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      const dirFiles = collectSbvFromDir(filePath);
      dirFiles.forEach((dirFile) => {
        if (!seen.has(dirFile)) {
          seen.add(dirFile);
          files.push(fileToCaptionFile(dirFile));
        }
      });
      return;
    }

    if (!stat.isFile() || !isSbvFile(filePath)) {
      return;
    }

    seen.add(filePath);
    files.push(fileToCaptionFile(filePath));
  });

  return files;
}

function resolveAudioFiles(filePaths: string[]) {
  const seen = new Set<string>();
  const files: AudioFile[] = [];

  filePaths.forEach((filePath) => {
    if (!filePath || seen.has(filePath)) {
      return;
    }

    if (!fs.existsSync(filePath)) {
      return;
    }

    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      const dirFiles = collectAudioFromDir(filePath);
      dirFiles.forEach((dirFile) => {
        if (!seen.has(dirFile)) {
          seen.add(dirFile);
          files.push(fileToAudioFile(dirFile));
        }
      });
      return;
    }

    if (!stat.isFile() || !isAudioFile(filePath)) {
      return;
    }

    seen.add(filePath);
    files.push(fileToAudioFile(filePath));
  });

  return files;
}

function sanitizeFileStem(filePath: string) {
  const parsed = path.parse(filePath);
  const safeStem = parsed.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim();
  return safeStem || "captions";
}

function sanitizeName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
}

function createUniqueVttPath(targetDir: string, stem: string, usedPaths: Set<string>, overwriteExisting: boolean) {
  const safeStem = sanitizeName(stem) || "captions";
  const basePath = path.join(targetDir, `${safeStem}.vtt`);

  if (overwriteExisting) {
    let candidate = basePath;
    let counter = 2;

    while (usedPaths.has(candidate.toLowerCase())) {
      candidate = path.join(targetDir, `${safeStem} (${counter}).vtt`);
      counter += 1;
    }

    usedPaths.add(candidate.toLowerCase());
    return candidate;
  }

  let candidate = basePath;
  let counter = 2;

  while (usedPaths.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${safeStem} (${counter}).vtt`);
    counter += 1;
  }

  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

function createUniqueOutputPath(sourcePath: string, outputDir: string | undefined, usedPaths: Set<string>, overwriteExisting: boolean) {
  const targetDir = outputDir?.trim() ? outputDir : path.dirname(sourcePath);
  return createUniqueVttPath(targetDir, sanitizeFileStem(sourcePath), usedPaths, overwriteExisting);
}

function convertFile(filePath: string, outputPath: string): Omit<ConversionResult, "sourcePath" | "sourceName" | "status"> {
  const input = fs.readFileSync(filePath, "utf8");
  const converted = convertSbvToVtt(input);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, converted.vtt, "utf8");

  return {
    outputPath,
    cueCount: converted.cueCount,
    bytesWritten: Buffer.byteLength(converted.vtt, "utf8"),
    message: `Converted ${converted.cueCount} cues.`
  };
}

// ── YouTube helpers ───────────────────────────────────────────────────────────

function parseYouTubeVideoId(videoInput: string) {
  const trimmed = videoInput.trim();

  if (youtubeIdPattern.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && youtubeIdPattern.test(id) ? id : null;
    }

    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId && youtubeIdPattern.test(watchId)) {
        return watchId;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const embeddedId = parts.find((part, index) => ["embed", "shorts", "live"].includes(parts[index - 1]));
      return embeddedId && youtubeIdPattern.test(embeddedId) ? embeddedId : null;
    }
  } catch {
    return null;
  }

  return null;
}

function extractJsonObjectAfter(html: string, marker: string) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const start = html.indexOf("{", markerIndex);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, index + 1);
      }
    }
  }

  return null;
}

function textFromYouTubeRuns(value: unknown) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const maybeText = value as { simpleText?: string; runs?: Array<{ text?: string }> };

  if (typeof maybeText.simpleText === "string") {
    return maybeText.simpleText;
  }

  if (Array.isArray(maybeText.runs)) {
    return maybeText.runs.map((run) => run.text ?? "").join("");
  }

  return "";
}

function buildSbvCaptionUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "sbv");
  return url.toString();
}

function createYouTubeOutputStem(title: string, videoId: string, track: YouTubeCaptionTrack) {
  const titlePart = sanitizeName(title) || `youtube-${videoId}`;
  const languagePart = sanitizeName(track.languageCode || track.label || "captions");
  const kindPart = track.kind === "auto" ? "auto" : "captions";
  return `${titlePart} - ${languagePart}-${kindPart}`;
}

async function fetchYouTubeCaptionTracks(videoInput: string): Promise<YouTubeCaptionTracksResult> {
  const videoId = parseYouTubeVideoId(videoInput);

  if (!videoId) {
    throw new Error("Enter a valid YouTube video ID or URL.");
  }

  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status} while loading the video page.`);
  }

  const html = await response.text();
  const playerJson = extractJsonObjectAfter(html, "ytInitialPlayerResponse");

  if (!playerJson) {
    throw new Error("Could not find YouTube player data for that video.");
  }

  const playerResponse = JSON.parse(playerJson) as {
    videoDetails?: { title?: string };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          baseUrl?: string;
          languageCode?: string;
          name?: unknown;
          kind?: string;
          vssId?: string;
          isTranslatable?: boolean;
        }>;
      };
    };
  };
  const title = playerResponse.videoDetails?.title || `YouTube ${videoId}`;
  const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const tracks = captionTracks
    .filter((track) => track.baseUrl && track.languageCode)
    .map((track, index): YouTubeCaptionTrack => {
      const kind = track.kind === "asr" ? "auto" : "manual";
      const label = textFromYouTubeRuns(track.name) || track.languageCode || `Track ${index + 1}`;

      return {
        id: `${track.languageCode}-${kind}-${index}`,
        label,
        languageCode: track.languageCode as string,
        kind,
        isTranslatable: Boolean(track.isTranslatable),
        baseUrl: track.baseUrl as string
      };
    });

  if (tracks.length === 0) {
    throw new Error("No public caption tracks were found for that video.");
  }

  return {
    videoId,
    title,
    tracks
  };
}

async function convertYouTubeCaption(request: YouTubeCaptionConversionRequest): Promise<YouTubeCaptionConversionResult> {
  const videoId = parseYouTubeVideoId(request.videoInput);

  if (!videoId) {
    throw new Error("Enter a valid YouTube video ID or URL.");
  }

  const tracksResult = await fetchYouTubeCaptionTracks(videoId);
  const matchingTrack =
    tracksResult.tracks.find((track) => track.id === request.track.id) ??
    tracksResult.tracks.find(
      (track) => track.languageCode === request.track.languageCode && track.kind === request.track.kind
    ) ??
    request.track;

  try {
    const response = await fetch(buildSbvCaptionUrl(matchingTrack.baseUrl), {
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error(`YouTube returned ${response.status} while downloading captions.`);
    }

    const sbv = await response.text();
    const converted = convertSbvToVtt(sbv);
    const outputDir = request.outputDir?.trim() || app.getPath("downloads");
    const outputPath = createUniqueVttPath(
      outputDir,
      createYouTubeOutputStem(tracksResult.title, videoId, matchingTrack),
      new Set<string>(),
      request.overwriteExisting
    );

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, converted.vtt, "utf8");

    return {
      videoId,
      title: tracksResult.title,
      trackLabel: matchingTrack.label,
      languageCode: matchingTrack.languageCode,
      status: "converted",
      outputPath,
      cueCount: converted.cueCount,
      bytesWritten: Buffer.byteLength(converted.vtt, "utf8"),
      message: `Converted ${converted.cueCount} cues.`
    };
  } catch (error) {
    return {
      videoId,
      title: tracksResult.title,
      trackLabel: matchingTrack.label,
      languageCode: matchingTrack.languageCode,
      status: "failed",
      message: error instanceof Error ? error.message : "Caption download failed."
    };
  }
}

// ── Transcription helpers ─────────────────────────────────────────────────────

function sendTranscribeEvent(event: TranscribeEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("transcribe:event", event);
  }
}

function killActiveProcess() {
  if (activeTranscribeProcess) {
    transcribeCancelled = true;
    try {
      activeTranscribeProcess.kill("SIGTERM");
    } catch {
      // already dead
    }
    activeTranscribeProcess = null;
  }
}

// Explicit cancellation flag so the batch stops cleanly after the current file
let transcribeCancelled = false;

async function runTranscription(request: TranscribeRequest): Promise<void> {
  killActiveProcess();
  transcribeCancelled = false;

  const pythonExe = venvPythonPath();
  const scriptPath = transcribeScriptPath();

  if (!fs.existsSync(pythonExe)) {
    sendTranscribeEvent({
      type: "error",
      message: `Python engine not found. Run the setup script first.\nExpected: ${pythonExe}`
    });
    return;
  }

  if (!fs.existsSync(scriptPath)) {
    sendTranscribeEvent({
      type: "error",
      message: `Transcription script not found: ${scriptPath}`
    });
    return;
  }

  // Build jobs list — outputPaths is a parallel array supplied by the renderer
  const jobs = request.filePaths
    .map((filePath, i) => ({
      input: filePath,
      output: request.outputPaths[i] ?? ""
    }))
    .filter((job) => {
      if (!fs.existsSync(job.input)) {
        sendTranscribeEvent({ type: "error", message: `Audio file not found: ${job.input}` });
        return false;
      }
      if (!job.output) {
        sendTranscribeEvent({ type: "error", message: `No output path for: ${job.input}` });
        return false;
      }
      fs.mkdirSync(path.dirname(job.output), { recursive: true });
      return true;
    });

  if (jobs.length === 0) return;

  // Write a temp jobs file so all files are processed in ONE Python session (one model load)
  const jobsFile = path.join(app.getPath("temp"), `vtt-jobs-${Date.now()}.json`);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs), "utf8");

  const modelsDir = path.join(userDataRoot(), "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  const args = [
    scriptPath,
    "--jobs-file", jobsFile,
    "--model", request.model,
    "--model-dir", modelsDir,
    "--device", "auto",
    "--compute-type", "auto",
    // Scale batch size to available VRAM: 32 for 16+ GB, 16 for 8-16 GB, 8 for 4-8 GB, 4 for <4 GB
    "--batch-size", String(
      !lastKnownVramGb || lastKnownVramGb < 4  ? 4  :
      lastKnownVramGb  < 8                     ? 8  :
      lastKnownVramGb  < 16                    ? 16 : 32
    ),
    "--max-cue-chars", String(request.maxCueChars),
    "--max-cue-duration", String(request.maxCueDuration),
  ];

  if (request.wordTimestamps) {
    args.push("--word-timestamps");
  } else {
    args.push("--no-word-timestamps");
  }

  if (request.language?.trim()) args.push("--language", request.language.trim());
  if (request.initialPrompt?.trim()) args.push("--initial-prompt", request.initialPrompt.trim());

  try {
    await new Promise<void>((resolve) => {
      const proc = spawn(pythonExe, args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      });

      activeTranscribeProcess = proc;
      let lineBuffer = "";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as TranscribeEvent;
          sendTranscribeEvent(event);
        } catch {
          sendTranscribeEvent({ type: "log", message: trimmed });
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        lines.forEach(handleLine);
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        // Filter out normal faster-whisper/PyTorch noise
        if (text && !text.includes("UserWarning") && !text.includes("FutureWarning")) {
          sendTranscribeEvent({ type: "log", message: `[stderr] ${text}` });
        }
      });

      proc.on("close", (code) => {
        if (lineBuffer.trim()) handleLine(lineBuffer);
        activeTranscribeProcess = null;

        if (code !== 0 && code !== 130 && !transcribeCancelled) {
          sendTranscribeEvent({
            type: "error",
            message: `Engine exited unexpectedly (code ${code}). Check the log panel for details.`
          });
        }
        resolve();
      });
    });
  } finally {
    // Always clean up the temp jobs file, even if spawn or the Promise threw
    try { fs.unlinkSync(jobsFile); } catch { /* already gone */ }
  }
}

async function getGpuInfo(): Promise<GpuInfo> {
  const pythonExe = venvPythonPath();

  if (!fs.existsSync(pythonExe)) {
    return { gpuName: null, vramGb: null, device: "cpu" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (info: GpuInfo) => {
      if (settled) return;
      settled = true;
      lastKnownVramGb = info.vramGb;
      resolve(info);
    };

    const script = [
      "import json, sys",
      "try:",
      "    import torch",
      "    if torch.cuda.is_available():",
      "        name = torch.cuda.get_device_name(0)",
      "        vram = torch.cuda.get_device_properties(0).total_mem / (1024**3)",
      "        print(json.dumps({'gpuName': name, 'vramGb': round(vram, 1), 'device': 'cuda'}))",
      "    else:",
      "        print(json.dumps({'gpuName': None, 'vramGb': None, 'device': 'cpu'}))",
      "except Exception as e:",
      "    print(json.dumps({'gpuName': None, 'vramGb': None, 'device': 'cpu'}))"
    ].join("\n");

    const proc = spawn(pythonExe, ["-c", script], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "ignore"]
    });

    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    proc.on("close", () => {
      try {
        settle(JSON.parse(output.trim()) as GpuInfo);
      } catch {
        settle({ gpuName: null, vramGb: null, device: "cpu" });
      }
    });

    setTimeout(() => {
      try { proc.kill(); } catch { /* already dead */ }
      settle({ gpuName: null, vramGb: null, device: "cpu" });
    }, 15000);
  });
}

// ── IPC Handlers — SBV / Caption files ───────────────────────────────────────

ipcMain.handle("dialog:choose-sbv", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose SBV caption files or folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "SBV Captions", extensions: ["sbv"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });

  return result.canceled ? [] : resolveCaptionFiles(result.filePaths);
});

ipcMain.handle("files:resolve-sbv", async (_, filePaths: string[]) => resolveCaptionFiles(filePaths));

ipcMain.handle("dialog:choose-output-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose VTT output folder",
    properties: ["openDirectory", "createDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("conversion:convert-sbv", async (_, request: ConversionRequest): Promise<ConversionResult[]> => {
  const usedOutputPaths = new Set<string>();

  return request.filePaths.map((filePath) => {
    const sourceName = path.basename(filePath);

    try {
      if (!isSbvFile(filePath)) {
        throw new Error("Only .sbv files can be converted.");
      }

      if (!fs.existsSync(filePath)) {
        throw new Error("Source file does not exist.");
      }

      const outputPath = createUniqueOutputPath(
        filePath,
        request.outputDir,
        usedOutputPaths,
        request.overwriteExisting
      );
      const conversion = convertFile(filePath, outputPath);

      return {
        sourcePath: filePath,
        sourceName,
        status: "converted",
        ...conversion
      };
    } catch (error) {
      return {
        sourcePath: filePath,
        sourceName,
        status: "failed",
        message: error instanceof Error ? error.message : "Conversion failed."
      };
    }
  });
});

// ── IPC Handlers — YouTube ────────────────────────────────────────────────────

ipcMain.handle("youtube:fetch-captions", async (_, videoInput: string) => fetchYouTubeCaptionTracks(videoInput));

ipcMain.handle(
  "youtube:convert-caption",
  async (_, request: YouTubeCaptionConversionRequest): Promise<YouTubeCaptionConversionResult> =>
    convertYouTubeCaption(request)
);

// ── IPC Handlers — Audio / Transcription ─────────────────────────────────────

ipcMain.handle("dialog:choose-audio", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose audio files or folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "Audio Files", extensions: ["mp3", "m4a", "wav", "flac", "ogg", "aac", "opus", "wma"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });

  return result.canceled ? [] : resolveAudioFiles(result.filePaths);
});

ipcMain.handle("files:resolve-audio", async (_, filePaths: string[]) => resolveAudioFiles(filePaths));

ipcMain.handle("transcribe:start", async (_, request: TranscribeRequest) => {
  // Fire and forget — progress comes via "transcribe:event" push events
  void runTranscription(request);
});

ipcMain.handle("transcribe:cancel", async () => {
  killActiveProcess();
  sendTranscribeEvent({ type: "cancelled", message: "Transcription cancelled." });
});

ipcMain.handle("transcribe:get-gpu-info", async (): Promise<GpuInfo> => getGpuInfo());

// ── IPC Handlers — Utilities ──────────────────────────────────────────────────

ipcMain.handle("shell:reveal-path", async (_, targetPath: string) => {
  if (targetPath) shell.showItemInFolder(targetPath);
});

ipcMain.handle("shell:open-folder", async (_, folderPath: string) => {
  if (folderPath) await shell.openPath(folderPath);
});

/** Read a VTT file's content for preview in the renderer. */
ipcMain.handle("files:read-vtt", async (_, filePath: string): Promise<string | null> => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const stat = fs.statSync(filePath);

    // Don't read files larger than 2MB to prevent memory issues
    if (stat.size > 2 * 1024 * 1024) {
      return "// File too large to preview (> 2 MB)";
    }

    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
});

// ── Engine setup IPC ──────────────────────────────────────────────────────────

ipcMain.handle("engine:check", () => ({
  ready: isEngineReady(),
  pythonPath: venvPythonPath(),
  scriptPath: transcribeScriptPath(),
}));

ipcMain.handle("engine:setup", async () => {
  const ps1 = setupScriptPath();
  if (!fs.existsSync(ps1)) {
    return { success: false, error: `Setup script not found: ${ps1}` };
  }

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    // Run setup-engine.ps1, passing installDir so the venv lands beside the exe
    const proc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", ps1
    ], {
      cwd: userDataRoot(),   // .venv is created in userData (always writable)
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const send = (line: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("engine:setup-log", line);
      }
    };

    let buf = "";
    const flush = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lines.forEach((l) => l.trim() && send(l));
    };

    proc.stdout?.on("data", flush);
    proc.stderr?.on("data", flush);

    proc.on("close", (code) => {
      if (buf.trim()) send(buf);
      if (code === 0) {
        send("✅ Engine setup complete!");
        resolve({ success: true });
      } else {
        send(`❌ Setup failed (exit code ${code})`);
        resolve({ success: false, error: `Exit code ${code}` });
      }
    });
  });
});

// ── IPC Handlers — Updates ────────────────────────────────────────────────────

ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());

ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) {
    return { message: "Auto-update only works in the packaged app." };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return { message: "Already on the latest version." };
    return { message: `Checking for updates… current: ${app.getVersion()}` };
  } catch (err) {
    return { message: `Update check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
});

// ── Native application menu ───────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === "darwin";
  const version = app.getVersion();

  const template: (Electron.MenuItemConstructorOptions | MenuItem)[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" as const },
    { role: "editMenu" as const },
    {
      label: "Help",
      submenu: [
        {
          label: `Scribe Studio v${version}`,
          enabled: false,
        },
        { type: "separator" as const },
        {
          label: "Check for Updates…",
          click: async () => {
            if (!app.isPackaged) {
              dialog.showMessageBox({ message: "Auto-update only works in the packaged app.", type: "info" });
              return;
            }
            try {
              const result = await autoUpdater.checkForUpdates();
              if (!result) {
                dialog.showMessageBox({
                  type: "info",
                  title: "No Updates",
                  message: `Scribe Studio v${version} is the latest version.`,
                });
              }
            } catch (err) {
              dialog.showErrorBox(
                "Update Check Failed",
                err instanceof Error ? err.message : String(err)
              );
            }
          },
        },
        { type: "separator" as const },
        {
          label: "Open App Data Folder",
          click: () => shell.openPath(userDataRoot()),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Register app:// scheme BEFORE app is ready (Electron requirement)
// This lets the packaged renderer load its assets via a stable custom protocol
// instead of file://, which doesn't resolve asar sub-resources reliably.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
]);

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (app.isPackaged) {
    // Serve all renderer assets from inside the asar via app://
    // URL pattern: app://./index.html  →  app.asar/dist/renderer/index.html
    //              app://./assets/x.js →  app.asar/dist/renderer/assets/x.js
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const rel = pathname.replace(/^\//, ""); // strip leading /
      const rendererBase = path.resolve(path.join(appRoot(), "dist", "renderer"));
      const filePath = path.resolve(path.join(rendererBase, rel));
      // Guard against path traversal (app://./../../../sensitive-file)
      if (!filePath.startsWith(rendererBase + path.sep) && filePath !== rendererBase) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(`file://${filePath}`);
    });
  }

  createWindow();
  buildMenu();
});

app.on("window-all-closed", () => {
  killActiveProcess();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
