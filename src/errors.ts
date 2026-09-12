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

const DIAGNOSTIC_LIMIT = 2_048;
const AGGREGATE_MEMBER_LIMIT = 4;

function bounded(args: { value: string; limit: number }): string {
  if (args.limit <= 0) return "";
  if (args.value.length <= args.limit) return args.value;
  if (args.limit <= 3) return args.value.slice(0, args.limit);
  return `${args.value.slice(0, args.limit - 3)}...`;
}

function formatErrorDetail(args: {
  error: unknown;
  limit: number;
  depth?: number;
  seen?: ReadonlySet<Error>;
}): string {
  if (args.limit <= 0) return "";
  if (!(args.error instanceof Error)) {
    return bounded({ value: String(args.error), limit: args.limit });
  }
  const summary = args.error.stack ?? args.error.message;
  const depth = args.depth ?? 0;
  if (args.seen?.has(args.error) === true) {
    return bounded({ value: `[Circular error: ${args.error.message}]`, limit: args.limit });
  }
  if (
    !(args.error instanceof AggregateError) ||
    args.error.errors.length === 0 ||
    depth >= 4
  ) {
    return bounded({ value: summary, limit: args.limit });
  }

  const seen = new Set(args.seen);
  seen.add(args.error);
  const members = args.error.errors.slice(0, AGGREGATE_MEMBER_LIMIT);
  const omitted = args.error.errors.length - members.length;
  const omittedLine = omitted === 0 ? "" : `\n${String(omitted)} more failures omitted`;
  const labels = members.map((_, index) => `\nFailure ${String(index + 1)}: `);
  const fixedLength = omittedLine.length + labels.reduce((total, label) => total + label.length, 0);
  const summaryLimit = Math.min(384, Math.max(0, Math.floor((args.limit - fixedLength) / 3)));
  const formattedSummary = bounded({ value: summary, limit: summaryLimit });
  let remaining = Math.max(0, args.limit - fixedLength - formattedSummary.length);
  const details = members.map((error, index) => {
    const membersLeft = members.length - index;
    const memberLimit = Math.floor(remaining / membersLeft);
    const detail = formatErrorDetail({
      error,
      limit: memberLimit,
      depth: depth + 1,
      seen,
    });
    remaining -= detail.length;
    return `${labels[index] ?? ""}${detail}`;
  });
  return bounded({
    value: `${formattedSummary}${details.join("")}${omittedLine}`,
    limit: args.limit,
  });
}

export function formatDiagnostic(args: { error: unknown }): string {
  if (args.error instanceof AdapterError) {
    const prefix = `${args.error.code}: ${args.error.message}`;
    if (!(args.error.cause instanceof Error)) {
      return bounded({ value: prefix, limit: DIAGNOSTIC_LIMIT });
    }
    const causePrefix = "\nCaused by: ";
    const cause = formatErrorDetail({
      error: args.error.cause,
      limit: Math.max(0, DIAGNOSTIC_LIMIT - prefix.length - causePrefix.length),
    });
    return bounded({
      value: `${prefix}${causePrefix}${cause}`,
      limit: DIAGNOSTIC_LIMIT,
    });
  }

  if (args.error instanceof Error) {
    return bounded({
      value: `internal_error: ${args.error.stack ?? args.error.message}`,
      limit: DIAGNOSTIC_LIMIT,
    });
  }

  return "internal_error: Unexpected non-error failure";
}
