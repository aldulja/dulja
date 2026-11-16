import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tar, tarGz, toCsv, toJson } from "../../src/export/archive";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("the deterministic export archive — ADR 0069", () => {
  const entries = [
    { path: "schema.json", bytes: utf8('{"formatVersion":1}') },
    { path: "tables/account.csv", bytes: utf8("code\n1000\n") },
  ];

  it("tar emits 512-byte blocks, the paths in order, and two zero blocks at the end", () => {
    const bytes = tar(entries);
    expect(bytes.byteLength % 512).toBe(0);
    const text = new TextDecoder().decode(bytes);
    expect(text.indexOf("schema.json")).toBeLessThan(text.indexOf("tables/account.csv"));
    expect(bytes.slice(-1024).every((b) => b === 0)).toBe(true);
    expect(new TextDecoder().decode(bytes.slice(257, 263))).toBe("ustar\0");
  });

  it("every header field that could vary is fixed: mode, uid, gid, mtime, uname, gname", () => {
    const head = Buffer.from(tar(entries).subarray(0, 512));
    expect(head.subarray(100, 108).toString("ascii")).toBe("0000644\0");
    expect(head.subarray(108, 116).toString("ascii")).toBe("0000000\0");
    expect(head.subarray(116, 124).toString("ascii")).toBe("0000000\0");
    expect(head.subarray(136, 148).toString("ascii")).toBe("00000000000\0");
    expect(head.subarray(265, 297).every((b) => b === 0)).toBe(true); // uname
    expect(head.subarray(297, 329).every((b) => b === 0)).toBe(true); // gname
  });

  it("the header checksum is the sum of the header with the field read as spaces", () => {
    const head = Uint8Array.from(tar(entries).subarray(0, 512));
    const stored = parseInt(Buffer.from(head.subarray(148, 154)).toString("ascii"), 8);
    head.fill(0x20, 148, 156);
    expect(head.reduce((a, b) => a + b, 0)).toBe(stored);
  });

  it("the same entries produce byte-identical output, twice", () => {
    expect(Buffer.from(tar(entries)).equals(Buffer.from(tar(entries)))).toBe(true);
    expect(Buffer.from(tarGz(entries)).equals(Buffer.from(tarGz(entries)))).toBe(true);
  });

  it("the gzip header carries no mtime, no name, and the 'unknown' OS byte", () => {
    const gz = tarGz(entries);
    expect([...gz.subarray(0, 3)]).toEqual([0x1f, 0x8b, 8]);
    expect(gz[3]).toBe(0); // FLG: no FNAME, no FHCRC
    expect([...gz.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // MTIME
    expect(gz[9]).toBe(0xff); // OS: unknown, whatever platform built zlib
  });

  it("tarGz round-trips through gunzip to exactly the tar bytes", () => {
    expect(
      Buffer.from(gunzipSync(Buffer.from(tarGz(entries)))).equals(Buffer.from(tar(entries))),
    ).toBe(true);
  });

  it("a path longer than 100 bytes is rejected, naming it (USTAR's limit)", () => {
    expect(() => tar([{ path: `tables/${"x".repeat(120)}.csv`, bytes: utf8("") }])).toThrow(
      /x{10}/,
    );
  });

  it("toCsv writes the header, quotes what needs quoting and renders null as empty", () => {
    expect(
      toCsv(
        ["code", "name_en"],
        [
          { code: "1000", name_en: "Cash, on hand" },
          { code: "1100", name_en: 'He said "bank"' },
          { code: "1200", name_en: null },
          { code: "1300", name_en: "two\nlines" },
        ],
      ),
    ).toBe(
      "code,name_en\n" +
        '1000,"Cash, on hand"\n' +
        '1100,"He said ""bank"""\n' +
        "1200,\n" +
        '1300,"two\nlines"\n',
    );
  });

  it("toCsv writes a header alone for an empty table", () => {
    expect(toCsv(["code"], [])).toBe("code\n");
  });

  it("toJson writes one object per row, newline-delimited, in column order", () => {
    expect(
      toJson([
        { code: "1000", name_en: "Cash" },
        { code: "1100", name_en: null },
      ]),
    ).toBe('{"code":"1000","name_en":"Cash"}\n{"code":"1100","name_en":null}\n');
    expect(toJson([])).toBe("");
  });
});
