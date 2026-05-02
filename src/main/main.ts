import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { convertSbvToVtt } from "../shared/sbv";
import type { CaptionFile, ConversionRequest, ConversionResult } from "../shared/types";

let mainWindow: BrowserWindow | null = null;

const supportedCaptionExtensions = new Set([".sbv"]);

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
    backgroundColor: "#f7f7f2",
    title: "SBV to VTT Converter",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath()
    }
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

function resolveCaptionFiles(filePaths: string[]) {
  const seen = new Set<string>();
  const files: CaptionFile[] = [];

  filePaths.forEach((filePath) => {
    if (!filePath || seen.has(filePath) || !isSbvFile(filePath) || !fs.existsSync(filePath)) {
      return;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
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

function createUniqueOutputPath(sourcePath: string, outputDir: string | undefined, usedPaths: Set<string>, overwriteExisting: boolean) {
  const targetDir = outputDir?.trim() ? outputDir : path.dirname(sourcePath);
  const stem = sanitizeFileStem(sourcePath);
  const basePath = path.join(targetDir, `${stem}.vtt`);

  if (overwriteExisting) {
    let candidate = basePath;
    let counter = 2;

    while (usedPaths.has(candidate.toLowerCase())) {
      candidate = path.join(targetDir, `${stem} (${counter}).vtt`);
      counter += 1;
    }

    usedPaths.add(candidate.toLowerCase());
    return candidate;
  }

  let candidate = basePath;
  let counter = 2;

  while (usedPaths.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${stem} (${counter}).vtt`);
    counter += 1;
  }

  usedPaths.add(candidate.toLowerCase());
  return candidate;
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

ipcMain.handle("dialog:choose-sbv", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose SBV caption files",
    properties: ["openFile", "multiSelections"],
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

ipcMain.handle("shell:reveal-path", async (_, targetPath: string) => {
  if (targetPath) {
    shell.showItemInFolder(targetPath);
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
