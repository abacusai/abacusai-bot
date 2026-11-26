/**
 * An installed app's icon: the first letter of its name on a colour taken
 * from its id, as a PNG (Linux, macOS) and a PNG-in-ICO (Windows). Drawn by
 * hand from a 5x7 font so no canvas or extra dependency is needed.
 */
import { nativeImage } from "electron";

// 5 columns x 7 rows, one number per row, high bit = left column.
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "?": [14, 17, 1, 2, 4, 0, 4],
};

const COLOURS: Array<[number, number, number]> = [
  [74, 63, 209],
  [31, 107, 58],
  [179, 38, 30],
  [138, 90, 0],
  [0, 110, 140],
  [120, 40, 160],
];

const SIZE = 256;

/** The icon as PNG bytes. */
export const appIconPng = (title: string, id: string): Buffer => {
  const letter =
    Array.from(title.normalize("NFKD").toUpperCase()).find(
      (c) => c in GLYPHS
    ) ?? "?";
  const glyph = GLYPHS[letter]!;
  const [r, g, b] = COLOURS[parseInt(id.slice(0, 2), 16) % COLOURS.length]!;
  // BGRA, as nativeImage.createFromBitmap expects.
  const bitmap = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 48;
  const cell = 24;
  const left = (SIZE - 5 * cell) / 2;
  const top = (SIZE - 7 * cell) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Rounded square: outside the corner circles stays transparent.
      const cx =
        x < radius ? radius : x >= SIZE - radius ? SIZE - radius - 1 : x;
      const cy =
        y < radius ? radius : y >= SIZE - radius ? SIZE - radius - 1 : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      const col = Math.floor((x - left) / cell);
      const row = Math.floor((y - top) / cell);
      const ink =
        col >= 0 &&
        col < 5 &&
        row >= 0 &&
        row < 7 &&
        (glyph[row]! >> (4 - col)) & 1;
      const at = (y * SIZE + x) * 4;
      bitmap[at] = ink ? 255 : b;
      bitmap[at + 1] = ink ? 255 : g;
      bitmap[at + 2] = ink ? 255 : r;
      bitmap[at + 3] = 255;
    }
  }
  return nativeImage
    .createFromBitmap(bitmap, { width: SIZE, height: SIZE })
    .toPNG();
};

/** One 256px PNG wrapped in an ICO container (Vista and later read it). */
export const pngToIco = (png: Buffer): Buffer => {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // 0 = 256 wide
  header.writeUInt8(0, 7); // 0 = 256 high
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png]);
};

/** One 256px PNG in an ICNS container ('ic08'), for a macOS launcher. */
export const pngToIcns = (png: Buffer): Buffer => {
  const entry = Buffer.alloc(8);
  entry.write("ic08", 0, "ascii");
  entry.writeUInt32BE(8 + png.length, 4);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(16 + png.length, 4);
  return Buffer.concat([header, entry, png]);
};
