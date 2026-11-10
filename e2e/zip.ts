// A minimal zip writer: stored entries, no compression, no dependencies.
//
// The e2e builds the http sidecar's zip at run time, because the manifest
// names a port the OS picked a moment earlier. Node has no zip writer and the
// CI runners do not share a zip tool (`zip` is not on Windows), so this
// writes the format directly: a local header and the data per file, then the
// central directory, then its end record (PKWARE APPNOTE 4.3).

import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

export function writeZip(path: string, files: Record<string, string | Buffer>): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(0, 10); // mod time and date: none
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    // extra, comment, disk start, internal and external attributes: zero
    central.writeUInt32LE(offset, 42); // where the local header starts
    centrals.push(central, fileName);

    offset += local.length + fileName.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8); // entries on this disk
  end.writeUInt16LE(count, 10); // entries in total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts

  writeFileSync(path, Buffer.concat([...locals, directory, end]));
}
