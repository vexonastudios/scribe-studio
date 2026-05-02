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

export function convertSbvToVtt(input: string) {
  const normalized = normalizeLineEndings(input.replace(/^\uFEFF/, ""));
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trimEnd())
    .filter((block) => block.trim().length > 0);
  const cues: string[] = [];

  blocks.forEach((block, index) => {
    const lines = block.split("\n");
    const timingLine = lines[0];
    const match = timingLine.match(timingLinePattern);

    if (!match) {
      throw new Error(`Cue ${index + 1} is missing a valid SBV timing line.`);
    }

    const textLines = lines.slice(1);
    const start = normalizeTimestamp(match[1]);
    const end = normalizeTimestamp(match[2]);
    cues.push([`${start} --> ${end}`, ...textLines].join("\n"));
  });

  if (cues.length === 0) {
    throw new Error("No SBV cues were found.");
  }

  return {
    cueCount: cues.length,
    vtt: `WEBVTT\n\n${cues.join("\n\n")}\n`
  };
}
