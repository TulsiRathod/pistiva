import { AsyncLocalStorage } from "node:async_hooks";
import type { ConnectionKind } from "@pistiva/agent-sdk";

const storage = new AsyncLocalStorage<ConnectionKind>();

/**
 * Runs fn with the kind of connection the request arrived on. Only code inside this process can set it
 * (the peer-to-peer listener does, after inspecting the WebRTC candidate pair), so a remote caller
 * cannot claim to be direct or relayed. Requests outside any context are plain HTTPS.
 */
export function withConnection<T>(kind: ConnectionKind, fn: () => T): T {
  return storage.run(kind, fn);
}

export function currentConnection(): ConnectionKind | undefined {
  return storage.getStore();
}
