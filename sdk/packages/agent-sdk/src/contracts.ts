import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { MessageKind } from "./protocol.ts";

/** A task-type contract version as served by the platform's registry (GET /task-types/{name}/versions/{v}). */
export interface TaskTypeContract {
  name: string;
  version: number;
  pack: string;
  description: string;
  extension: boolean;
  direction: "requester_to_provider" | "provider_to_requester";
  cardinality: "one_to_one" | "one_to_many";
  handler: string;
  /** Self-contained JSON Schema 2020-12 documents per message kind. */
  messages: Partial<Record<MessageKind, Record<string, unknown>>> & { request: Record<string, unknown>; result: Record<string, unknown> };
}

export interface ContractSource {
  taskType(name: string, version: number): Promise<TaskTypeContract>;
}

export class ContractViolation extends Error {
  constructor(
    readonly kind: MessageKind,
    readonly errors: string[],
  ) {
    super(`${kind} does not match the contract: ${errors.join("; ")}`);
    this.name = "ContractViolation";
  }
}

/**
 * Fetches contracts from the platform registry and validates messages against them. Contract
 * versions are immutable, so compiled validators are cached for the life of the process.
 */
export class ContractRegistry {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly contracts = new Map<string, Promise<TaskTypeContract>>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly source: ContractSource) {}

  get(name: string, version: number): Promise<TaskTypeContract> {
    const key = `${name}@${version}`;
    let contract = this.contracts.get(key);
    if (!contract) {
      contract = this.source.taskType(name, version);
      this.contracts.set(key, contract);
      contract.catch(() => this.contracts.delete(key));
    }
    return contract;
  }

  /** Throws ContractViolation when `data` is not a valid message of this kind. */
  async validate(name: string, version: number, kind: MessageKind, data: unknown): Promise<void> {
    const contract = await this.get(name, version);
    const schema = contract.messages[kind];
    if (!schema) throw new ContractViolation(kind, [`${name}@${version} defines no ${kind} message`]);
    const key = `${name}@${version}#${kind}`;
    let validate = this.validators.get(key);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(key, validate);
    }
    if (!validate(data)) {
      throw new ContractViolation(kind, (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`));
    }
  }

  /** Property names of the contract's result schema: the most a provider could ever disclose. */
  async resultFields(name: string, version: number): Promise<string[]> {
    const props = (await this.get(name, version)).messages.result.properties;
    return props && typeof props === "object" ? Object.keys(props) : [];
  }

  /** Whether the contract allows a clarification round. */
  async allowsClarification(name: string, version: number): Promise<boolean> {
    return !!(await this.get(name, version)).messages.clarification;
  }
}
