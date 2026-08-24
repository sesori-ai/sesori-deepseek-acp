import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  nodeAssetName,
  releaseArchiveName,
  targetDefinitions,
  verifyChecksumManifest,
} from "./package-release.mjs";
import { createChecksumManifest } from "./release-checksums.mjs";

test("release target names pin all six official Node artifacts", () => {
  assert.deepEqual(Object.keys(targetDefinitions).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
  ]);
  assert.equal(nodeAssetName({ nodeVersion: "24.19.0", target: "darwin-arm64" }), "node-v24.19.0-darwin-arm64.tar.xz");
  assert.equal(nodeAssetName({ nodeVersion: "24.19.0", target: "windows-x64" }), "node-v24.19.0-win-x64.zip");
  assert.equal(releaseArchiveName({ adapterVersion: "0.1.0", target: "linux-x64" }), "sesori-deepseek-acp-v0.1.0-linux-x64.tar.gz");
  assert.equal(releaseArchiveName({ adapterVersion: "0.1.0", target: "windows-arm64" }), "sesori-deepseek-acp-v0.1.0-windows-arm64.zip");
});

test("Node checksum verification requires one exact official entry", () => {
  const digest = "a".repeat(64);
  assert.doesNotThrow(() => verifyChecksumManifest({
    manifest: `${digest}  node-v24.19.0-linux-x64.tar.xz\n`,
    assetName: "node-v24.19.0-linux-x64.tar.xz",
    digest,
  }));
  assert.throws(() => verifyChecksumManifest({
    manifest: `${"b".repeat(64)}  node-v24.19.0-linux-x64.tar.xz\n`,
    assetName: "node-v24.19.0-linux-x64.tar.xz",
    digest,
  }), /checksum mismatch/u);
});

test("release checksum aggregation rejects missing targets and emits sorted hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sesori-release-test-"));
  try {
    for (const target of Object.keys(targetDefinitions)) {
      const directory = join(root, target);
      await mkdir(directory);
      const name = releaseArchiveName({ adapterVersion: "0.1.0", target });
      const archive = join(directory, name);
      await writeFile(archive, target);
      const hash = createHash("sha256").update(target).digest("hex");
      await writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
    }
    const output = join(root, "checksums.txt");
    await createChecksumManifest({ input: root, output, adapterVersion: "0.1.0" });
    const lines = (await readFile(output, "utf8")).trim().split("\n");
    const expected = Object.keys(targetDefinitions).sort().map((target) => {
      const name = releaseArchiveName({ adapterVersion: "0.1.0", target });
      return `${createHash("sha256").update(target).digest("hex")}  ${name}`;
    });
    assert.deepEqual(lines, expected);

    await rm(join(root, "windows-arm64"), { recursive: true });
    await assert.rejects(
      createChecksumManifest({ input: root, output, adapterVersion: "0.1.0" }),
      /Expected exactly one .*windows-arm64/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
