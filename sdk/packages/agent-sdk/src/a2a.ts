/**
 * The subset of the A2A protocol (JSON-RPC 2.0 binding) the network speaks, plus the pistiva-trust
 * extension that carries our signatures, grants and receipts inside A2A metadata. Agents that
 * ignore the extension can still read cards and tasks; agents on this network require it.
 */
import type { Envelope, EnvelopeHeader, MessageKind, SignedReceipt, TaskState } from "./protocol.ts";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export const PISTIVA_TRUST_EXTENSION = "https://pistiva.ai/a2a/ext/pistiva-trust/v1";
export const A2A_PATH = "/a2a";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
/** The metadata key under which pistiva-trust data travels on messages and tasks. */
export const PISTIVA_TRUST = "pistiva-trust";

export interface TextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | DataPart;

export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  taskId?: string;
  contextId?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: A2AMessage; timestamp: string };
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions: { uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }[];
  };
  securitySchemes?: Record<string, unknown>;
  security?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse<R> =
  | { jsonrpc: "2.0"; id: string | number | null; result: R }
  | { jsonrpc: "2.0"; id: string | number | null; error: JsonRpcError };

/** JSON-RPC and A2A error codes. */
export const RpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
  /** Application range: trust failures (bad signature, revoked key, replay, grant mismatch). */
  unauthorized: -32010,
  forbidden: -32011,
  conflict: -32012,
} as const;

/** pistiva-trust data on a requester's message: the signed envelope header and signature over its parts. */
export interface MessageTrust {
  header: EnvelopeHeader;
  signature: string;
}

/** pistiva-trust data on a provider's task: signature over {state, parts} of this round, plus the round's receipt. */
export interface TaskTrust {
  header: EnvelopeHeader;
  signature: string;
  receipt: SignedReceipt;
}

/** The signed body of a provider's reply for one round. */
export interface RoundResponseBody {
  state: TaskState;
  parts: Part[];
}

export function dataPart(data: Record<string, unknown>, kind: MessageKind): DataPart {
  return { kind: "data", data, metadata: { "pistiva.kind": kind } };
}

/** The single data part every contract message carries. */
export function singleDataPart(parts: Part[] | undefined): Record<string, unknown> | undefined {
  const data = (parts ?? []).filter((p): p is DataPart => p?.kind === "data");
  return data.length === 1 && data[0]!.data && typeof data[0]!.data === "object" ? data[0]!.data : undefined;
}

/** Rebuilds the signed envelope a requester's message represents. */
export function messageEnvelope(message: A2AMessage): Envelope<Part[]> | undefined {
  const trust = message?.metadata?.[PISTIVA_TRUST] as MessageTrust | undefined;
  if (!trust?.header || typeof trust.signature !== "string") return undefined;
  return { header: trust.header, body: message.parts, signature: trust.signature };
}

/** Rebuilds the signed envelope a provider's task represents for its latest round. */
export function taskEnvelope(task: A2ATask): Envelope<RoundResponseBody> | undefined {
  const trust = task?.metadata?.[PISTIVA_TRUST] as TaskTrust | undefined;
  if (!trust?.header || typeof trust.signature !== "string") return undefined;
  return { header: trust.header, body: { state: task.status.state, parts: task.status.message?.parts ?? [] }, signature: trust.signature };
}

