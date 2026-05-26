const timingLinePattern =
  /^\s*(\d{1,3}:\d{2}(?::\d{2})?[\.,]\d{1,3})\s*,\s*(\d{1,3}:\d{2}(?::\d{2})?[\.,]\d{1,3})\s*$/;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeTimestamp(timestamp: string) {
  const normalized = timestamp.trim().replace(",", ".");
  const parts = normalized.split(":");
  const hasHours = parts.length === 3;
  const hours = hasHours ? Number(parts[0]) : 0;
  const minutes = Number(hasHours ? parts[1] : parts[0]);
  const secondsPart = hasHours ? parts[2] : parts[1];
  const [secondsValue, fractionValue = "0"] = secondsPart.split(".");
  const seconds = Number(secondsValue);
  const fraction = fractionValue.padEnd(3, "0").slice(0, 3);

  if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${fraction}`;
}

export type ConvertSbvOptions = {
  /** When true, skip malformed cues instead of throwing. Useful for batch processing. */
  lenient?: boolean;
};

export function convertSbvToVtt(input: string, options?: ConvertSbvOptions) {
  const lenient = options?.lenient ?? false;
  const normalized = normalizeLineEndings(input.replace(/^\uFEFF/, ""));
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trimEnd())
    .filter((block) => block.trim().length > 0);
  const cues: string[] = [];
  const skipped: number[] = [];

  blocks.forEach((block, index) => {
    const lines = block.split("\n");
    const timingLine = lines[0];
    const match = timingLine.match(timingLinePattern);

    if (!match) {
      if (lenient) {
        skipped.push(index + 1);
        return;
      }

      const lineNumber = normalized.substring(0, normalized.indexOf(block)).split("\n").length;
      throw new Error(`Cue ${index + 1} (line ${lineNumber}) is missing a valid SBV timing line: "${timingLine.trim()}"`);
    }

    try {
      const textLines = lines.slice(1);
      const start = normalizeTimestamp(match[1]);
      const end = normalizeTimestamp(match[2]);
      cues.push([`${start} --> ${end}`, ...textLines].join("\n"));
    } catch (error) {
      if (lenient) {
        skipped.push(index + 1);
        return;
      }

      const lineNumber = normalized.substring(0, normalized.indexOf(block)).split("\n").length;
      throw new Error(`Cue ${index + 1} (line ${lineNumber}): ${error instanceof Error ? error.message : "Parse error"}`);
    }
  });

  if (cues.length === 0) {
    throw new Error(skipped.length > 0
      ? `No valid SBV cues found. ${skipped.length} cue${skipped.length === 1 ? " was" : "s were"} skipped due to errors.`
      : "No SBV cues were found.");
  }

  return {
    cueCount: cues.length,
    skippedCount: skipped.length,
    vtt: `WEBVTT\n\n${cues.join("\n\n")}\n`
  };
}
