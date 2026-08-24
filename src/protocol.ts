import { PROTOCOL_VERSION, type InitializeResponse } from "@agentclientprotocol/sdk";

export const ADAPTER_NAME = "sesori-deepseek-acp";
export const ADAPTER_TITLE = "Sesori DeepSeek";
export const ADAPTER_VERSION = "0.1.0";
export const DEEPSEEK_HARNESS_VERSION = "0.1.1-rc.2";
export const ACP_SDK_VERSION = "0.25.1";
export const EXTENSION_PROTOCOL_VERSION = 1;
export const INITIALIZE_METADATA_KEY = "sesori.ai/deepseek";

export interface DeepSeekInitializeMetadata {
  extensionProtocolVersion: typeof EXTENSION_PROTOCOL_VERSION;
  adapterVersion: typeof ADAPTER_VERSION;
  harnessVersion: typeof DEEPSEEK_HARNESS_VERSION;
  persistenceOwner: "sesori";
}

export function createInitializeMetadata(): DeepSeekInitializeMetadata {
  return {
    extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    adapterVersion: ADAPTER_VERSION,
    harnessVersion: DEEPSEEK_HARNESS_VERSION,
    persistenceOwner: "sesori",
  };
}

export function createInitializeResponse(): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { list: {}, close: {} },
    },
    agentInfo: {
      name: ADAPTER_NAME,
      title: ADAPTER_TITLE,
      version: ADAPTER_VERSION,
    },
    authMethods: [],
    _meta: { [INITIALIZE_METADATA_KEY]: createInitializeMetadata() },
  };
}

export function formatVersion(): string {
  return `${ADAPTER_NAME}/${ADAPTER_VERSION} deepseek-harness/${DEEPSEEK_HARNESS_VERSION} acp/${PROTOCOL_VERSION}`;
}
