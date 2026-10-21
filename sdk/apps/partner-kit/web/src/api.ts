/** Client for the node's operator API (/ui/*). */

export interface NodeInfo {
  agent: { name: string; agentId: string; orgId: string; publicUrl: string };
  provides: string[];
  requests: string[];
  outbound: { currency?: string; defaultBudget?: string };
  counts: { inbound: number; outbound: number; openQuestions: number; receipts: number };
}

export interface Task {
  id: string;
  direction: "inbound" | "outbound";
  peerAgentId: string;
  peerName: string | null;
  capability: string;
  taskTypeVersion: number;
  state: string;
  rounds: number;
  budget: string | null;
  currency: string | null;
  approvalRequired: boolean;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  round: number;
  sender: "us" | "peer";
  kind: string;
  state: string | null;
  data: Record<string, unknown> | null;
  withheld: string[] | null;
  createdAt: string;
}

export interface Receipt {
  round: number;
  state: string;
  signed: { receipt: Record<string, unknown>; providerKid: string; providerSignature: string; requesterKid?: string; requesterSignature?: string };
  countersigned: boolean;
  recorded: boolean;
  createdAt: string;
}

export interface Question {
  id: number;
  taskId: string;
  round: number;
  question: { question: string; field?: string; options?: string[] };
  answer: string | null;
  status: string;
  createdAt: string;
  capability?: string;
  peerName?: string | null;
}

export interface Disclosure {
  capability: string;
  version: number;
  contractFields: string[];
  allowed: string[];
}

export interface Connector {
  name: string;
  kind: string;
  ok: boolean;
  items?: number;
  detail?: string;
}

export interface Supplier {
  agentId: string;
  orgName: string;
  orgDomain: string;
  name: string;
}

export interface AuditEntry {
  id: number;
  event: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NodeApi {
  constructor(private readonly token: string | null) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.message ?? `Request failed (${res.status})`);
    return json as T;
  }

  login = (password: string) => this.call<{ token: string }>("POST", "/ui/login", { password });
  me = () => this.call<NodeInfo>("GET", "/ui/me");
  tasks = (direction?: "inbound" | "outbound") => this.call<Task[]>("GET", `/ui/tasks${direction ? `?direction=${direction}` : ""}`);
  task = (id: string) => this.call<{ task: Task; messages: Message[]; receipts: Receipt[] }>("GET", `/ui/tasks/${encodeURIComponent(id)}`);
  questions = (status = "open") => this.call<Question[]>("GET", `/ui/questions?status=${status}`);
  answer = (id: number, answer: string | null) =>
    this.call<{ ok: boolean }>("POST", `/ui/questions/${id}/answer`, answer === null ? { decline: true } : { answer });
  discover = (capability: string) => this.call<Supplier[]>("GET", `/ui/discover?capability=${encodeURIComponent(capability)}`);
  startOutbound = (r: { capability: string; request: Record<string, unknown>; budget: string; currency: string; providerAgentIds?: string[] }) =>
    this.call<{ providers: { agentId: string; orgName: string }[] }>("POST", "/ui/outbound", r);
  disclosure = () => this.call<Disclosure[]>("GET", "/ui/disclosure");
  setDisclosure = (capability: string, fields: string[]) => this.call<{ allowed: string[] }>("PUT", `/ui/disclosure/${encodeURIComponent(capability)}`, { fields });
  connectors = () => this.call<Connector[]>("GET", "/ui/connectors");
  audit = (limit = 100) => this.call<AuditEntry[]>("GET", `/ui/audit?limit=${limit}`);
}
