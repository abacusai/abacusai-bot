/** Minimal ZIP reader for OOXML packages: central directory, store, deflate. */
import zlib from "zlib";

/** Per-entry inflated-size cap so a zip bomb cannot exhaust main's memory. */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export type ZipEntry = {
  /** Path inside the archive, e.g. `ppt/slides/slide1.xml`. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();

  private constructor(private readonly buf: Buffer) {}

  static open(buf: Buffer): ZipArchive {
    const archive = new ZipArchive(buf);
    archive.readCentralDirectory();
    return archive;
  }

  /** Archive-relative paths, in central-directory order. */
  list(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Decompressed bytes for one entry, or null when the entry is absent. */
  read(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (entry == null) return null;

    const buf = this.buf;
    const off = entry.localHeaderOffset;
    if (buf.readUInt32LE(off) !== LOCAL_SIG) return null;

    // The local header repeats name/extra with lengths that may differ from the
    // central directory's, so the data offset must come from the local header.
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

    try {
      if (entry.compressionMethod === 0) return Buffer.from(data);
      if (entry.compressionMethod === 8) {
        // Overflowing the cap throws, and the catch below turns it into the
        // same null a corrupt entry produces.
        return zlib.inflateRawSync(data, {
          maxOutputLength: MAX_INFLATED_BYTES,
        });
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Decompressed entry decoded as UTF-8 (BOM stripped), or null. */
  readText(name: string): string | null {
    const buf = this.read(name);
    if (buf == null) return null;
    const text = buf.toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  private readCentralDirectory(): void {
    const buf = this.buf;
    const eocd = findSignatureFromEnd(buf, EOCD_SIG);
    if (eocd < 0) throw new Error("not-a-zip");

    let entryCount = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64
    // end-of-central-directory record the locator points at.
    if (entryCount === 0xffff || cdOffset === 0xffffffff) {
      const locator = findSignatureFromEnd(buf, EOCD64_LOCATOR_SIG);
      if (locator >= 0) {
        const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
        if (
          eocd64 >= 0 &&
          eocd64 + 56 <= buf.length &&
          buf.readUInt32LE(eocd64) === EOCD64_SIG
        ) {
          entryCount = Number(buf.readBigUInt64LE(eocd64 + 32));
          cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
        }
      }
    }

    let ptr = cdOffset;
    for (let i = 0; i < entryCount; i++) {
      if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CENTRAL_SIG) break;
      const compressionMethod = buf.readUInt16LE(ptr + 10);
      const compressedSize = buf.readUInt32LE(ptr + 20);
      const uncompressedSize = buf.readUInt32LE(ptr + 24);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localHeaderOffset = buf.readUInt32LE(ptr + 42);
      const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

      this.entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
  }
}

/** Scans backwards for a 4-byte signature; a comment can offset the EOCD. */
function findSignatureFromEnd(buf: Buffer, signature: number): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 4; i >= min; i--) {
    if (buf.readUInt32LE(i) === signature) return i;
  }
  return -1;
}
