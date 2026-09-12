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

function formatErrorDetail(args: { error: Error; depth?: number }): string {
  const depth = args.depth ?? 0;
  const summary = bounded({ value: args.error.stack ?? args.error.message, limit: 512 });
  if (!(args.error instanceof AggregateError) || depth >= 2) return summary;
  const children = args.error.errors.slice(0, 4).map((error, index) => {
    const detail = error instanceof Error
      ? formatErrorDetail({ error, depth: depth + 1 })
      : bounded({ value: String(error), limit: 512 });
    return `Failure ${String(index + 1)}: ${detail}`;
  });
  if (args.error.errors.length > children.length) {
    children.push(`${String(args.error.errors.length - children.length)} more failures omitted`);
  }
  return [summary, ...children].join("\n");
}

export function formatDiagnostic(args: { error: unknown }): string {
  if (args.error instanceof AdapterError) {
    const cause = args.error.cause instanceof Error
      ? formatErrorDetail({ error: args.error.cause })
      : undefined;
    const detail = cause === undefined ? "" : `\nCaused by: ${cause}`;
    return bounded({ value: `${args.error.code}: ${args.error.message}${detail}`, limit: 2_048 });
  }

  if (args.error instanceof Error) {
    return bounded({ value: `internal_error: ${args.error.stack ?? args.error.message}`, limit: 2_048 });
  }

  return "internal_error: Unexpected non-error failure";
}
