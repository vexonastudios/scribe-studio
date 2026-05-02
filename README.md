# SBV to VTT Converter

A local Electron app for batch converting YouTube `.sbv` caption files into WebVTT `.vtt` files.

## Setup

Install dependencies:

```powershell
npm install
```

Start the desktop app:

```powershell
npm run dev
```

Build the app assets:

```powershell
npm run build
```

## Usage

- Add one or more `.sbv` files with the file picker or by dragging them into the app.
- Choose an output folder, or leave it blank to save each `.vtt` beside its source file.
- Keep overwrite disabled to automatically create names like `captions (2).vtt` when a file already exists.

The converter rewrites SBV timing lines such as:

```text
0:00:01.840,0:00:08.960
```

as WebVTT cues:

```text
00:00:01.840 --> 00:00:08.960
```
