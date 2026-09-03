import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable `toolCallId -> childSessionId` bindings per parent session. dsh
 * session logs cannot carry adapter events (its reader refuses unknown
 * non-ignorable types and `append` cannot mark them ignorable), so the binding
 * a live `subagent/start` resolves is kept beside the runtime state and read
 * back when the parent's history is replayed.
 */
export interface SubagentBindingStore {
  record(args: { parentId: string; toolCallId: string; childSessionId: string }): Promise<void>;
  load(args: { parentId: string }): Promise<Map<string, string>>;
}

const BINDINGS_VERSION = 1;
const MAX_BINDINGS_PER_PARENT = 4096;

interface BindingsFile {
  version: typeof BINDINGS_VERSION;
  bindings: Record<string, string>;
}

function parseBindings(text: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as BindingsFile).version !== BINDINGS_VERSION ||
    typeof (parsed as BindingsFile).bindings !== "object" ||
    (parsed as BindingsFile).bindings === null
  ) {
    throw new Error("sub-agent bindings file has an unsupported shape");
  }
  return new Map(
    Object.entries((parsed as BindingsFile).bindings).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function createFileSubagentBindingStore(args: { root: string }): SubagentBindingStore {
  const pathFor = (parentId: string): string =>
    join(args.root, `${createHash("sha256").update(parentId).digest("hex")}.json`);
  const tails = new Map<string, Promise<void>>();
  const read = async (parentId: string): Promise<Map<string, string>> => {
    try {
      return parseBindings(await readFile(pathFor(parentId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return new Map();
      throw error;
    }
  };
  return {
    load: ({ parentId }) => read(parentId),
    record: ({ parentId, toolCallId, childSessionId }) => {
      const previous = tails.get(parentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(async () => {
        const bindings = await read(parentId);
        bindings.delete(toolCallId);
        bindings.set(toolCallId, childSessionId);
        while (bindings.size > MAX_BINDINGS_PER_PARENT) {
          const oldest = bindings.keys().next().value;
          if (oldest === undefined) break;
          bindings.delete(oldest);
        }
        await mkdir(args.root, { recursive: true });
        const path = pathFor(parentId);
        const staging = `${path}.${process.pid}.tmp`;
        const file: BindingsFile = { version: BINDINGS_VERSION, bindings: Object.fromEntries(bindings) };
        await writeFile(staging, JSON.stringify(file), "utf8");
        await rename(staging, path);
      });
      tails.set(parentId, next);
      void next.then(
        () => {
          if (tails.get(parentId) === next) tails.delete(parentId);
        },
        () => undefined,
      );
      return next;
    },
  };
}

export function createMemorySubagentBindingStore(): SubagentBindingStore {
  const parents = new Map<string, Map<string, string>>();
  return {
    record: async ({ parentId, toolCallId, childSessionId }) => {
      const bindings = parents.get(parentId) ?? new Map<string, string>();
      bindings.set(toolCallId, childSessionId);
      parents.set(parentId, bindings);
    },
    load: async ({ parentId }) => new Map(parents.get(parentId) ?? []),
  };
}
