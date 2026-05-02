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
