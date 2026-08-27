import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type FixtureEntry,
  validateFixtureCorpus,
  validateProtocolValue,
} from "../src/schema.ts";

const validPath = new URL("../protocol/v1/fixtures/valid.json", import.meta.url);
const invalidPath = new URL("../protocol/v1/fixtures/invalid.json", import.meta.url);

async function fixture(args: { path: URL }): Promise<FixtureEntry[]> {
  return JSON.parse(await readFile(args.path, "utf8")) as FixtureEntry[];
}

describe("DeepSeek extension schema", () => {
  it("accepts every valid fixture", async () => {
    const results = validateFixtureCorpus({ corpus: await fixture({ path: validPath }) });
    expect(results).not.toHaveLength(0);
    expect(results.every((result) => result.valid)).toBe(true);
  });

  it("rejects every invalid fixture", async () => {
    expect(
      validateFixtureCorpus({ corpus: await fixture({ path: invalidPath }) }).every(
        (result) => !result.valid,
      ),
    ).toBe(true);
  });

  it("rejects unknown status variants", () => {
    expect(
      validateProtocolValue({
        definition: "sessionStatusNotification",
        value: { sessionId: "session-1", kind: "future_status" },
      }).valid,
    ).toBe(false);
  });

  it("rejects history updates without the standard ACP envelope", () => {
    expect(
      validateProtocolValue({
        definition: "historyResponse",
        value: { updates: [{}], hasMore: false },
      }).valid,
    ).toBe(false);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid message creation time %s",
    (messageCreatedAt) => {
      expect(
        validateProtocolValue({
          definition: "historyResponse",
          value: {
            updates: [
              {
                sessionId: "session-1",
                update: { sessionUpdate: "agent_message_chunk" },
                _meta: { "sesori.ai/deepseek": { messageCreatedAt } },
              },
            ],
            hasMore: false,
          },
        }).valid,
      ).toBe(false);
    },
  );

  it("preserves nullable ACP envelope metadata", () => {
    expect(
      validateProtocolValue({
        definition: "historyResponse",
        value: {
          updates: [
            {
              sessionId: "session-1",
              update: { sessionUpdate: "agent_message_chunk" },
              _meta: null,
            },
          ],
          hasMore: false,
        },
      }).valid,
    ).toBe(true);
  });

  it("accepts POSIX, Windows drive, and UNC absolute paths", () => {
    for (const cwd of ["/synthetic/project", "C:\\synthetic\\project", "\\\\synthetic\\project"]) {
      expect(validateProtocolValue({ definition: "catalogRequest", value: { cwd } }).valid).toBe(true);
    }
  });

  it("allows unknown optional initialize metadata", () => {
    expect(
      validateProtocolValue({
        definition: "initializeMetadata",
        value: {
          extensionProtocolVersion: 1,
          adapterVersion: "0.1.0",
          harnessVersion: "0.1.1-rc.2",
          persistenceOwner: "sesori",
          futureCapability: { enabled: true },
        },
      }).valid,
    ).toBe(true);
  });

  it("returns bounded structural diagnostics without invalid values", () => {
    const sentinel = `SENTINEL_PRIVATE_VALUE_9f1f_${"x".repeat(257)}`;
    const result = validateProtocolValue({
      definition: "promptMetadata",
      value: { messageId: sentinel },
    });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    if (!result.valid) {
      expect(result.errors.every((error) => error.definition === "promptMetadata")).toBe(true);
      expect(result.errors.every((error) => error.path.length <= 256)).toBe(true);
      expect(result.errors.every((error) => error.keyword.length <= 64)).toBe(true);
    }
  });
});
