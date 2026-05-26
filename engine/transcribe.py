from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


@dataclass
class Cue:
    start: float
    end: float
    text: str


def emit(event_type: str, **payload: object) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def compact_text(text: str) -> str:
    compact = re.sub(r"\s+", " ", text.replace("-->", "->")).strip()
    return compact


def clean_text(text: str) -> str:
    return html.escape(compact_text(text), quote=False)


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
                return "cuda"
            else:
                emit("log", message="No CUDA GPU detected, falling back to CPU")
                return "cpu"
        except ImportError:
            emit("log", message="PyTorch not available for GPU detection, falling back to CPU")
            return "cpu"
        except Exception as exc:
            emit("log", message=f"GPU detection failed ({exc}), falling back to CPU")
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
    handle.write(f"NOTE Generated locally by Audiobook VTT Studio at {generated}\n")
    handle.write(f"NOTE Source: {source.name}\n")
    handle.write(f"NOTE Model: {model}\n\n")


def write_cue(handle, cue: Cue) -> None:
    handle.write(f"{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n")
    handle.write(f"{cue.text}\n\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe an audiobook locally and export WebVTT.")
    parser.add_argument("audio", help="Path to the source audio file.")
    parser.add_argument("--output", required=True, help="Path to the final .vtt file.")
    parser.add_argument("--model", default="medium", help="Whisper model name or local model path.")
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
    parser.add_argument("--cpu-threads", default=0, type=int, help="Number of CPU threads for CTranslate2. Use 0 for default.")
    parser.add_argument("--task", default="transcribe", choices=["transcribe", "translate"], help="Whisper task.")
    parser.add_argument("--beam-size", default=5, type=int, help="Decoding beam size.")
    parser.add_argument("--batch-size", default=24, type=int, help="Batch size for faster batched transcription.")
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
        "--word-timestamps",
        dest="word_timestamps",
        action="store_true",
        default=False,
        help="Enable word timestamps for cleaner read-along cues.",
    )
    parser.add_argument(
        "--no-word-timestamps",
        dest="word_timestamps",
        action="store_false",
        help="Use Whisper segment timestamps only.",
    )
    parser.add_argument("--max-cue-duration", type=float, default=9.0, help="Maximum target cue duration in seconds.")
    parser.add_argument("--max-cue-chars", type=int, default=120, help="Maximum target cue length.")
    parser.add_argument("--min-cue-duration", type=float, default=0.7, help="Minimum cue duration in seconds.")
    parser.add_argument("--initial-prompt", default=None, help="Optional vocabulary or spelling hints.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audio_path = Path(args.audio).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    transcript_path = output_path.with_suffix(".txt")
    partial_vtt = output_path.with_suffix(".partial.vtt")
    partial_txt = transcript_path.with_suffix(".partial.txt")

    if not audio_path.exists():
        emit("error", message=f"Audio file not found: {audio_path}")
        return 2

    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
    except Exception as exc:
        emit("error", message=f"Missing Python engine packages. Run npm run setup. Details: {exc}")
        return 2

    # Resolve device and compute type with auto-detection
    resolved_device = detect_device(args.device)
    resolved_compute_type = resolve_compute_type(args.compute_type, resolved_device)

    emit("log", message=f"Device: {resolved_device} | Compute type: {resolved_compute_type} | Model: {args.model}")

    duration = audio_duration(audio_path)
    emit("ready", message="Loading local Whisper model", duration=duration)

    try:
        model = WhisperModel(
            args.model,
            device=resolved_device,
            compute_type=resolved_compute_type,
            cpu_threads=max(0, args.cpu_threads),
            download_root=args.model_dir,
        )
    except Exception as exc:
        emit("error", message=f"Could not load model '{args.model}': {exc}", details=traceback.format_exc())
        return 3

    emit("ready", message="Transcription started", duration=duration)
    emit("log", message=f"Input: {audio_path}")
    emit("log", message=f"Output VTT: {output_path}")
    emit("log", message=f"Transcript TXT: {transcript_path}")

    try:
        if args.batched:
            emit("log", message=f"Batched speed mode enabled with batch size {args.batch_size} and beam size {args.beam_size}")
            pipeline = BatchedInferencePipeline(model=model)
            segments, info = pipeline.transcribe(
                str(audio_path),
                language=args.language or None,
                task=args.task,
                beam_size=args.beam_size,
                vad_filter=args.vad,
                word_timestamps=args.word_timestamps,
                without_timestamps=not args.word_timestamps,
                initial_prompt=args.initial_prompt or None,
                batch_size=max(1, args.batch_size),
                condition_on_previous_text=False,
            )
        else:
            emit("log", message=f"Sequential quality mode enabled with beam size {args.beam_size}")
            segments, info = model.transcribe(
                str(audio_path),
                language=args.language or None,
                task=args.task,
                beam_size=args.beam_size,
                vad_filter=args.vad,
                word_timestamps=args.word_timestamps,
                initial_prompt=args.initial_prompt or None,
            )

        detected_duration = duration or getattr(info, "duration", None)
        emit(
            "metadata",
            duration=detected_duration,
            language=getattr(info, "language", None),
            languageProbability=getattr(info, "language_probability", None),
        )

        cue_count = 0
        with partial_vtt.open("w", encoding="utf-8", newline="\n") as vtt, partial_txt.open(
            "w", encoding="utf-8", newline="\n"
        ) as transcript:
            write_vtt_header(vtt, audio_path, args.model)
            emit("log", message="VTT header written")

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
                    text=segment_text,
                    currentTime=segment_end,
                    duration=detected_duration,
                    progress=progress,
                )

        os.replace(partial_vtt, output_path)
        os.replace(partial_txt, transcript_path)
        emit(
            "complete",
            message=f"Created {cue_count} VTT cues.",
            outputPath=str(output_path),
            transcriptPath=str(transcript_path),
            progress=1,
            duration=detected_duration,
        )
        return 0

    except KeyboardInterrupt:
        emit("cancelled", message="Cancelled.")
        return 130
    except Exception as exc:
        emit("error", message=str(exc), details=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
