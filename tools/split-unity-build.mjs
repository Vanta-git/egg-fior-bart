// Splits the large Unity WebGL payloads in Build/ into <=3 MB parts and writes
// Build/awd.split.json, which Build/SplitFileLoader.js uses to reassemble them
// in the browser. Run from the project root: node tools/split-unity-build.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUILD_DIR = path.join(process.cwd(), "Build");
const PART_SIZE = 3_000_000; // decimal 3 MB, safe for hosts that cap at 3 MiB
const FILES = ["awd.data.unityweb", "awd.wasm.code.unityweb"];

function removeOldParts(name) {
  const prefix = `${name}.part`;
  for (const file of fs.readdirSync(BUILD_DIR)) {
    if (file.startsWith(prefix)) {
      fs.rmSync(path.join(BUILD_DIR, file));
    }
  }
}

function splitFile(name) {
  const source = path.join(BUILD_DIR, name);
  const totalSize = fs.statSync(source).size;
  const partCount = Math.ceil(totalSize / PART_SIZE);
  const parts = [];
  const input = fs.openSync(source, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    for (let index = 0; index < partCount; index++) {
      const offset = index * PART_SIZE;
      const size = Math.min(PART_SIZE, totalSize - offset);
      const partName = `${name}.part${String(index).padStart(3, "0")}`;
      const output = fs.openSync(path.join(BUILD_DIR, partName), "w");

      try {
        let written = 0;
        while (written < size) {
          const read = fs.readSync(
            input,
            buffer,
            0,
            Math.min(buffer.length, size - written),
            offset + written
          );
          if (read === 0) throw new Error(`Unexpected end of file: ${source}`);
          fs.writeSync(output, buffer, 0, read);
          written += read;
        }
      } finally {
        fs.closeSync(output);
      }

      parts.push({ name: partName, size });
    }
  } finally {
    fs.closeSync(input);
  }

  return { totalSize, parts };
}

async function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    for await (const chunk of fs.createReadStream(path.join(BUILD_DIR, file))) {
      hash.update(chunk);
    }
  }
  return hash.digest("hex");
}

async function main() {
  const manifest = {
    generatedBy: "tools/split-unity-build.mjs",
    partSize: PART_SIZE,
    files: {},
  };

  for (const name of FILES) {
    const source = path.join(BUILD_DIR, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing ${source}. Run this before deleting the originals.`);
    }

    removeOldParts(name);
    const { totalSize, parts } = splitFile(name);
    const sourceHash = await hashFiles([name]);
    const rebuiltHash = await hashFiles(parts.map((part) => part.name));

    if (sourceHash !== rebuiltHash) {
      throw new Error(`Checksum mismatch while splitting ${name}`);
    }
    if (parts.some((part) => part.size > PART_SIZE)) {
      throw new Error(`A part of ${name} is larger than ${PART_SIZE} bytes`);
    }

    manifest.files[name] = {
      name,
      size: totalSize,
      sha256: sourceHash,
      parts,
    };

    console.log(
      `${name}: ${totalSize} bytes -> ${parts.length} parts (sha256 ${sourceHash})`
    );
  }

  const manifestPath = path.join(BUILD_DIR, "awd.split.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
