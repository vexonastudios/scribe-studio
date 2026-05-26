export type CaptionFile = {
  path: string;
  name: string;
  size: number;
};

export type ConversionRequest = {
  filePaths: string[];
  outputDir?: string;
  overwriteExisting: boolean;
};

export type ConversionResult = {
  sourcePath: string;
  sourceName: string;
  status: "converted" | "failed";
  outputPath?: string;
  cueCount?: number;
  bytesWritten?: number;
  message?: string;
};

export type YouTubeCaptionTrack = {
  id: string;
  label: string;
  languageCode: string;
  kind: "manual" | "auto";
  isTranslatable: boolean;
  baseUrl: string;
};

export type YouTubeCaptionTracksResult = {
  videoId: string;
  title: string;
  tracks: YouTubeCaptionTrack[];
};

export type YouTubeCaptionConversionRequest = {
  videoInput: string;
  track: YouTubeCaptionTrack;
  outputDir?: string;
  overwriteExisting: boolean;
};

export type YouTubeCaptionConversionResult = {
  videoId: string;
  title: string;
  trackLabel: string;
  languageCode: string;
  status: "converted" | "failed";
  outputPath?: string;
  cueCount?: number;
  bytesWritten?: number;
  message?: string;
};
