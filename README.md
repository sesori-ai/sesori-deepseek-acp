# Sesori DeepSeek ACP

Sesori's managed ACP runtime adapter for DeepSeek Harness. The current scaffold
exposes an initialize-only ACP v1 server and the canonical versioned schema for
planned DeepSeek extensions. Full `dsh-base` composition lands in the next
reviewed step and will be applied programmatically at process startup without
modifying the user's DeepSeek profile.

```sh
npm ci
npm run check
node dist/src/bin.js --version
node dist/src/bin.js check --state-dir /absolute/writable/directory
node dist/src/bin.js serve --state-dir /absolute/writable/directory
```

`serve` reserves stdout for ACP NDJSON. Local diagnostics use stderr and never
include protocol frames, prompts, transcripts, credentials, or tool payloads.
