import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSubagentBindingStore } from "../src/subagent_bindings.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file sub-agent binding store", () => {
  it("persists bindings per parent under hashed names and reads them back", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sesori-bindings-"));
    roots.push(temporaryRoot);
    const root = join(temporaryRoot, "bindings");
    const store = createFileSubagentBindingStore({ root });
    await Promise.all([
      store.record({ parentId: "parent/one", toolCallId: "call-1", childSessionId: "child-1" }),
      store.record({ parentId: "parent/one", toolCallId: "call-2", childSessionId: "child-2" }),
      store.record({ parentId: "other", toolCallId: "call-1", childSessionId: "child-x" }),
    ]);

    expect(await readdir(root)).toHaveLength(2);
    expect((await readdir(root)).every((name) => /^[0-9a-f]{64}\.json$/u.test(name))).toBe(true);
    await expect(store.load({ parentId: "parent/one" })).resolves.toEqual(new Map([["call-1", "child-1"], ["call-2", "child-2"]]));
    await expect(store.load({ parentId: "unknown" })).resolves.toEqual(new Map());
  });

  it("serializes a load behind a pending binding write", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sesori-bindings-"));
    roots.push(temporaryRoot);
    const store = createFileSubagentBindingStore({ root: join(temporaryRoot, "bindings") });

    const recording = store.record({ parentId: "parent", toolCallId: "call", childSessionId: "child" });
    const loaded = store.load({ parentId: "parent" });

    await expect(loaded).resolves.toEqual(new Map([["call", "child"]]));
    await recording;
  });
});
