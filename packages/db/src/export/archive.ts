import { gzipSync } from "node:zlib";
import type { ExportRow } from "./tables";

/**
 * The export's container (ADR 0069 decision 1): a deterministic USTAR tarball, gzipped. Fifty lines of tar
 * and `node:zlib` rather than a dependency — the archive is the one thing a tenant takes away, so its bytes
 * are decided here and nowhere else.
 */
export interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
/** Every header field that could vary is a fixed literal — that is the whole determinism argument. */
const MODE = "0000644";
const OWNER = "0000000";
/** The epoch, octal, eleven digits. A file's real mtime would make two exports of one book differ. */
const MTIME = "00000000000";
const TYPE_FILE = "0";
/** USTAR's `name` field. The `prefix` field could lengthen it; nothing the exporter writes needs it. */
const NAME_WIDTH = 100;

const encoder = new TextEncoder();

function writeAscii(block: Uint8Array, at: number, value: string, width: number): void {
  const bytes = encoder.encode(value);
  if (bytes.length > width) throw new Error(`tar: '${value}' does not fit in ${width} bytes`);
  block.set(bytes, at);
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  if (encoder.encode(entry.path).length > NAME_WIDTH) {
    throw new Error(`tar: path '${entry.path}' exceeds USTAR's ${NAME_WIDTH}-byte name field`);
  }
  writeAscii(block, 0, entry.path, NAME_WIDTH);
  writeAscii(block, 100, `${MODE}\0`, 8);
  writeAscii(block, 108, `${OWNER}\0`, 8); // uid
  writeAscii(block, 116, `${OWNER}\0`, 8); // gid
  writeAscii(block, 124, `${entry.bytes.byteLength.toString(8).padStart(11, "0")}\0`, 12);
  writeAscii(block, 136, `${MTIME}\0`, 12);
  writeAscii(block, 148, "        ", 8); // the checksum field reads as spaces while it is summed
  writeAscii(block, 156, TYPE_FILE, 1);
  writeAscii(block, 257, "ustar\0", 6);
  writeAscii(block, 263, "00", 2);
  // uname and gname stay empty: a build machine's user name must not reach a tenant's archive.
  let sum = 0;
  for (const b of block) sum += b;
  writeAscii(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
}

/** A deterministic USTAR tarball: every header field that could vary — mtime, uid, gid, mode, uname,
 *  gname — is a fixed literal, and entries are written in the order given. Same input, same bytes. */
export function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  let size = 0;
  for (const entry of entries) {
    const head = header(entry);
    const padded = new Uint8Array(Math.ceil(entry.bytes.byteLength / BLOCK) * BLOCK);
    padded.set(entry.bytes, 0);
    blocks.push(head, padded);
    size += head.byteLength + padded.byteLength;
  }
  const trailer = new Uint8Array(BLOCK * 2); // two zero blocks end a tar
  blocks.push(trailer);
  size += trailer.byteLength;

  const out = new Uint8Array(size);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.byteLength;
  }
  return out;
}

/** RFC 1952's "unknown" operating system. zlib writes the OS it was compiled for into header byte 9 (3 on
 *  Unix, 10 on Windows), which would make one export's digest depend on where the worker was built. */
const GZIP_OS_UNKNOWN = 0xff;

/**
 * `tar` then `gzipSync(level 9)`. Node's zlib writes a zero MTIME and no file name into the gzip header, and
 * the OS byte is fixed here, so the same tar gives the same bytes; `archive.test.ts` asserts it rather than
 * trusting it. The deflate stream itself is zlib's: a different zlib build may compress the same tar to
 * different bytes, so the digest is reproducible by the same build, and the tar inside it always is (ADR 0069).
 */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  const out = new Uint8Array(gzipSync(Buffer.from(tar(entries)), { level: 9 }));
  // Header byte 9 is outside both the CRC-32 (of the uncompressed data) and ISIZE, and FHCRC is not set.
  out[9] = GZIP_OS_UNKNOWN;
  return out;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 with the dialect `schema.json` documents: comma, double quote, `\n`, a header row, and null as
 *  the empty field. */
export function toCsv(columns: readonly string[], rows: readonly ExportRow[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}

/** Newline-delimited JSON: one object per row in its column order, so a consumer can stream it and a diff
 *  of two exports is line-oriented. */
export function toJson(rows: readonly ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}
