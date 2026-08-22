export const AdapterErrorCode = {
  Internal: "internal_error",
  Readiness: "readiness_error",
  StatePath: "state_path_error",
  Usage: "usage_error",
} as const;
export type AdapterErrorCode = (typeof AdapterErrorCode)[keyof typeof AdapterErrorCode];

export const AdapterExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
} as const;
export type AdapterExitCode = (typeof AdapterExitCode)[keyof typeof AdapterExitCode];

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly exitCode: AdapterExitCode;

  constructor(args: {
    code: AdapterErrorCode;
    exitCode?: AdapterExitCode;
    message: string;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "AdapterError";
    this.code = args.code;
    this.exitCode = args.exitCode ?? AdapterExitCode.Failure;
  }
}

function bounded(args: { value: string; limit: number }): string {
  return args.value.length <= args.limit ? args.value : `${args.value.slice(0, args.limit - 3)}...`;
}

export function formatDiagnostic(args: { error: unknown }): string {
  if (args.error instanceof AdapterError) {
    const cause = args.error.cause instanceof Error ? args.error.cause.stack : undefined;
    const detail = cause === undefined ? "" : `\nCaused by: ${cause}`;
    return bounded({ value: `${args.error.code}: ${args.error.message}${detail}`, limit: 2_048 });
  }

  if (args.error instanceof Error) {
    return bounded({ value: `internal_error: ${args.error.stack ?? args.error.message}`, limit: 2_048 });
  }

  return "internal_error: Unexpected non-error failure";
}
