import { isAbsolute, resolve } from "node:path";
import { type Readable, type Writable } from "node:stream";
import { checkReadiness } from "./check.js";
import {
  AdapterError,
  AdapterErrorCode,
  AdapterExitCode,
  formatDiagnostic,
} from "./errors.js";
import { formatVersion } from "./protocol.js";
import { serveStdio } from "./server.js";

const CliMode = {
  Check: "check",
  Help: "help",
  Serve: "serve",
  Version: "version",
} as const;

type CliInvocation =
  | { mode: typeof CliMode.Help | typeof CliMode.Version }
  | { mode: typeof CliMode.Check | typeof CliMode.Serve; stateDir: string };

const usage = `Usage:
  sesori-deepseek-acp --version
  sesori-deepseek-acp check --state-dir <absolute-path>
  sesori-deepseek-acp serve --state-dir <absolute-path>
`;

function usageError(args: { message: string }): AdapterError {
  return new AdapterError({
    code: AdapterErrorCode.Usage,
    exitCode: AdapterExitCode.Usage,
    message: `${args.message}\n${usage}`,
  });
}

export function parseCliArgs(args: { argv: readonly string[] }): CliInvocation {
  if (args.argv.length === 1 && args.argv[0] === "--version") return { mode: CliMode.Version };
  if (
    args.argv.length === 1 &&
    (args.argv[0] === "--help" || args.argv[0] === "-h" || args.argv[0] === "help")
  ) {
    return { mode: CliMode.Help };
  }

  const command = args.argv[0];
  if (command !== CliMode.Check && command !== CliMode.Serve) {
    throw usageError({ message: "Expected check, serve, or --version" });
  }
  if (args.argv.length !== 3 || args.argv[1] !== "--state-dir" || args.argv[2] === undefined) {
    throw usageError({ message: `${command} requires --state-dir <absolute-path>` });
  }
  if (!isAbsolute(args.argv[2])) {
    throw usageError({ message: "--state-dir must be an absolute path" });
  }
  return { mode: command, stateDir: resolve(args.argv[2]) };
}

export async function runCli(args: {
  argv: readonly string[];
  input: Readable;
  output: Writable;
  diagnostics: Writable;
}): Promise<AdapterExitCode> {
  try {
    const invocation = parseCliArgs({ argv: args.argv });
    switch (invocation.mode) {
      case CliMode.Help:
        args.output.write(usage);
        return AdapterExitCode.Success;
      case CliMode.Version:
        args.output.write(`${formatVersion()}\n`);
        return AdapterExitCode.Success;
      case CliMode.Check: {
        const report = await checkReadiness({ stateDir: invocation.stateDir });
        args.output.write(`${JSON.stringify({ status: "ok", ...report, version: formatVersion() })}\n`);
        return AdapterExitCode.Success;
      }
      case CliMode.Serve:
        await checkReadiness({ stateDir: invocation.stateDir });
        await serveStdio({ input: args.input, output: args.output, diagnostics: args.diagnostics });
        return AdapterExitCode.Success;
    }
  } catch (error) {
    args.diagnostics.write(`${formatDiagnostic({ error })}\n`);
    return error instanceof AdapterError ? error.exitCode : AdapterExitCode.Failure;
  }
}
