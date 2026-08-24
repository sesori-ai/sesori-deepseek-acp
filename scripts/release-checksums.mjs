import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseArchiveName, targetDefinitions } from "./package-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function createChecksumManifest({ input, output, adapterVersion }) {
  const files = await walk(input);
  const lines = [];
  for (const target of Object.keys(targetDefinitions).sort()) {
    const name = releaseArchiveName({ adapterVersion, target });
    const matches = files.filter((path) => basename(path) === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${name}, found ${matches.length}`);
    const checksumFile = `${matches[0]}.sha256`;
    if (!existsSync(checksumFile)) throw new Error(`Missing target checksum evidence for ${name}`);
    const hash = await digest(matches[0]);
    if ((await readFile(checksumFile, "utf8")).trim() !== `${hash}  ${name}`) {
      throw new Error(`Target checksum evidence disagrees for ${name}`);
    }
    lines.push(`${hash}  ${name}`);
  }
  await writeFile(output, `${lines.join("\n")}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--output");
  const input = inputIndex < 0 ? "release-artifacts" : process.argv[inputIndex + 1];
  const output = outputIndex < 0 ? "checksums.txt" : process.argv[outputIndex + 1];
  if (input === undefined || output === undefined) throw new Error("Invalid checksum arguments");
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  await createChecksumManifest({ input: resolve(input), output: resolve(output), adapterVersion: packageMetadata.version });
}
