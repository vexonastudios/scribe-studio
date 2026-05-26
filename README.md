# SBV to VTT Converter

A local Electron app for batch converting YouTube `.sbv` caption files into WebVTT `.vtt` files. It can also fetch public caption tracks from a YouTube video ID or URL and save the selected track as VTT.

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

## GPU-Accelerated Transcription Engine

The app includes a local Whisper-based transcription engine optimized for **NVIDIA RTX GPUs**. To set up the Python engine:

```powershell
.\scripts\setup-engine.ps1
```

### GPU Configuration

The engine **auto-detects** your GPU at startup. On a machine with an RTX 5090 (or any CUDA-capable GPU), it will automatically use:

| Setting | Default | Notes |
|---------|---------|-------|
| Device | `auto` | Detects CUDA GPU, falls back to CPU |
| Compute Type | `auto` | `float16` on GPU, `int8` on CPU |
| Model | `medium` | Excellent quality/speed balance on RTX |
| Batch Size | `24` | Optimized for high-VRAM GPUs |
| Beam Size | `5` | Better accuracy with GPU headroom |

To override defaults, pass CLI flags:

```powershell
python engine/transcribe.py audio.mp3 --output out.vtt --device cuda --compute-type float16 --model large-v3
```

For CPU-only machines:

```powershell
python engine/transcribe.py audio.mp3 --output out.vtt --device cpu --compute-type int8 --model small
```

## Usage

- Add one or more `.sbv` files with the file picker or by dragging them into the app.
- You can also **drag entire folders** — the app will recursively find `.sbv` files inside.
- Choose an output folder, or leave it blank to save each `.vtt` beside its source file.
- Keep overwrite disabled to automatically create names like `captions (2).vtt` when a file already exists.
- **Preview** converted VTT files directly in the app by clicking the eye icon.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Add files |
| `Ctrl+Enter` | Convert |
| `Ctrl+R` | Reset |
| `Esc` | Close preview |

## YouTube Captions

- Switch to the YouTube source tab.
- Paste a video ID or URL.
- Find captions, select a public caption track, then convert it.
- Choose an output folder, or leave it blank to save YouTube downloads to your Downloads folder.

This uses public caption tracks exposed on the YouTube video page. Videos without accessible captions, private videos, members-only videos, or age-restricted videos may not work without manual downloads or account access.

The converter rewrites SBV timing lines such as:

```text
0:00:01.840,0:00:08.960
```

as WebVTT cues:

```text
00:00:01.840 --> 00:00:08.960
```
