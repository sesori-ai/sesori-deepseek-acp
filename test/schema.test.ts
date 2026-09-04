import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import schema from "../protocol/v2/deepseek-acp.schema.json" with { type: "json" };
import { EXTENSION_PROTOCOL_VERSION } from "../src/protocol.ts";
import {
  type FixtureEntry,
  validateFixtureCorpus,
  validateProtocolValue,
} from "../src/schema.ts";

const validPath = new URL("../protocol/v2/fixtures/valid.json", import.meta.url);
const invalidPath = new URL("../protocol/v2/fixtures/invalid.json", import.meta.url);

async function fixture(args: { path: URL }): Promise<FixtureEntry[]> {
  return JSON.parse(await readFile(args.path, "utf8")) as FixtureEntry[];
}

describe("DeepSeek extension schema", () => {
  it("serves the schema generation matching the advertised extension protocol version", () => {
    expect(schema.$id).toBe(`https://sesori.ai/protocol/v${EXTENSION_PROTOCOL_VERSION}/deepseek-acp.schema.json`);
    expect(validPath.pathname).toContain(`/protocol/v${EXTENSION_PROTOCOL_VERSION}/`);
  });

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

  it("bounds live and replayed prompts to 32,768 Unicode scalar values", () => {
    const maxPrompt = "😀".repeat(32_768);
    const started = {
      kind: "started",
      sessionId: "session-1",
      childSessionId: "child-1",
      toolCallId: "call-1",
      label: "Probe child",
      prompt: maxPrompt,
      mode: "foreground",
    };
    const replay = {
      label: "Probe child",
      prompt: maxPrompt,
      mode: "background",
    };

    const history = (subagent: Record<string, unknown>) => ({
      updates: [
        {
          sessionId: "session-1",
          update: { sessionUpdate: "tool_call", toolCallId: "call-1" },
          _meta: { "sesori.ai/deepseek": { subagent } },
        },
      ],
      hasMore: false,
    });

    expect(validateProtocolValue({ definition: "subagentNotification", value: started }).valid).toBe(true);
    expect(validateProtocolValue({ definition: "historyResponse", value: history(replay) }).valid).toBe(true);
    for (const prompt of [undefined, "   ", "😀".repeat(32_769), "\ud800"]) {
      expect(
        validateProtocolValue({
          definition: "subagentNotification",
          value: { ...started, prompt },
        }).valid,
      ).toBe(false);
      expect(
        validateProtocolValue({
          definition: "historyResponse",
          value: history({ ...replay, prompt }),
        }).valid,
      ).toBe(false);
    }
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
          extensionProtocolVersion: 2,
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
