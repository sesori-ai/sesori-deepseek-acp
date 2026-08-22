import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schema from "../protocol/v1/deepseek-acp.schema.json" with { type: "json" };

export type ProtocolDefinition =
  | "initializeMetadata"
  | "promptMetadata"
  | "catalogRequest"
  | "catalogResponse"
  | "historyRequest"
  | "historyResponse"
  | "renameRequest"
  | "renameResponse"
  | "askUserQuestionRequest"
  | "askUserQuestionResponse"
  | "sessionStatusNotification";

export interface FixtureEntry {
  definition: ProtocolDefinition;
  value: unknown;
}

export interface ProtocolDiagnostic {
  definition: ProtocolDefinition;
  path: string;
  keyword: string;
}

export type ProtocolValidationResult =
  | { valid: true }
  | { valid: false; errors: ProtocolDiagnostic[] };

const definitions: readonly ProtocolDefinition[] = [
  "initializeMetadata",
  "promptMetadata",
  "catalogRequest",
  "catalogResponse",
  "historyRequest",
  "historyResponse",
  "renameRequest",
  "renameResponse",
  "askUserQuestionRequest",
  "askUserQuestionResponse",
  "sessionStatusNotification",
];
const definitionSet = new Set<string>(definitions);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validators = Object.fromEntries(
  definitions.map((definition) => [definition, ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` })]),
) as Record<ProtocolDefinition, ValidateFunction>;

function diagnostic(args: {
  definition: ProtocolDefinition;
  error: ErrorObject;
}): ProtocolDiagnostic {
  return {
    definition: args.definition,
    path: args.error.instancePath.slice(0, 256),
    keyword: args.error.keyword.slice(0, 64),
  };
}

export function validateProtocolValue(args: {
  definition: ProtocolDefinition;
  value: unknown;
}): ProtocolValidationResult {
  const validate = validators[args.definition];
  if (validate(args.value)) return { valid: true };
  return {
    valid: false,
    errors: (validate.errors ?? [])
      .slice(0, 16)
      .map((error) => diagnostic({ definition: args.definition, error })),
  };
}

export function validateFixtureCorpus(args: { corpus: unknown }): ProtocolValidationResult[] {
  if (!Array.isArray(args.corpus)) throw new TypeError("Fixture corpus must be an array");
  return args.corpus.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("definition" in entry) ||
      typeof entry.definition !== "string" ||
      !definitionSet.has(entry.definition) ||
      !("value" in entry)
    ) {
      throw new TypeError("Fixture entry must contain a known definition and value");
    }
    return validateProtocolValue({
      definition: entry.definition as ProtocolDefinition,
      value: entry.value,
    });
  });
}
