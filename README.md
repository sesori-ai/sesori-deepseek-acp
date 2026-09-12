# Sesori DeepSeek ACP

Sesori's managed ACP runtime adapter for DeepSeek Harness. It composes the
complete coding runtime behind an ACP v1 stdio boundary without changing the
user's DeepSeek settings or storing Sesori sessions in the DeepSeek profile.
The adapter creates and loads the application-owned
`$DSH_HOME/profiles/sesori` profile so plugins installed for Sesori participate
in the managed runtime. DeepSeek's provider may also initialize its standard
`.anonymous-user-id` during an API request.

```sh
npm ci
npm run check
node dist/src/bin.js --version
node dist/src/bin.js check --state-dir /absolute/writable/directory
node dist/src/bin.js serve --state-dir /absolute/writable/directory
```

`serve` reserves stdout for ACP NDJSON. Local diagnostics use stderr and never
include protocol frames, prompts, transcripts, credentials, or tool payloads.

## Sesori profile plugins

Install DeepSeek plugin bundles into the dedicated profile with the normal
Harness command:

```sh
dsh plugin --profile sesori add <package>
```

Bundle and profile patches load before Sesori's mandatory state, telemetry,
hot-reload, sandbox, approval, and transport constraints. Profile membership
and patch changes take effect on the next adapter start. If the profile cannot
be created, read, composed, prepared, or started, the adapter reports the local
failure on stderr and continues with its pinned in-memory profile.

DeepSeek plugins are trusted local process code. They can independently access
source files, prompts, credentials, and the network; installing one into the
`sesori` profile grants that access. Plugins installed only in another profile,
such as `web` or `headless`, are not loaded automatically.

Runtime uses DeepSeek Harness `0.1.5-rc.2`, including canonical
`deepseek-flash` (`DeepSeek-V41-Flash`) catalog metadata, native model selection,
outbound `web_search` and `web_fetch` tools, and native persisted-session format
migration. Outbound web tools do not expose a local web server, frontend, BFF,
or additional process. Telemetry and hot reload remain disabled. Adapter-owned
sessions, attachments, query indexes, storage documents, and spill files remain
under supplied `--state-dir`. The adapter does not change DeepSeek settings or
credentials; an explicitly installed plugin controls its own behavior.

Tagged releases contain target-specific package-directory archives with a
pinned official Node runtime, production dependencies, CycloneDX SBOM, license
inventory, and relocatable launcher. Release CI builds and smokes each archive
on its matching macOS, Linux, or Windows architecture before publication. The
checked-in Node digest and official checksum manifest must agree. Smoke covers
native loading, relocation, prompt streaming, history, close, and restart/load
through the packaged launcher without a system Node on its `PATH`.
