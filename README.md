# Sesori DeepSeek ACP

Sesori's managed ACP runtime adapter for DeepSeek Harness. It composes the
complete coding runtime behind an ACP v1 stdio boundary without changing the
user's DeepSeek settings or storing Sesori sessions in the DeepSeek profile.
DeepSeek's provider may initialize its standard `.anonymous-user-id` there
during an API request.

```sh
npm ci
npm run check
node dist/src/bin.js --version
node dist/src/bin.js check --state-dir /absolute/writable/directory
node dist/src/bin.js serve --state-dir /absolute/writable/directory
```

`serve` reserves stdout for ACP NDJSON. Local diagnostics use stderr and never
include protocol frames, prompts, transcripts, credentials, or tool payloads.

Tagged releases contain target-specific package-directory archives with a
pinned official Node runtime, production dependencies, CycloneDX SBOM, license
inventory, and relocatable launcher. Release CI builds and smokes each archive
on its matching macOS, Linux, or Windows architecture before publication. The
checked-in Node digest and official checksum manifest must agree. Smoke covers
native loading, relocation, prompt streaming, history, close, and restart/load
through the packaged launcher without a system Node on its `PATH`.
