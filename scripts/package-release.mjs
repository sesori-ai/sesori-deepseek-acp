import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { smokeAcpLifecycle } from "./smoke-release-package.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRootName = "sesori-deepseek-acp";
const maxCommandOutput = 128 * 1024 * 1024;

export const targetDefinitions = Object.freeze({
  "darwin-arm64": { platform: "darwin", arch: "arm64", nodePlatform: "darwin", nodeArch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64", nodePlatform: "darwin", nodeArch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64", nodePlatform: "linux", nodeArch: "arm64" },
  "linux-x64": { platform: "linux", arch: "x64", nodePlatform: "linux", nodeArch: "x64" },
  "windows-arm64": { platform: "win32", arch: "arm64", nodePlatform: "win", nodeArch: "arm64" },
  "windows-x64": { platform: "win32", arch: "x64", nodePlatform: "win", nodeArch: "x64" },
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: maxCommandOutput,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const stderr = options.capture ? result.stderr.trim() : "";
    throw new Error(`${command} exited with code ${String(result.status)}${stderr === "" ? "" : `: ${stderr}`}`);
  }
  return options.capture ? result.stdout : "";
}

export function nodeAssetName({ nodeVersion, target }) {
  const definition = targetDefinitions[target];
  if (definition === undefined) throw new Error(`Unsupported release target: ${target}`);
  const extension = definition.platform === "win32" ? "zip" : "tar.xz";
  return `node-v${nodeVersion}-${definition.nodePlatform}-${definition.nodeArch}.${extension}`;
}

export function releaseArchiveName({ adapterVersion, target }) {
  const extension = target.startsWith("windows-") ? "zip" : "tar.gz";
  return `${packageRootName}-v${adapterVersion}-${target}.${extension}`;
}

export function verifyChecksumManifest({ manifest, assetName, digest }) {
  const matches = manifest
    .split(/\r?\n/u)
    .map((line) => line.match(/^([a-f0-9]{64})  (\S+)$/u))
    .filter((match) => match?.[2] === assetName);
  if (matches.length !== 1 || matches[0]?.[1] !== digest) {
    throw new Error(`Official Node checksum mismatch for ${assetName}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.url.startsWith("https://nodejs.org/dist/")) {
    throw new Error(`Download failed or redirected outside nodejs.org: ${url}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function installOfficialNode({ config, target, temporaryRoot, packageRoot }) {
  const assetName = nodeAssetName({ nodeVersion: config.nodeVersion, target });
  const releaseUrl = `https://nodejs.org/dist/v${config.nodeVersion}`;
  const archivePath = join(temporaryRoot, assetName);
  const manifestPath = join(temporaryRoot, "SHASUMS256.txt");
  await Promise.all([
    download(`${releaseUrl}/${assetName}`, archivePath),
    download(`${releaseUrl}/SHASUMS256.txt`, manifestPath),
  ]);
  const digest = await sha256(archivePath);
  if (config.nodeSha256?.[target] !== digest) {
    throw new Error(`Pinned Node checksum mismatch for ${assetName}`);
  }
  verifyChecksumManifest({
    manifest: await readFile(manifestPath, "utf8"),
    assetName,
    digest,
  });

  const extracted = join(temporaryRoot, "node-extracted");
  await mkdir(extracted);
  run("tar", ["-xf", archivePath, "-C", extracted]);
  const sourceRoot = join(extracted, assetName.replace(/\.(?:tar\.xz|zip)$/u, ""));
  const windows = target.startsWith("windows-");
  const nodeDirectory = join(packageRoot, "node", ...(windows ? [] : ["bin"]));
  await mkdir(nodeDirectory, { recursive: true });
  const sourceExecutable = join(sourceRoot, windows ? "node.exe" : "bin", ...(windows ? [] : ["node"]));
  const packagedExecutable = join(nodeDirectory, windows ? "node.exe" : "node");
  await cp(sourceExecutable, packagedExecutable);
  if (!windows) await chmod(packagedExecutable, 0o755);
  await cp(join(sourceRoot, "LICENSE"), join(packageRoot, "NODE_LICENSE"));
  if (target.startsWith("darwin-")) run("codesign", ["--verify", "--strict", packagedExecutable]);
  return packagedExecutable;
}

async function packageRoots(nodeModules) {
  const discovered = [];
  const visitPackage = async (root) => {
    if (!existsSync(join(root, "package.json"))) return;
    discovered.push(root);
    const nested = join(root, "node_modules");
    if (existsSync(nested)) await visitNodeModules(nested);
  };
  const visitNodeModules = async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(root, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path, { withFileTypes: true })) {
          if (scoped.isDirectory()) await visitPackage(join(path, scoped.name));
        }
      } else {
        await visitPackage(path);
      }
    }
  };
  await visitNodeModules(nodeModules);
  return discovered;
}

function safePackageDirectory(name, version) {
  return `${name.replaceAll("/", "__").replaceAll("@", "")}-${version}`;
}

async function generateThirdPartyInventory(packageRoot) {
  const licenseRoot = join(packageRoot, "THIRD_PARTY_LICENSES");
  await mkdir(licenseRoot);
  const spdxLicenses = await readJson(join(repositoryRoot, "node_modules", "spdx-license-list", "spdx-full.json"));
  const records = new Map();
  for (const root of await packageRoots(join(packageRoot, "node_modules"))) {
    const metadata = await readJson(join(root, "package.json"));
    const key = `${metadata.name}@${metadata.version}`;
    if (records.has(key)) continue;
    const licenseFiles = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..*)?$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const declaredLicense = typeof metadata.license === "string" ? metadata.license : JSON.stringify(metadata.license);
    const destination = safePackageDirectory(metadata.name, metadata.version);
    await mkdir(join(licenseRoot, destination));
    if (licenseFiles.length === 0) {
      const canonical = spdxLicenses[declaredLicense];
      if (canonical?.licenseText === undefined) throw new Error(`${key} has no packaged or canonical license text`);
      await writeFile(join(licenseRoot, destination, "LICENSE.spdx.txt"), `${canonical.licenseText}\n`);
    } else {
      for (const file of licenseFiles) await cp(join(root, file), join(licenseRoot, destination, file));
    }
    records.set(key, {
      name: metadata.name,
      version: metadata.version,
      license: declaredLicense,
      destination,
      source: licenseFiles.length === 0 ? "canonical SPDX text" : "packaged text",
    });
  }
  const lines = [
    "# Third-Party Notices",
    "",
    "This target-specific inventory was generated from the production dependency tree.",
    "Exact license texts are stored below `THIRD_PARTY_LICENSES/`.",
    "The bundled official Node runtime license is stored as `NODE_LICENSE`.",
    "",
    ...[...records.values()]
      .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
      .map((record) => `- ${record.name} ${record.version} (${record.license}; ${record.source}) - \`THIRD_PARTY_LICENSES/${record.destination}/\``),
    "",
  ];
  await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
}

async function generateSbom({ packageRoot, config, target }) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const raw = run(npm, ["sbom", "--omit=dev", "--sbom-format", "cyclonedx"], {
    cwd: packageRoot,
    capture: true,
  });
  const sbom = JSON.parse(raw);
  sbom.components ??= [];
  sbom.components.push({
    type: "application",
    name: "node",
    version: config.nodeVersion,
    "bom-ref": `pkg:generic/node@${config.nodeVersion}`,
    licenses: [{ license: { name: "Node.js license" } }],
  });
  sbom.metadata ??= {};
  sbom.metadata.properties = [
    ...(sbom.metadata.properties ?? []),
    { name: "sesori.release.target", value: target },
    { name: "sesori.consumer.commit", value: config.consumerCommit },
  ];
  await writeFile(join(packageRoot, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
}

async function writeMetadata({ packageRoot, packageMetadata, config, target }) {
  const sourceCommit = process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  await writeFile(
    join(packageRoot, "BUILD-METADATA.json"),
    `${JSON.stringify({
      adapterVersion: packageMetadata.version,
      deepSeekHarnessVersion: config.deepSeekHarnessVersion,
      nodeVersion: config.nodeVersion,
      target,
      sourceCommit,
      protocolSourceCommit: config.protocolSourceCommit,
      consumerRepository: config.consumerRepository,
      consumerCommit: config.consumerCommit,
    }, null, 2)}\n`,
  );
}

function launcherPath(packageRoot, target) {
  return join(packageRoot, target.startsWith("windows-") ? `${packageRootName}.cmd` : packageRootName);
}

function smokeEnvironment({ home, packageRoot, windows }) {
  const environment = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: "enabled",
    SESORI_PACKAGE_ROOT: packageRoot,
  };
  environment.PATH = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "";
  return environment;
}

function runPackagedLauncher({ packageRoot, target, arguments_, environment }) {
  const launcher = launcherPath(packageRoot, target);
  if (!target.startsWith("windows-")) return run(launcher, arguments_, { capture: true, env: environment });
  const command = [launcher, ...arguments_].map((value) => `"${value.replaceAll('"', '""')}"`).join(" ");
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    capture: true,
    env: environment,
  });
}

async function smokePackage({ packageRoot, packageMetadata, config, target, temporaryRoot }) {
  const home = join(temporaryRoot, "empty-dsh-home");
  const state = join(temporaryRoot, "state");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(state, { recursive: true })]);
  const windows = target.startsWith("windows-");
  const environment = smokeEnvironment({ home, packageRoot, windows });
  const version = runPackagedLauncher({ packageRoot, target, arguments_: ["--version"], environment }).trim();
  const expected = `${packageRootName}/${packageMetadata.version} deepseek-harness/${config.deepSeekHarnessVersion} acp/1`;
  if (version !== expected) throw new Error(`Packaged version mismatch: ${version}`);
  const readiness = JSON.parse(
    runPackagedLauncher({
      packageRoot,
      target,
      arguments_: ["check", "--state-dir", state],
      environment,
    }).trim(),
  );
  if (readiness.status !== "ok") throw new Error("Packaged readiness check failed");

  const node = join(packageRoot, "node", ...(windows ? ["node.exe"] : ["bin", "node"]));
  environment.SESORI_PACKAGED_NODE = node;
  const nativeProbe = [
    'import { createRequire } from "node:module";',
    'import { realpathSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    'const require = createRequire(pathToFileURL(`${process.cwd()}/release-probe.cjs`));',
    'require("sharp");',
    ...(target.startsWith("linux-") ? ['require("@deepseek-ai/node-addon-landlock-run");'] : []),
    'const normalized = value => realpathSync(value).toLowerCase();',
    'if (normalized(process.execPath) !== normalized(process.env.SESORI_PACKAGED_NODE)) throw new Error("unpackaged Node");',
  ].join("");
  run(node, ["--input-type=module", "--eval", nativeProbe], {
    cwd: packageRoot,
    env: environment,
    capture: true,
  });
  await smokeAcpLifecycle({
    launcher: launcherPath(packageRoot, target),
    target,
    packageRoot,
    temporaryRoot: join(temporaryRoot, "acp-lifecycle"),
    environment,
  });
}

async function archivePackage({ packageRoot, output, adapterVersion, target }) {
  await mkdir(output, { recursive: true });
  const name = releaseArchiveName({ adapterVersion, target });
  const archive = join(output, name);
  if (target.startsWith("windows-")) {
    run("tar", ["-a", "-cf", archive, "-C", dirname(packageRoot), basename(packageRoot)]);
  } else {
    run("tar", ["-czf", archive, "-C", dirname(packageRoot), basename(packageRoot)]);
  }
  return archive;
}

async function extractArchive({ archive, destination }) {
  await mkdir(destination, { recursive: true });
  run("tar", ["-xf", archive, "-C", destination]);
  const entries = await readdir(destination);
  if (entries.length !== 1 || entries[0] !== packageRootName) {
    throw new Error("Release archive must contain exactly one top-level package directory");
  }
  return join(destination, packageRootName);
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) throw new Error("Invalid arguments");
    values.set(name.slice(2), value);
  }
  return values;
}

export async function packageRelease({ target, output }) {
  const definition = targetDefinitions[target];
  if (definition === undefined) throw new Error(`Unsupported release target: ${target}`);
  if (definition.platform !== process.platform || definition.arch !== process.arch) {
    throw new Error(`${target} must be packaged on ${definition.platform}/${definition.arch}, found ${process.platform}/${process.arch}`);
  }
  const [config, packageMetadata] = await Promise.all([
    readJson(join(repositoryRoot, "release", "config.json")),
    readJson(join(repositoryRoot, "package.json")),
  ]);
  if (packageMetadata.version.includes("-")) throw new Error("Release package version must be stable");
  if (config.deepSeekHarnessVersion !== "0.1.1-rc.2") throw new Error("Unexpected DeepSeek Harness release pin");

  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: repositoryRoot });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sesori-deepseek-release-"));
  try {
    const packageRoot = join(temporaryRoot, packageRootName);
    await mkdir(packageRoot);
    for (const file of ["package-lock.json", "LICENSE"]) await cp(join(repositoryRoot, file), join(packageRoot, file));
    const releasePackageMetadata = { ...packageMetadata };
    delete releasePackageMetadata.devDependencies;
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(releasePackageMetadata, null, 2)}\n`);
    for (const directory of ["dist", "runtime", "protocol"]) {
      await cp(join(repositoryRoot, directory), join(packageRoot, directory), { recursive: true });
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    run(npm, ["ci", "--omit=dev"], { cwd: packageRoot });
    run(npm, ["ls", "--omit=dev", "--all"], { cwd: packageRoot, capture: true });
    const node = await installOfficialNode({ config, target, temporaryRoot, packageRoot });
    const launcherSource = join(repositoryRoot, "release", "launchers", target.startsWith("windows-") ? `${packageRootName}.cmd` : packageRootName);
    const launcher = launcherPath(packageRoot, target);
    await cp(launcherSource, launcher);
    if (!target.startsWith("windows-")) await chmod(launcher, 0o755);
    await Promise.all([
      generateThirdPartyInventory(packageRoot),
      generateSbom({ packageRoot, config, target }),
      writeMetadata({ packageRoot, packageMetadata, config, target }),
    ]);
    const archive = await archivePackage({
      packageRoot,
      output: resolve(output),
      adapterVersion: packageMetadata.version,
      target,
    });
    const extracted = await extractArchive({
      archive,
      destination: join(temporaryRoot, "relocated package α with spaces"),
    });
    await smokePackage({ packageRoot, packageMetadata, config, target, temporaryRoot: join(temporaryRoot, "smoke-source") });
    await smokePackage({ packageRoot: extracted, packageMetadata, config, target, temporaryRoot: join(temporaryRoot, "smoke-relocated") });
    const digest = await sha256(archive);
    await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
    await writeFile(
      join(resolve(output), `${target}-evidence.json`),
      `${JSON.stringify({ target, archive: basename(archive), sha256: digest, node: basename(node) }, null, 2)}\n`,
    );
  } finally {
    if (process.env.SESORI_KEEP_RELEASE_TEMP === undefined) await rm(temporaryRoot, { recursive: true, force: true });
    else console.error(`Retained release staging directory: ${temporaryRoot}`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const arguments_ = parseArguments(process.argv.slice(2));
  const target = arguments_.get("target") ?? process.env.SESORI_RELEASE_TARGET;
  const output = arguments_.get("output") ?? process.env.SESORI_RELEASE_OUTPUT ?? "release-output";
  if (target === undefined) throw new Error("--target or SESORI_RELEASE_TARGET is required");
  await packageRelease({ target, output });
}
