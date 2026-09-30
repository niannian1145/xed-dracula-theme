#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');

// Optional files included in the .xed package when present. The server extracts
// icon.png / README.md / CHANGELOG.md into storage at publish time.
const OPTIONAL_FILES = ['README.md', 'icon.png', 'CHANGELOG.md'];

/* ── Minimal ZIP writer (no external deps) ──────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const method = 8; // deflate
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags (utf-8)
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/* ── Read & validate sources ────────────────────────────────────────────── */

function readJson(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    throw new Error(`${file} not found. Make sure you're in the theme template root.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const themeJson = readJson('theme.json');
  const manifest = readJson('manifest.json');

  if (!manifest.id) {
    throw new Error('manifest.json must define an "id".');
  }
  if (!manifest.name) {
    throw new Error('manifest.json must define a "name".');
  }
  if (manifest.minAppVersion != null && !Number.isInteger(manifest.minAppVersion)) {
    throw new Error('manifest.json "minAppVersion" must be an integer or null.');
  }
  if (manifest.inheritBase != null && typeof manifest.inheritBase !== 'boolean') {
    throw new Error('manifest.json "inheritBase" must be a boolean.');
  }
  if (!manifest.version) {
    console.warn('⚠️  manifest.json has no "version" field. The store will default it.');
  }

  const entries = [
    { name: 'theme.json', data: Buffer.from(JSON.stringify(themeJson, null, 2), 'utf8') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
  ];

  for (const file of OPTIONAL_FILES) {
    const p = path.join(ROOT, file);
    if (fs.existsSync(p)) {
      entries.push({ name: file, data: fs.readFileSync(p) });
    }
  }

  const zip = buildZip(entries);
  const outName = `${manifest.id}.xed`;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, outName), zip);

  const kb = (zip.length / 1024).toFixed(1);
  const included = entries.map((e) => e.name).join(', ');
  console.log(`✅ Built ${outName} (${kb} KB)`);
  console.log(`   Contained files: ${included}`);
  console.log(`   Location: ${path.join(OUTPUT_DIR, outName)}`);
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
