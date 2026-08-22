#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
});
