#!/usr/bin/env node
/*
 * Package a plugin folder as a MIDAS CIVIL NX plugin zip — cross-platform.
 *
 * A byte-for-byte mirror of pack.ps1's rules, for building on a machine that
 * is not Windows. Use pack.ps1 on Windows; the two agree on the exclusions,
 * the separator and the checks, and verify-zip.ps1 accepts either output.
 *
 *   node pack.js --source ../../plugins/my-plugin --out "dist/My Plugin v1.0.0.zip"
 *   node pack.js --source . --out out.zip --verify        # check an existing zip
 *
 * The rules that matter, all of them paid for on a real release:
 *
 *   - Entries are written with FORWARD SLASHES. PowerShell 5.1's
 *     Compress-Archive writes `vendor\file.js` with backslashes, which the ZIP
 *     spec forbids and which can stop a subfolder unpacking inside the host.
 *   - index.html must be at the ZIP ROOT, not inside a folder.
 *   - Development-only files must not ship: test/, mock-midas/, package.json.
 *   - The archive is verified against the source, entry by entry, hash for
 *     hash, before it is called done.
 *
 * No dependencies: the deflate comes from node's own zlib and the container is
 * written by hand, because a plugin toolchain that needs npm install is one
 * more thing to go wrong on a locked-down machine.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const EXCLUDE_FILES = ["package.json", "package-lock.json", ".gitignore"];
const EXCLUDE_DIRS = ["test", "mock-midas", "node_modules", ".git", ".claude", "scratchpad", "dist"];

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const out = { verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" || a === "-Source") out.source = argv[++i];
    else if (a === "--out" || a === "-Out") out.out = argv[++i];
    else if (a === "--verify") out.verify = true;
    else throw new Error("unknown argument: " + a);
  }
  if (!out.source || !out.out) {
    throw new Error("usage: pack.js --source <plugin folder> --out <zip path> [--verify]");
  }
  return out;
}

/* ------------------------------------------------------------------ walk -- */

/** Every file that should ship, as { rel, abs }, relative paths slash-separated. */
function shippingFiles(source) {
  const out = [];
  (function walk(dir, prefix) {
    fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.indexOf(entry.name) >= 0 && !prefix) return;
          if (EXCLUDE_DIRS.indexOf(entry.name) >= 0) return;
          walk(abs, rel);
          return;
        }
        if (!entry.isFile()) return;
        if (EXCLUDE_FILES.indexOf(rel) >= 0) return;
        out.push({ rel, abs });
      });
  })(source, "");
  return out;
}

/* ------------------------------------------------------------------- zip -- */

/* A minimal writer: local header + deflated data per entry, then the central
   directory. Stored with forward slashes and no directory entries, which is
   what the host unpacks cleanly. */

function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

function writeZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const data = fs.readFileSync(f.abs);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useStore = deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);
    /* The entry name. FORWARD SLASHES, always — this is the whole reason this
       file exists instead of a one-line call to a zip helper. */
    const name = Buffer.from(f.rel.split(path.sep).join("/"), "utf8");
    const { time, date } = dosTime(fs.statSync(f.abs).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            /* version needed */
    local.writeUInt16LE(0, 6);             /* flags — no UTF-8 bit; names are ASCII */
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);              /* extra */
    dir.writeUInt16LE(0, 32);              /* comment */
    dir.writeUInt16LE(0, 34);              /* disk */
    dir.writeUInt16LE(0, 36);              /* internal attrs */
    dir.writeUInt32LE(0, 38);              /* external attrs */
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + payload.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([Buffer.concat(chunks), centralBuf, end]));
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ---------------------------------------------------------------- verify -- */

/** Read the archive back and prove every entry matches the source, hash for
 *  hash. Catches the two failures that actually happen: a stale zip built
 *  before the last edit, and a development-only file that leaked. */
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  /* Find the end-of-central-directory record from the tail. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    entries.push({ name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function verify(source, zipPath) {
  const entries = readZipEntries(zipPath);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const expected = shippingFiles(source);
  let bad = 0;

  entries.forEach((e) => {
    if (e.name.indexOf("\\") >= 0) {
      console.log("BACKSLASH " + e.name + "   (the ZIP spec forbids this separator)");
      bad++;
    }
  });

  expected.forEach((f) => {
    const e = byName.get(f.rel);
    if (!e) { console.log("MISSING  " + f.rel); bad++; return; }
    if (sha256(e.data) !== sha256(fs.readFileSync(f.abs))) {
      console.log("STALE    " + f.rel);
      bad++;
    }
  });

  const shipped = new Set(expected.map((f) => f.rel));
  entries.forEach((e) => {
    if (!shipped.has(e.name)) {
      console.log("EXTRA    " + e.name + "   (in the zip, not in the shipping set)");
      bad++;
    }
  });

  if (!byName.has("index.html")) { console.log("index.html is NOT at the zip root"); bad++; }

  console.log("checked  : " + expected.length + " file(s)");
  console.log("mismatch : " + bad);
  if (bad) throw new Error("the zip does not match the source");
  console.log("The zip matches the source.");
}

/* ------------------------------------------------------------------ main -- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(args.source);
  const out = path.resolve(args.out);

  if (!fs.existsSync(path.join(source, "index.html"))) {
    throw new Error("No index.html in " + source + ". The host opens index.html from the ZIP ROOT.");
  }
  if (!fs.existsSync(path.join(source, "manifest.json"))) {
    throw new Error("No manifest.json in " + source + ".");
  }

  if (!args.verify) {
    const files = shippingFiles(source);
    writeZip(files, out);
    console.log("source          : " + source);
    console.log("output          : " + out);
    console.log("entries added   : " + files.length);
    console.log("size            : " + (fs.statSync(out).size / 1024).toFixed(1) + " kB");
  }
  verify(source, out);
}

try { main(); }
catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
