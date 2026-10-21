/** Typed client for the platform API, used with a console user's access token. */

/** Platform API base. "/api" is proxied by Vite (dev), nginx (Docker) or a Vercel rewrite; set VITE_API_URL to call the platform directly. */
export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Role = "OWNER" | "ADMIN" | "DEVELOPER" | "APPROVER";

export interface Membership {
  orgId: string;
  orgName: string;
  domain: string;
  verificationStatus: "PENDING" | "VERIFIED";
  status: "ACTIVE" | "SUSPENDED";
  role: Role;
}

export interface Me {
  userId: string;
  email: string;
  platformAdmin: boolean;
  organizations: Membership[];
}

export interface Org {
  id: string;
  name: string;
  domain: string;
  verificationStatus: string;
  status: string;
  verificationRecord: string | null;
}

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  version: string;
  endpointUrl: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
}

export interface AgentKey {
  kid: string;
  publicKey: string;
  revoked: boolean;
}

export interface Card {
  agentId: string;
  card: string;
  kid: string;
  signature: string;
  publishedAt: string;
}

export interface Policy {
  allowedCapabilities: string[];
  maxBudgetPerTask: string | number;
  approvalThreshold: string | number;
  currency: string;
  rateLimitPerMinute: number;
}

export interface AuditEvent {
  id: string;
  taskId: string | null;
  type: string;
  actor: string;
  requesterOrgId: string | null;
  providerOrgId: string | null;
  requestHash: string | null;
  responseHash: string | null;
  details: string | null;
  createdAt: string;
}

export interface DayActivity {
  date: string;
  grantsIssued: number;
  grantsDenied: number;
  receipts: number;
}

export interface AdminOverview {
  organizations: { total: number; verified: number; pending: number; suspended: number };
  agents: { total: number; active: number; suspended: number; liveKeys: number; revokedKeys: number };
  taskTypes: number;
  grantsIssued: number;
  grantsDenied: number;
  receipts: number;
  activity: DayActivity[];
}

export interface AdminEvent {
  id: string;
  type: string;
  actor: string;
  taskId: string | null;
  requesterOrg: string | null;
  providerOrg: string | null;
  details: string | null;
  createdAt: string;
}

export interface AdminOrg {
  id: string;
  name: string;
  domain: string;
  verificationStatus: "PENDING" | "VERIFIED";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  members: number;
  agents: number;
  activeAgents: number;
  lastActivity: string | null;
  certifier: boolean;
}

/** The latest conformance-suite result for one task-type version of an agent. */
export interface Certification {
  id: string;
  agentId: string;
  orgId: string;
  taskType: string;
  taskTypeVersion: number;
  status: "PASSED" | "FAILED" | "REVOKED";
  valid: boolean;
  suiteVersion: string;
  checksPassed: number;
  checksTotal: number;
  createdAt: string;
  expiresAt: string;
  revokedReason: string | null;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

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

export interface UsageRecord {
  taskId: string;
  role: "provider" | "requester";
  counterpartyOrgId: string;
  counterpartyName: string;
  capability: string;
  amount: number;
  currency: string;
  connection: "direct" | "relayed";
  completedAt: string;
}

export interface OrgUsage {
  period: string;
  totals: { role: "provider" | "requester"; currency: string; tasks: number; amount: number }[];
  records: UsageRecord[];
}

export interface PayoutLine {
  orgId: string;
  orgName: string;
  currency: string;
  tasks: number;
  gross: number;
  fee: number;
  net: number;
  relayedTasks: number;
  paid: { id: string; net: number; reference: string; paidBy: string; paidAt: string } | null;
}

export class Api {
  constructor(private readonly token: string | null) {}

  /** Fetches a file (e.g. a CSV export) with the session's credentials. */
  async download(path: string): Promise<Blob> {
    const res = await fetch(API_BASE + path, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, "http_error", `Download failed (${res.status})`);
    return res.blob();
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? "http_error", json?.message ?? `Request failed (${res.status})`);
    return json as T;
  }

  login = (email: string, password: string) => this.call<{ accessToken: string }>("POST", "/auth/login", { email, password });
  register = (r: { email: string; password: string; orgName: string; domain: string }) =>
    this.call<{ accessToken: string }>("POST", "/auth/register", r);
  me = () => this.call<Me>("GET", "/me");

  org = (id: string) => this.call<Org>("GET", `/orgs/${id}`);
  allOrgs = () => this.call<Org[]>("GET", "/orgs");
  verifyOrg = (id: string, method: "dns" | "manual") => this.call<Org>("POST", `/orgs/${id}/verify`, { method });
  setOrgStatus = (id: string, status: "ACTIVE" | "SUSPENDED") => this.call<Org>("POST", `/orgs/${id}/status`, { status });

  agents = (orgId: string) => this.call<Agent[]>("GET", `/agents?orgId=${orgId}`);
  createAgent = (a: { orgId: string; name: string; version: string; endpointUrl: string }) => this.call<Agent>("POST", "/agents", a);
  keys = (agentId: string) => this.call<AgentKey[]>("GET", `/agents/${agentId}/keys`);
  addKey = (agentId: string, publicKey: string) => this.call<AgentKey>("POST", `/agents/${agentId}/keys`, { publicKey });
  revokeKey = (agentId: string, kid: string) => this.call<AgentKey>("DELETE", `/agents/${agentId}/keys/${kid}`);
  setAgentStatus = (agentId: string, status: "ACTIVE" | "SUSPENDED") => this.call<Agent>("POST", `/agents/${agentId}/status`, { status });
  card = (agentId: string) => this.call<Card>("GET", `/agents/${agentId}/card`);
  certifications = (agentId: string) => this.call<Certification[]>("GET", `/agents/${agentId}/certifications`);

  policy = (orgId: string) => this.call<Policy>("GET", `/orgs/${orgId}/policy`);
  updatePolicy = (orgId: string, p: Policy) => this.call<Policy>("PUT", `/orgs/${orgId}/policy`, p);

  approvals = (orgId: string, status?: ApprovalStatus) =>
    this.call<Approval[]>("GET", `/approvals?orgId=${orgId}${status ? `&status=${status}` : ""}`);
  decideApproval = (id: string, decision: Exclude<ApprovalStatus, "PENDING">, comment?: string) =>
    this.call<Approval>("POST", `/approvals/${id}/decision`, { decision, comment });

  adminOverview = (days = 14) => this.call<AdminOverview>("GET", `/admin/overview?days=${days}`);
  adminEvents = (limit = 25) => this.call<AdminEvent[]>("GET", `/admin/events?limit=${limit}`);
  adminOrgs = () => this.call<AdminOrg[]>("GET", "/admin/organizations");
  usage = (orgId: string, period: string) => this.call<OrgUsage>("GET", `/orgs/${orgId}/usage?period=${period}`);
  adminPayouts = (period: string) => this.call<PayoutLine[]>("GET", `/admin/payouts?period=${period}`);
  markPaid = (p: { orgId: string; period: string; currency: string; reference: string }) => this.call<unknown>("POST", "/admin/payouts", p);
  adminCertifications = (limit = 50) => this.call<Certification[]>("GET", `/admin/certifications?limit=${limit}`);
  revokeCertification = (id: string, reason: string) => this.call<Certification>("POST", `/admin/certifications/${id}/revoke`, { reason });
  setCertifier = (orgId: string, certifier: boolean) => this.call<unknown>("PUT", `/admin/organizations/${orgId}/certifier`, { certifier });

  audit = (orgId: string, taskId?: string) =>
    this.call<AuditEvent[]>("GET", `/audit?orgId=${orgId}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`);
}
