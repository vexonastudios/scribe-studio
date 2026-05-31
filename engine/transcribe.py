from __future__ import annotations

import io
import sys

# Force UTF-8 on stdout/stderr regardless of the Windows console code page.
# Without this, printing JSON that contains non-Latin characters (e.g. curly
# quotes, Greek letters, etc.) raises a UnicodeEncodeError on cp1252 systems.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import argparse
import html
import json
import math
import os
import re
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

# Suppress HuggingFace Hub authentication nag and tokenizer parallelism warning.
# faster-whisper downloads models from the Hub; without a token it prints a
# rate-limit notice on every run. Setting verbosity to 'error' silences it.
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


@dataclass
class Cue:
    start: float
    end: float
    text: str


def emit(event_type: str, **payload: object) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def compact_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("-->", "->")).strip()


def clean_text(text: str) -> str:
    return html.escape(compact_text(text), quote=False)


# ── Capitalization post-processor ────────────────────────────────────────────
# Whisper often outputs lowercase 'i', fails to capitalize after sentence
# endings, and lowercases sacred proper nouns. Fix these before writing VTT.

# Word/phrase substitutions — applied as whole-word replacements (case-insensitive)
# ordered longest-first so "holy spirit" is matched before "spirit".
_PROPER_NOUNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'\bholy spirit\b', re.IGNORECASE), 'Holy Spirit'),
    (re.compile(r'\bgod\b',         re.IGNORECASE), 'God'),
    (re.compile(r'\blord\b',        re.IGNORECASE), 'Lord'),
    (re.compile(r'\bjesus\b',       re.IGNORECASE), 'Jesus'),
    (re.compile(r'\bchrist\b',      re.IGNORECASE), 'Christ'),
    (re.compile(r'\bbible\b',       re.IGNORECASE), 'Bible'),
    (re.compile(r'\bscriptures?\b', re.IGNORECASE), lambda m: 'Scriptures' if m.group().lower().endswith('s') else 'Scripture'),
    (re.compile(r'\bsatan\b',       re.IGNORECASE), 'Satan'),
]

# ── Speech-quote detector ─────────────────────────────────────────────────────
# Matches patterns like:  He said, This is the truth.
#                         Paul wrote, I can do all things.
#                         Jesus declared, I am the way.
# and wraps the quoted portion in curly/straight double-quotes.
# Only fires when the quote candidate starts with a capital and ends with
# sentence-ending punctuation — avoids false positives on mid-sentence commas.
_SPEECH_QUOTE_RE = re.compile(
    r''
    r'(\b(?:said|says|wrote|declared|replied|answered|asked|cried|exclaimed|'
    r'proclaimed|commanded|stated|read(?:s|ing)?|quot(?:e[sd]?|ing)|speaks?|spoke)\b'
    r'(?:[^,]{0,25}),\s+)'   # verb + optional filler + comma + space
    r'([A-Z][^"\u201c\u201d]{3,}?[.!?])'  # quoted content: capital → sentence end
    r'(?=[^a-z]|$)',          # not followed by a lowercase continuation
    re.IGNORECASE,
)


def add_speech_quotes(text: str) -> str:
    """Wrap text following speech-verb+comma patterns in double-quotation marks."""
    # Skip if the cue already contains quotes.
    if '"' in text or '\u201c' in text or '\u201d' in text:
        return text

    def _wrap(m: re.Match) -> str:
        return f'{m.group(1)}\u201c{m.group(2).strip()}\u201d'

    return _SPEECH_QUOTE_RE.sub(_wrap, text)


def fix_cue_text(text: str) -> str:
    """Apply capitalization and quote corrections to a single cue's text."""
    if not text:
        return text

    # 1. Capitalize standalone 'i' → 'I'
    text = re.sub(r'(?<![\w])i(?![\w])', 'I', text)

    # 2. Capitalize first letter after sentence-ending punctuation (. ! ?)
    #    followed by a space and a lowercase letter.
    text = re.sub(
        r'([.!?][\u2019\'"\)\]]*)(\s+)([a-z])',
        lambda m: m.group(1) + m.group(2) + m.group(3).upper(),
        text
    )

    # 3. Capitalize the very first character of the cue.
    if text and text[0].islower():
        text = text[0].upper() + text[1:]

    # 4. Replace known proper nouns / sacred names.
    for pattern, replacement in _PROPER_NOUNS:
        text = pattern.sub(replacement, text)

    # 5. Add quotation marks around speech after verbs like 'said,', 'wrote,' etc.
    text = add_speech_quotes(text)

    return text


def format_timestamp(seconds: float) -> str:
    safe_seconds = max(0.0, seconds)
    hours = int(safe_seconds // 3600)
    minutes = int((safe_seconds % 3600) // 60)
    whole_seconds = int(safe_seconds % 60)
    milliseconds = int(round((safe_seconds - math.floor(safe_seconds)) * 1000))

    if milliseconds == 1000:
        milliseconds = 0
        whole_seconds += 1
    if whole_seconds == 60:
        whole_seconds = 0
        minutes += 1
    if minutes == 60:
        minutes = 0
        hours += 1

    return f"{hours:02}:{minutes:02}:{whole_seconds:02}.{milliseconds:03}"


def audio_duration(audio_path: Path) -> Optional[float]:
    try:
        from mutagen import File

        media = File(audio_path)
        if media is not None and media.info is not None and getattr(media.info, "length", None):
            return float(media.info.length)
    except Exception:
        return None
    return None


def detect_device(requested: str) -> str:
    """Resolve the compute device, auto-detecting CUDA when requested."""
    if requested == "auto":
        try:
            import torch

            if torch.cuda.is_available():
                gpu_name = torch.cuda.get_device_name(0)
                vram_gb = torch.cuda.get_device_properties(0).total_mem / (1024**3)
                emit("log", message=f"CUDA GPU detected: {gpu_name} ({vram_gb:.1f} GB VRAM)")
                emit("gpu_info", gpuName=gpu_name, vramGb=round(vram_gb, 1), device="cuda")
                return "cuda"
            else:
                emit("log", message="No CUDA GPU detected, falling back to CPU")
                emit("gpu_info", gpuName=None, vramGb=None, device="cpu")
                return "cpu"
        except ImportError:
            emit("log", message="PyTorch not available for GPU detection, falling back to CPU")
            emit("gpu_info", gpuName=None, vramGb=None, device="cpu")
            return "cpu"
        except Exception as exc:
            emit("log", message=f"GPU detection failed ({exc}), falling back to CPU")
            emit("gpu_info", gpuName=None, vramGb=None, device="cpu")
            return "cpu"

    return requested


def resolve_compute_type(compute_type: str, device: str) -> str:
    """Pick the best compute type for the resolved device."""
    if compute_type != "auto":
        return compute_type
    # float16 is optimal for modern NVIDIA GPUs (RTX 30xx/40xx/50xx)
    # int8 is best for CPU inference
    return "float16" if device == "cuda" else "int8"


def cue_text(words: Iterable[object]) -> str:
    return clean_text("".join(getattr(word, "word", "") for word in words))


def flush_words(words: list[object], min_duration: float) -> Optional[Cue]:
    if not words:
        return None

    start = float(getattr(words[0], "start", 0.0) or 0.0)
    end = float(getattr(words[-1], "end", start + min_duration) or start + min_duration)
    if end <= start:
        end = start + min_duration

    text = cue_text(words)
    if not text:
        return None

    return Cue(start=start, end=end, text=text)


def segment_to_cues(segment: object, max_chars: int, max_duration: float, min_duration: float) -> list[Cue]:
    words = [word for word in (getattr(segment, "words", None) or []) if getattr(word, "word", "").strip()]

    if not words:
        start = float(getattr(segment, "start", 0.0) or 0.0)
        end = float(getattr(segment, "end", start + min_duration) or start + min_duration)
        text = clean_text(getattr(segment, "text", ""))
        return [Cue(start=start, end=max(end, start + min_duration), text=text)] if text else []

    cues: list[Cue] = []
    current: list[object] = []

    for word in words:
        if current:
            projected_text = cue_text([*current, word])
            projected_start = float(getattr(current[0], "start", 0.0) or 0.0)
            projected_end = float(getattr(word, "end", projected_start) or projected_start)
            projected_duration = projected_end - projected_start
            too_long = len(projected_text) > max_chars
            too_slow = projected_duration > max_duration

            if (too_long or too_slow) and projected_duration >= min_duration:
                cue = flush_words(current, min_duration)
                if cue is not None:
                    cues.append(cue)
                current = []

        current.append(word)
        text = cue_text(current)
        start = float(getattr(current[0], "start", 0.0) or 0.0)
        end = float(getattr(current[-1], "end", start) or start)
        ends_sentence = text.endswith((".", "?", "!", ";", ":"))
        mature = (end - start) >= min_duration
        nicely_sized = len(text) >= max_chars * 0.62 or (end - start) >= max_duration * 0.72

        if ends_sentence and mature and nicely_sized:
            cue = flush_words(current, min_duration)
            if cue is not None:
                cues.append(cue)
            current = []

    final_cue = flush_words(current, min_duration)
    if final_cue is not None:
        cues.append(final_cue)

    return cues


def write_vtt_header(handle, source: Path, model: str) -> None:
    generated = time.strftime("%Y-%m-%d %H:%M:%S")
    handle.write("WEBVTT\n\n")
    handle.write(f"NOTE Generated locally by Scribe Studio at {generated}\n")
    handle.write(f"NOTE Source: {source.name}\n")
    handle.write(f"NOTE Model: {model}\n\n")


def write_cue(handle, cue: Cue) -> None:
    handle.write(f"{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n")
    handle.write(f"{fix_cue_text(cue.text)}\n\n")


def transcribe_one(
    model,
    pipeline,
    audio_path: Path,
    output_path: Path,
    args,
    file_index: int,
    total_files: int,
) -> int:
    """Transcribe a single audio file using an already-loaded model. Returns cue count."""
    transcript_path = output_path.with_suffix(".txt")
    partial_vtt = output_path.with_suffix(".partial.vtt")
    partial_txt = transcript_path.with_suffix(".partial.txt")

    duration = audio_duration(audio_path)

    emit(
        "file_start",
        filePath=str(audio_path),
        outputPath=str(output_path),
        index=file_index,
        total=total_files,
        duration=duration,
    )

    file_start_time = time.monotonic()

    try:
        # Batched inference requires VAD to split audio into chunks.
        # Fall back to sequential mode when the user disables VAD.
        use_batched = args.batched and pipeline is not None and args.vad
        if use_batched:
            segments, info = pipeline.transcribe(
                str(audio_path),
                language=args.language or None,
                task=args.task,
                beam_size=args.beam_size,
                vad_filter=args.vad,
                word_timestamps=args.word_timestamps,
                # Only pass without_timestamps when explicitly disabling word timestamps
                **({"without_timestamps": True} if not args.word_timestamps else {}),
                initial_prompt=args.initial_prompt or None,
                batch_size=max(1, args.batch_size),
                condition_on_previous_text=args.condition_on_previous_text,
            )
        else:
            segments, info = model.transcribe(
                str(audio_path),
                language=args.language or None,
                task=args.task,
                beam_size=args.beam_size,
                vad_filter=args.vad,
                word_timestamps=args.word_timestamps,
                initial_prompt=args.initial_prompt or None,
                condition_on_previous_text=args.condition_on_previous_text,
            )

        detected_duration = duration or getattr(info, "duration", None)
        detected_language = getattr(info, "language", None)
        language_prob = getattr(info, "language_probability", None)

        emit(
            "metadata",
            filePath=str(audio_path),
            duration=detected_duration,
            language=detected_language,
            languageProbability=language_prob,
        )

        cue_count = 0
        with partial_vtt.open("w", encoding="utf-8", newline="\n") as vtt, partial_txt.open(
            "w", encoding="utf-8", newline="\n"
        ) as transcript:
            write_vtt_header(vtt, audio_path, args.model)

            for segment in segments:
                segment_text = compact_text(getattr(segment, "text", ""))
                if segment_text:
                    transcript.write(segment_text + "\n")

                cues = segment_to_cues(
                    segment,
                    max_chars=max(24, args.max_cue_chars),
                    max_duration=max(1.5, args.max_cue_duration),
                    min_duration=max(0.2, args.min_cue_duration),
                )

                for cue in cues:
                    cue_count += 1
                    write_cue(vtt, cue)

                vtt.flush()
                transcript.flush()

                segment_end = float(getattr(segment, "end", 0.0) or 0.0)
                progress = None
                if detected_duration:
                    progress = max(0.0, min(1.0, segment_end / float(detected_duration)))

                emit(
                    "segment",
                    filePath=str(audio_path),
                    text=segment_text,
                    currentTime=segment_end,
                    duration=detected_duration,
                    progress=progress,
                )

        os.replace(partial_vtt, output_path)
        os.replace(partial_txt, transcript_path)

        elapsed = round(time.monotonic() - file_start_time, 1)

        emit(
            "complete",
            filePath=str(audio_path),
            message=f"Created {cue_count} VTT cues.",
            outputPath=str(output_path),
            transcriptPath=str(transcript_path),
            cueCount=cue_count,
            progress=1,
            duration=detected_duration,
            language=detected_language,
            languageProbability=language_prob,
            elapsedSeconds=elapsed,
            index=file_index,
            total=total_files,
        )

        return cue_count

    except KeyboardInterrupt:
        raise
    except Exception as exc:
        emit(
            "error",
            filePath=str(audio_path),
            message=str(exc),
            details=traceback.format_exc(),
            index=file_index,
            total=total_files,
        )
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audiobook files locally and export WebVTT.")

    # Single-file mode (backward compatible)
    parser.add_argument("audio", nargs="?", default=None, help="Path to a single source audio file.")
    parser.add_argument("--output", default=None, help="Path to the final .vtt file (single-file mode).")

    # Batch mode
    parser.add_argument(
        "--jobs-file",
        default=None,
        help="Path to a JSON file containing [{input, output}, ...] pairs for batch processing.",
    )

    parser.add_argument("--model", default="large-v3", help="Whisper model name or local model path.")
    parser.add_argument("--model-dir", default=None, help="Directory used to cache downloaded models.")
    parser.add_argument("--language", default=None, help="Optional language code such as en, es, fr.")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["cpu", "cuda", "auto"],
        help="Inference device. 'auto' detects CUDA GPU and falls back to CPU.",
    )
    parser.add_argument(
        "--compute-type",
        default="auto",
        choices=["int8", "float16", "int8_float16", "float32", "auto", "default"],
        help="CTranslate2 compute type. 'auto' picks float16 for CUDA, int8 for CPU.",
    )
    parser.add_argument("--cpu-threads", default=0, type=int, help="Number of CPU threads for CTranslate2.")
    parser.add_argument("--task", default="transcribe", choices=["transcribe", "translate"], help="Whisper task.")
    parser.add_argument("--beam-size", default=3, type=int, help="Decoding beam size (3 = good balance of speed vs accuracy; 1 = fastest greedy; 5 = max accuracy).")
    parser.add_argument("--batch-size", default=32, type=int, help="Batch size for batched transcription (RTX: 32–48).")
    parser.add_argument(
        "--batched",
        dest="batched",
        action="store_true",
        default=True,
        help="Use faster batched transcription for long audio.",
    )
    parser.add_argument("--no-batched", dest="batched", action="store_false", help="Use standard sequential transcription.")
    parser.add_argument("--vad", dest="vad", action="store_true", default=True, help="Enable voice activity filtering.")
    parser.add_argument("--no-vad", dest="vad", action="store_false", help="Disable voice activity filtering.")
    parser.add_argument(
        "--condition-on-previous-text",
        dest="condition_on_previous_text",
        action="store_true",
        default=False,
        help="Feed prior Whisper output as context for the next segment (improves accuracy but disables batch parallelism, making long files slower).",
    )
    parser.add_argument(
        "--no-condition-on-previous-text",
        dest="condition_on_previous_text",
        action="store_false",
        help="Disable previous-text conditioning (default — faster batched processing with no repetition loops).",
    )
    parser.add_argument(
        "--word-timestamps",
        dest="word_timestamps",
        action="store_true",
        default=True,
        help="Enable word timestamps for phrase-level cues (default: on).",
    )
    parser.add_argument(
        "--no-word-timestamps",
        dest="word_timestamps",
        action="store_false",
        help="Use Whisper segment timestamps only.",
    )
    parser.add_argument("--max-cue-duration", type=float, default=3.5,
                        help="Maximum target cue duration in seconds (default 3.5 for phrase-level quotes).")
    parser.add_argument("--max-cue-chars", type=int, default=42,
                        help="Maximum target cue length in characters (default 42 ~6-7 words).")
    parser.add_argument("--min-cue-duration", type=float, default=0.5,
                        help="Minimum cue duration in seconds (default 0.5).")
    parser.add_argument("--initial-prompt", default=None, help="Optional vocabulary or spelling hints.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # Resolve jobs list
    if args.jobs_file:
        try:
            with open(args.jobs_file, encoding="utf-8") as f:
                jobs = json.load(f)
        except Exception as exc:
            emit("error", message=f"Could not read jobs file: {exc}")
            return 2
    elif args.audio and args.output:
        jobs = [{"input": args.audio, "output": args.output}]
    else:
        emit("error", message="Provide either --jobs-file or both 'audio' and --output arguments.")
        return 2

    if not jobs:
        emit("error", message="No jobs to process.")
        return 2

    # Validate all input paths before loading model
    for job in jobs:
        ap = Path(job["input"]).expanduser().resolve()
        if not ap.exists():
            emit("error", message=f"Audio file not found: {ap}")
            return 2

    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
    except Exception as exc:
        emit("error", message=f"Missing Python engine packages. Run the setup script. Details: {exc}")
        return 2

    resolved_device = detect_device(args.device)
    resolved_compute_type = resolve_compute_type(args.compute_type, resolved_device)

    emit(
        "log",
        message=f"Device: {resolved_device} | Compute: {resolved_compute_type} | Model: {args.model} | Jobs: {len(jobs)}",
    )
    emit("ready", message=f"Loading {args.model} model…", jobCount=len(jobs))

    batch_start = time.monotonic()

    try:
        model = WhisperModel(
            args.model,
            device=resolved_device,
            compute_type=resolved_compute_type,
            # Use all logical cores when running on CPU and no explicit thread count given.
            # CTranslate2's auto-detect can be conservative; os.cpu_count() is more aggressive.
            cpu_threads=max(0, args.cpu_threads) or (os.cpu_count() or 4 if resolved_device == "cpu" else 0),
            download_root=args.model_dir,
        )
    except Exception as exc:
        emit("error", message=f"Could not load model '{args.model}': {exc}", details=traceback.format_exc())
        return 3

    pipeline = BatchedInferencePipeline(model=model) if args.batched else None
    emit("log", message=f"Model loaded in {time.monotonic() - batch_start:.1f}s")

    total_cues = 0
    total_files = len(jobs)

    try:
        for index, job in enumerate(jobs):
            audio_path = Path(job["input"]).expanduser().resolve()
            output_path = Path(job["output"]).expanduser().resolve()
            output_path.parent.mkdir(parents=True, exist_ok=True)

            cues = transcribe_one(model, pipeline, audio_path, output_path, args, index, total_files)
            total_cues += cues

        elapsed = round(time.monotonic() - batch_start, 1)
        emit(
            "all_complete",
            message=f"Batch done. {total_files} file{'s' if total_files != 1 else ''}, {total_cues} total cues.",
            totalFiles=total_files,
            totalCues=total_cues,
            elapsedSeconds=elapsed,
        )
        return 0

    except KeyboardInterrupt:
        emit("cancelled", message="Cancelled by user.")
        return 130
    except Exception as exc:
        emit("error", message=str(exc), details=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
