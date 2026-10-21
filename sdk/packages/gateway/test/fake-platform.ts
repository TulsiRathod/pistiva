import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GRANT_TYP,
  generateKeyPair,
  kidFor,
  signJws,
  verifyReceiptSignature,
  type AgentKeyPair,
  type AgentStatus,
  type IssuedGrant,
  type Jwks,
  type PlatformClient,
  type PlatformLookup,
  type SignedReceipt,
  type TaskTypeContract,
} from "@pistiva/agent-sdk";

/** The platform's bundled pack, so tests validate against exactly what production serves. */
const PACK = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../platform/src/main/resources/domain-packs/procurement-v1.json", import.meta.url)), "utf8"),
);

/** Same shaping as TaskTypeService: each message schema gets the dialect and the pack's $defs inlined. */
function contractFromPack(name: string, version: number): TaskTypeContract {
  const t = PACK.taskTypes.find((x: { name: string; version: number }) => x.name === name && x.version === version);
  if (!t) throw new Error(`unknown task type ${name}@${version}`);
  const messages = Object.fromEntries(
    Object.entries(t.messages as Record<string, object>).map(([k, s]) => [
      k,
      { $schema: "https://json-schema.org/draft/2020-12/schema", ...s, $defs: PACK.$defs },
    ]),
  );
  return { ...t, pack: PACK.pack, messages } as TaskTypeContract;
}

export interface FakeAgent {
  agentId: string;
  orgId: string;
  kid: string;
  keys: AgentKeyPair;
}

/** In-memory stand-in for the control plane: agent status, JWKS and grant issuing. */
export class FakePlatform implements PlatformLookup {
  readonly issuer = "pistiva-platform";
  readonly receipts: SignedReceipt[] = [];
  private readonly platformKeys = generateKeyPair();
  private readonly platformKid = "platform-test";
  private readonly statuses = new Map<string, AgentStatus>();

  registerAgent(): FakeAgent {
    const keys = generateKeyPair();
    const agent = { agentId: randomUUID(), orgId: randomUUID(), kid: kidFor(keys.publicKey), keys };
    this.statuses.set(agent.agentId, {
      agentId: agent.agentId,
      orgId: agent.orgId,
      status: "ACTIVE",
      orgTrusted: true,
      keys: [{ kid: agent.kid, publicKey: keys.publicKey, revoked: false }],
    });
    return agent;
  }

  revokeKey(agent: FakeAgent): void {
    this.statuses.get(agent.agentId)!.keys.forEach((k) => (k.revoked = true));
  }

  suspend(agent: FakeAgent): void {
    this.statuses.get(agent.agentId)!.status = "SUSPENDED";
  }

  async agentStatus(agentId: string): Promise<AgentStatus> {
    const status = this.statuses.get(agentId);
    if (!status) throw new Error("unknown agent");
    return structuredClone(status);
  }

  async taskType(name: string, version: number): Promise<TaskTypeContract> {
    return contractFromPack(name, version);
  }

  async jwks(): Promise<Jwks> {
    return { keys: [{ kty: "OKP", crv: "Ed25519", kid: this.platformKid, x: this.platformKeys.publicKey }] };
  }

  issueGrant(opts: {
    requester: FakeAgent;
    provider: FakeAgent;
    capability: string;
    fields?: string[];
    expiresIn?: number;
    audience?: string;
    subject?: string;
    taskId?: string;
    taskTypeVersion?: number;
  }): IssuedGrant {
    const now = Math.floor(Date.now() / 1000);
    const taskId = opts.taskId ?? randomUUID();
    const jti = randomUUID();
    const exp = now + (opts.expiresIn ?? 300);
    const grant = signJws(
      GRANT_TYP,
      this.platformKid,
      {
        iss: this.issuer,
        sub: opts.subject ?? opts.requester.agentId,
        aud: opts.audience ?? opts.provider.agentId,
        jti,
        tid: taskId,
        cap: opts.capability,
        ttv: opts.taskTypeVersion ?? 1,
        bud: "100.00",
        cur: "INR",
        apr: false,
        rorg: opts.requester.orgId,
        porg: opts.provider.orgId,
        fld: opts.fields ?? [],
        iat: now,
        exp,
      },
      this.platformKeys,
    );
    return { taskId, jti, grant, expiresAt: new Date(exp * 1000).toISOString(), approvalRequired: false };
  }

  /** A requester-side PlatformClient double that issues grants and checks receipts like the real platform. */
  clientFor(agent: FakeAgent, provider: FakeAgent, fields: string[]): PlatformClient {
    const client = {
      issuer: this.issuer,
      agentId: agent.agentId,
      kid: agent.kid,
      requestGrant: async (req: { capability: string; continueTaskId?: string }) =>
        this.issueGrant({ requester: agent, provider, capability: req.capability, fields, taskId: req.continueTaskId }),
      taskType: (name: string, version: number) => this.taskType(name, version),
      agentStatus: (id: string) => this.agentStatus(id),
      jwks: () => this.jwks(),
      submitReceipt: async (signed: SignedReceipt) => {
        const ok =
          verifyReceiptSignature(signed.receipt, provider.keys.publicKey, signed.providerSignature) &&
          verifyReceiptSignature(signed.receipt, agent.keys.publicKey, signed.requesterSignature);
        if (!ok) throw new Error("receipt signatures do not verify");
        this.receipts.push(signed);
        return { taskId: signed.receipt.taskId, status: signed.receipt.state, alreadyRecorded: false };
      },
    };
    return client as unknown as PlatformClient;
  }
}
