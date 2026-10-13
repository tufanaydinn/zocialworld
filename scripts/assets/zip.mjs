// A minimal ZIP reader: lists the entries of an archive held in memory and extracts stored or deflated entries.
// It reads the central directory (so sizes written after the data, bit 3, are handled) and supports ZIP64 sizes
// and offsets. Encrypted entries and other compression methods are rejected.
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @typedef {{ name: string, method: number, compressedSize: number, size: number, offset: number, crc: number, directory: boolean }} ZipEntry
 */

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error("not a zip archive (no end of central directory record)");
}

function readZip64Extra(extra, fields) {
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      let p = i + 4;
      const out = {};
      for (const field of fields) {
        out[field] = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      return out;
    }
    i += 4 + len;
  }
  return {};
}

/** Lists every entry of the archive, in central-directory order. */
export function listZip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error("zip64 locator missing");
    const record = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(record) !== ZIP64_EOCD) throw new Error("zip64 end of central directory missing");
    count = Number(buf.readBigUInt64LE(record + 32));
    cdOffset = Number(buf.readBigUInt64LE(record + 48));
  }
  /** @type {ZipEntry[]} */
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error(`bad central directory entry at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    const wanted = [];
    if (size === 0xffffffff) wanted.push("size");
    if (compressedSize === 0xffffffff) wanted.push("compressedSize");
    if (offset === 0xffffffff) wanted.push("offset");
    if (wanted.length > 0) {
      const z = readZip64Extra(extra, wanted);
      size = z.size ?? size;
      compressedSize = z.compressedSize ?? compressedSize;
      offset = z.offset ?? offset;
    }
    if (flags & 0x1) throw new Error(`encrypted zip entry: ${name}`);
    entries.push({ name, method, compressedSize, size, offset, crc, directory: name.endsWith("/") });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Returns the uncompressed bytes of one entry. */
export function readZipEntry(buf, entry) {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== LOCAL) throw new Error(`bad local header for ${entry.name}`);
  const nameLength = buf.readUInt16LE(p + 26);
  const extraLength = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size) throw new Error(`size mismatch for ${entry.name}: ${data.length} != ${entry.size}`);
  return data;
}
