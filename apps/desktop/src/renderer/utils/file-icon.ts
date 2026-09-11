import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  Presentation,
  type LucideIcon,
} from "lucide-react";

import { categorizeFile, getFileExtension } from "./file-type-utils";

const BY_EXTENSION: Record<string, LucideIcon> = {
  pptx: Presentation,
  ppt: Presentation,
  potx: Presentation,
  ppsx: Presentation,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  csv: FileSpreadsheet,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
  mp3: FileAudio,
  wav: FileAudio,
  m4a: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  html: Globe,
  htm: Globe,
};

/** The icon for a file by what kind of thing it is, not which tool made it. */
export const fileIconFor = (filePath: string): LucideIcon => {
  if (/^https?:\/\//i.test(filePath)) return Globe;
  const byExt = BY_EXTENSION[getFileExtension(filePath)];
  if (byExt != null) return byExt;
  switch (categorizeFile(filePath)) {
    case "image":
      return FileImage;
    case "code":
      return FileCode;
    case "document":
    case "markdown":
    case "text":
      return FileText;
    default:
      return File;
  }
};
