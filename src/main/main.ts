import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { convertSbvToVtt } from "../shared/sbv";
import type {
  CaptionFile,
  ConversionRequest,
  ConversionResult,
  YouTubeCaptionConversionRequest,
  YouTubeCaptionConversionResult,
  YouTubeCaptionTrack,
  YouTubeCaptionTracksResult
} from "../shared/types";

let mainWindow: BrowserWindow | null = null;

const supportedCaptionExtensions = new Set([".sbv"]);
const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;

function appRoot() {
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function preloadPath() {
  return path.join(appRoot(), "dist", "preload", "preload.js");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0b0e14",
    title: "SBV to VTT Converter",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath()
    }
  });

  // Security: set Content-Security-Policy
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

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(appRoot(), "dist", "renderer", "index.html"));
  } else {
    mainWindow.loadURL("http://127.0.0.1:5173");
    if (process.env.OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }
}

function isSbvFile(filePath: string) {
  return supportedCaptionExtensions.has(path.extname(filePath).toLowerCase());
}

function fileToCaptionFile(filePath: string): CaptionFile {
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

    // Support dropping directories — recursively find .sbv files inside
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

ipcMain.handle("youtube:fetch-captions", async (_, videoInput: string) => fetchYouTubeCaptionTracks(videoInput));

ipcMain.handle(
  "youtube:convert-caption",
  async (_, request: YouTubeCaptionConversionRequest): Promise<YouTubeCaptionConversionResult> =>
    convertYouTubeCaption(request)
);

ipcMain.handle("shell:reveal-path", async (_, targetPath: string) => {
  if (targetPath) {
    shell.showItemInFolder(targetPath);
  }
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
