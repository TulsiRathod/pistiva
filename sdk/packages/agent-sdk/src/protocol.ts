/** Wire formats shared by requesters, providers and the platform. */

export const ENVELOPE_VERSION = 1;
export const GRANT_TYP = "pistiva-grant+jwt";
export const AGENT_ASSERTION_TYP = "pistiva-agent+jwt";

export interface PriceModel {
  model: "per_task" | "per_call" | "quote";
  /** Decimal string; floats are not allowed in signed documents. */
  amount: string;
  currency: string;
}

export interface CardCapability {
  /** A registered task type, e.g. "quote.request". */
  name: string;
  /** The registered contract version this agent implements. */
  version: number;
  description?: string;
  price?: PriceModel;
  /** Fields this agent will ever disclose; defaults to every property of the contract's result schema. */
  responseFields?: string[];
}

export interface AgentCard {
  agentId: string;
  orgId: string;
  kid: string;
  name: string;
  version: string;
  endpoint: string;
  protocols: string[];
  capabilities: CardCapability[];
  issuedAt: number;
}

export interface DiscoveredAgent {
  agentId: string;
  orgId: string;
  orgName: string;
  orgDomain: string;
  orgVerified: boolean;
  card: AgentCard;
  kid: string;
  signature: string;
  publicKey: string;
  /** Whether the agent passed the conformance suite for the advertised version of the queried capability. */
  certified?: boolean;
}

/** A conformance-suite result recorded on the platform; the latest per task-type version decides. */
export interface Certification {
  id: string;
  agentId: string;
  orgId: string;
  taskType: string;
  taskTypeVersion: number;
  status: "PASSED" | "FAILED" | "REVOKED";
  /** Passed, not expired and not revoked. */
  valid: boolean;
  suiteVersion: string;
  checksPassed: number;
  checksTotal: number;
  reportHash: string;
  certifierAgentId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface AgentKeyView {
  kid: string;
  publicKey: string;
  revoked: boolean;
}

export interface AgentStatus {
  agentId: string;
  orgId: string;
  status: "ACTIVE" | "SUSPENDED";
  orgTrusted: boolean;
  keys: AgentKeyView[];
}

export interface IssuedGrant {
  taskId: string;
  jti: string;
  grant: string;
  expiresAt: string;
  approvalRequired: boolean;
}

export interface GrantClaims extends Record<string, unknown> {
  iss: string;
  /** Requesting agent. */
  sub: string;
  /** Providing agent. */
  aud: string;
  jti: string;
  tid: string;
  cap: string;
  /** Task-type contract version both sides must use. */
  ttv: number;
  bud: string;
  cur: string;
  apr: boolean;
  rorg: string;
  porg: string;
  /** Present when a human approval backs this grant (commitments above the approval threshold). */
  apv?: string;
  fld: string[];
  iat: number;
  exp: number;
}

/** Message kinds defined by task-type contracts. */
export type MessageKind = "request" | "clarification" | "answer" | "result";

/** A2A task states. */
export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";

export const TERMINAL_STATES: readonly TaskState[] = ["completed", "failed", "canceled", "rejected"];

export interface EnvelopeHeader {
  v: typeof ENVELOPE_VERSION;
  msgId: string;
  taskId: string;
  from: string;
  to: string;
  kid: string;
  capability: string;
  iat: number;
  exp: number;
  nonce: string;
  idempotencyKey: string;
  /** Present on requests: the platform-issued task grant. */
  grant?: string;
  /** Present on responses: msgId of the request being answered. */
  inReplyTo?: string;
  /** Contract message kind and round number, for A2A multi-turn tasks. */
  kind?: MessageKind;
  round?: number;
}

export interface Envelope<B = unknown> {
  header: EnvelopeHeader;
  body: B;
  /** Sender's Ed25519 signature over canonical({header, body}). */
  signature: string;
}

/** Evidence for one message round. The task's final receipt is the one in a terminal state. */
export interface Receipt {
  taskId: string;
  grantId: string;
  round: number;
  state: TaskState;
  requesterAgentId: string;
  providerAgentId: string;
  capability: string;
  taskTypeVersion: number;
  requestHash: string;
  responseHash: string;
  issuedAt: number;
}

export interface SignedReceipt {
  receipt: Receipt;
  providerKid: string;
  providerSignature: string;
  requesterKid?: string;
  requesterSignature?: string;
}

export interface TaskResponse<B = unknown> {
  envelope: Envelope<B>;
  receipt: SignedReceipt;
}

export interface TaskError {
  error: string;
  message: string;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

/** A human decision on a commitment, made by a member of the requesting organization. */
export interface Approval {
  id: string;
  orgId: string;
  requesterAgentId: string;
  providerAgentId: string;
  capability: string;
  reference: string;
  amount: string;
  currency: string;
  summary: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  used: boolean;
}