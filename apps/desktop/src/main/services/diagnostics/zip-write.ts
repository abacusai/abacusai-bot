/**
 * Minimal in-memory ZIP writer for the log bundle. Dependency-free like
 * services/pptx/zip.ts: a deflate stream and a CRC32 are all an entry needs,
 * and zlib provides the hard half.
 */
import zlib from "zlib";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const DEFLATED = 8;

/** The format cannot express a date before 1980. */
const DOS_EPOCH_YEAR = 1980;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable != null) return crcTable;

  const built = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    built[index] = value >>> 0;
  }

  crcTable = built;

  return built;
}

function crc32(buf: Buffer): number {
  const lookup = table();
  let crc = 0xffffffff;

  for (const byte of buf) {
    crc = (crc >>> 8) ^ (lookup[(crc ^ byte) & 0xff] ?? 0);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** The two 16-bit MS-DOS fields ZIP still uses. */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), DOS_EPOCH_YEAR);

  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((year - DOS_EPOCH_YEAR) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

export interface ZipFile {
  /** Path inside the archive. Forward slashes, per the spec. */
  name: string;
  content: Buffer;
  /** Defaults to now. */
  modified?: Date;
}

/** Every entry is deflated: log text compresses to a fraction of its size. */
export function buildZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = zlib.deflateRawSync(file.content);
    const stamp = dosStamp(file.modified ?? new Date());
    const crc = crc32(file.content);

    const local = Buffer.alloc(30 + name.length);

    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is deflate
    local.writeUInt16LE(0, 6); // flags: none, so no data descriptor
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);

    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, end]);
}
