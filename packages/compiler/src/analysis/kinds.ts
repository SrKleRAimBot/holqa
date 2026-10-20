import type {
  QueueBackoff,
  ResourceKind,
  ResourceKindMap,
  StandardSchemaV1,
  TriggerKind,
  TriggerKindMap
} from "@holqa/core";

import {
  isStandardSchema,
  queueBackoffProblem,
  requiredCapabilities
} from "@holqa/core";

import {
  definedEntries,
  FieldReader
} from "@/analysis/fields";

/** `/`, or a path of non-empty segments that starts with `/` and does not end with one. */
const basePathPattern = { expression: /^\/$|^(?:\/[\w.~-]+)+$/, description: "\"/\" or a path such as \"/api\" that starts with \"/\" and does not end with one" };

/** A route path: `/`, or segments that are literal (`orders`) or parameters (`:orderId`). */
const routePathPattern = { expression: /^\/$|^(?:\/(?:[\w.~-]+|:[a-z_]\w*))+$/i, description: "\"/\" or a path such as \"/orders/:orderId\" without a trailing \"/\"" };

/** A five-field cron expression. */
const cronPattern = { expression: /^[\w*?,/-]+(?: [\w*?,/-]+){4}$/, description: "a five-field cron expression separated by single spaces" };

/** A resource's normalized settings, the capabilities they require, and its schemas by role. */
export interface NormalizedResourceKind<Kind extends ResourceKind> {
  readonly config: ResourceKindMap[Kind]["config"];
  readonly requirements: ResourceKindMap[Kind]["requirements"];
  /** Capabilities a binding needs to fulfil the resource, for example `queue.dead-letter`. */
  readonly capabilities: readonly string[];
}

/** Reads one kind's config and requirements. */
type ResourceKindRule<Kind extends ResourceKind> = (config: unknown, requirements: unknown, reader: FieldReader) => NormalizedResourceKind<Kind>;

/**
 * One rule per resource kind. The mapped type makes adding a kind to the core
 * registry without deciding how the compiler normalizes it a compile error.
 */
const resourceKindRules: { readonly [Kind in ResourceKind]: ResourceKindRule<Kind> } = {
  "queue": (config, requirements, reader) => {
    const rawConfig = reader.object(config, "config", ["schemaVersion"]);
    const raw = reader.object(requirements, "requirements", ["delivery", "maxAttempts", "deadLetter", "backoff"]);
    const delivery = reader.oneOf(raw.delivery, "requirements.delivery", ["at-least-once"]);
    const deadLetter = reader.boolean(raw.deadLetter, "requirements.deadLetter");
    const maxAttempts = reader.optionalPositiveInteger(raw.maxAttempts, "requirements.maxAttempts");
    const backoff = raw.backoff === undefined ? undefined : readBackoff(raw.backoff, reader);
    const normalized = { delivery, deadLetter, ...definedEntries({ maxAttempts, backoff }) };
    return {
      config: { schemaVersion: reader.positiveInteger(rawConfig.schemaVersion, "config.schemaVersion") },
      requirements: normalized,
      capabilities: requiredCapabilities({ kind: "queue", requirements: normalized })
    };
  },
  "bucket": (config, requirements, reader) => {
    reader.object(config, "config", []);
    const raw = reader.object(requirements, "requirements", ["access"]);
    const access = reader.oneOf(raw.access, "requirements.access", ["private", "public-read"]);
    return { config: {}, requirements: { access }, capabilities: requiredCapabilities({ kind: "bucket", requirements: { access } }) };
  },
  "schedule": (config, requirements, reader) => {
    const rawConfig = reader.object(config, "config", ["cron", "timezone"]);
    const raw = reader.object(requirements, "requirements", ["overlap"]);
    const overlap = reader.oneOf(raw.overlap, "requirements.overlap", ["skip", "allow"]);
    return {
      config: { cron: reader.string(rawConfig.cron, "config.cron", cronPattern), timezone: reader.string(rawConfig.timezone, "config.timezone") },
      requirements: { overlap },
      capabilities: requiredCapabilities({ kind: "schedule", requirements: { overlap } })
    };
  },
  "http.api": (config, requirements, reader) => {
    const rawConfig = reader.object(config, "config", ["basePath", "docs"]);
    reader.object(requirements, "requirements", []);
    const basePath = reader.string(rawConfig.basePath, "config.basePath", basePathPattern);
    if (rawConfig.docs === undefined)
      return { config: { basePath }, requirements: {}, capabilities: requiredCapabilities({ kind: "http.api", requirements: {} }) };
    const docs = reader.object(rawConfig.docs, "config.docs", ["title", "version"]);
    return {
      config: { basePath, docs: { title: reader.string(docs.title, "config.docs.title"), version: reader.string(docs.version, "config.docs.version") } },
      requirements: {},
      capabilities: requiredCapabilities({ kind: "http.api", requirements: {} })
    };
  }
};

/**
 * Reads a queue's declared backoff.
 *
 * @param value - The untrusted `requirements.backoff` value.
 * @param reader - Collects problems.
 * @returns The normalized backoff; problems are recorded in `reader`.
 */
function readBackoff(value: unknown, reader: FieldReader): QueueBackoff {
  const raw = reader.object(value, "requirements.backoff", ["strategy", "delaySeconds", "initialDelaySeconds", "maxDelaySeconds", "multiplier"]);
  const strategy = reader.oneOf(raw.strategy, "requirements.backoff.strategy", ["fixed", "exponential"]);
  const backoff: QueueBackoff = strategy === "fixed"
    ? { strategy, delaySeconds: reader.nonNegativeNumber(raw.delaySeconds, "requirements.backoff.delaySeconds") }
    : {
      strategy: "exponential",
      initialDelaySeconds: reader.nonNegativeNumber(raw.initialDelaySeconds, "requirements.backoff.initialDelaySeconds"),
      maxDelaySeconds: reader.nonNegativeNumber(raw.maxDelaySeconds, "requirements.backoff.maxDelaySeconds"),
      ...definedEntries({ multiplier: raw.multiplier === undefined ? undefined : reader.nonNegativeNumber(raw.multiplier, "requirements.backoff.multiplier") })
    };
  // The rules the SDK and the manifest JSON Schema apply too (maximum not below the initial delay, multiplier of at least 1).
  const problem = reader.problems.length === 0 ? queueBackoffProblem(backoff) : undefined;
  if (problem !== undefined)
    reader.problems.push(`"requirements.backoff" is invalid: ${problem}.`);
  return backoff;
}

/**
 * Normalizes a resource's untrusted `config` and `requirements` for its kind,
 * keeping only known settings and deriving the capabilities they require.
 *
 * @param kind - Which registered kind's rule to apply, for example `queue`.
 * @param config - The untrusted `config` object from the descriptor.
 * @param requirements - The descriptor's `requirements`.
 * @returns The normalized settings, capabilities and every problem found.
 */
export function normalizeResourceKind<Kind extends ResourceKind>(kind: Kind, config: unknown, requirements: unknown): NormalizedResourceKind<Kind> & { readonly problems: readonly string[] } {
  const reader = new FieldReader();
  const rule = resourceKindRules[kind] as ResourceKindRule<Kind>;
  return { ...rule(config, requirements, reader), problems: reader.problems };
}

/** A trigger's normalized options and the capability it requires. */
export interface NormalizedTriggerKind<Trigger extends TriggerKind> {
  readonly options: TriggerKindMap[Trigger]["options"];
  readonly capabilities: readonly string[];
}

/** Reads one trigger kind's options. */
type TriggerKindRule<Trigger extends TriggerKind> = (options: unknown, reader: FieldReader) => TriggerKindMap[Trigger]["options"];

/** One option rule per trigger kind; adding a trigger kind without one is a compile error. */
const triggerKindRules: { readonly [Trigger in TriggerKind]: TriggerKindRule<Trigger> } = {
  "queue.message": (options, reader) => {
    const raw = reader.object(options, "options", ["concurrency"]);
    return definedEntries({ concurrency: reader.optionalPositiveInteger(raw.concurrency, "options.concurrency") });
  },
  "bucket.object-created": (options, reader) => {
    const raw = reader.object(options, "options", ["prefix"]);
    return definedEntries({ prefix: reader.optionalString(raw.prefix, "options.prefix") });
  },
  "bucket.object-deleted": (options, reader) => {
    const raw = reader.object(options, "options", ["prefix"]);
    return definedEntries({ prefix: reader.optionalString(raw.prefix, "options.prefix") });
  },
  "schedule.tick": (options, reader) => {
    reader.object(options, "options", []);
    return {};
  },
  "http.route": (options, reader) => {
    const raw = reader.object(options, "options", ["method", "path"]);
    return {
      method: reader.oneOf(raw.method, "options.method", ["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: reader.string(raw.path, "options.path", routePathPattern)
    };
  },
  "http.procedure": (options, reader) => {
    const raw = reader.object(options, "options", ["operation"]);
    return { operation: reader.oneOf(raw.operation, "options.operation", ["query", "mutation"]) };
  }
};

/**
 * Normalizes a trigger's untrusted options for its kind.
 *
 * @param kind - Which registered trigger kind's rule to apply, for example `queue.message`.
 * @param options - The untrusted `options` object from the trigger.
 * @returns The normalized options, the capability `trigger.<kind>`, and every problem found.
 */
export function normalizeTriggerKind<Trigger extends TriggerKind>(kind: Trigger, options: unknown): NormalizedTriggerKind<Trigger> & { readonly problems: readonly string[] } {
  const reader = new FieldReader();
  const rule = triggerKindRules[kind] as TriggerKindRule<Trigger>;
  return { options: rule(options, reader), capabilities: [`trigger.${kind}`], problems: reader.problems };
}

/** Which schema roles a declaration may have. */
interface SchemaRoleSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** Whether a `responses` record of schemas keyed by HTTP status is allowed; its entries become `response.<status>` roles. */
  readonly responses: boolean;
}

/** No schemas at all. */
const noSchemas: SchemaRoleSpec = { required: [], optional: [], responses: false };

/** The schema roles of each resource kind. */
const resourceSchemaRoles: { readonly [Kind in ResourceKind]: SchemaRoleSpec } = {
  "queue": { required: ["message"], optional: [], responses: false },
  "bucket": noSchemas,
  "schedule": noSchemas,
  "http.api": noSchemas
};

/** The schema roles of each trigger kind. */
const triggerSchemaRoles: { readonly [Trigger in TriggerKind]: SchemaRoleSpec } = {
  "queue.message": { required: ["message"], optional: [], responses: false },
  "bucket.object-created": { required: ["object"], optional: [], responses: false },
  "bucket.object-deleted": { required: ["object"], optional: [], responses: false },
  "schedule.tick": noSchemas,
  "http.route": { required: [], optional: ["params", "query", "body", "headers"], responses: true },
  "http.procedure": { required: ["output"], optional: ["input"], responses: false }
};

/**
 * Lists the problems with a set of schema role names for a resource or
 * trigger kind: missing required roles and roles the kind does not have.
 * Used to check manifests read from outside the compiler.
 *
 * @param declaration - Whether `kind` names a resource kind or a trigger kind.
 * @param kind - The kind whose role specification applies.
 * @param roles - The role names present, for example `message` or `response.200`.
 * @returns One sentence per problem; empty when the roles fit the kind.
 */
export function schemaRoleProblems(declaration: "resource" | "trigger", kind: string, roles: readonly string[]): string[] {
  const spec: SchemaRoleSpec | undefined = declaration === "resource"
    ? (resourceSchemaRoles as Readonly<Record<string, SchemaRoleSpec>>)[kind]
    : (triggerSchemaRoles as Readonly<Record<string, SchemaRoleSpec>>)[kind];
  if (spec === undefined)
    return [`"${kind}" is not a registered ${declaration} kind`];
  return [
    ...spec.required.filter(role => !roles.includes(role)).map(role => `must have the "${role}" schema`),
    ...roles.filter(role => !spec.required.includes(role) && !spec.optional.includes(role) && !(spec.responses && /^response\.[1-5]\d\d$/.test(role))).map(role => `must not have a "${role}" schema`)
  ];
}

/** A schema together with the role it plays in a declaration. */
export interface SchemaRole {
  /** The role, for example `message` or `response.200`. */
  readonly role: string;
  readonly schema: StandardSchemaV1;
}

/**
 * Lists a resource's schemas by role, sorted by role.
 *
 * @param kind - Which registered kind's roles apply, for example `queue`.
 * @param schemas - The untrusted `schemas` object from the descriptor.
 * @returns The schemas and every problem found (unknown or missing roles, non-schemas).
 */
export function resourceSchemas(kind: ResourceKind, schemas: unknown): { readonly roles: readonly SchemaRole[]; readonly problems: readonly string[] } {
  return schemaRoles(schemas, resourceSchemaRoles[kind]);
}

/**
 * Lists a handler's schemas by role, sorted by role.
 *
 * @param kind - Which registered trigger kind's roles apply.
 * @param schemas - The untrusted `schemas` object from the handler descriptor.
 * @returns The schemas and every problem found.
 */
export function triggerSchemas(kind: TriggerKind, schemas: unknown): { readonly roles: readonly SchemaRole[]; readonly problems: readonly string[] } {
  return schemaRoles(schemas, triggerSchemaRoles[kind]);
}

/**
 * Reads a `schemas` object according to a role specification.
 *
 * @param schemas - The untrusted `schemas` object.
 * @param spec - The allowed roles.
 * @returns The schemas sorted by role, and every problem found.
 */
function schemaRoles(schemas: unknown, spec: SchemaRoleSpec): { readonly roles: readonly SchemaRole[]; readonly problems: readonly string[] } {
  const reader = new FieldReader();
  const raw: Readonly<Record<string, unknown>> = reader.object(schemas, "schemas", [...spec.required, ...spec.optional, ...spec.responses ? ["responses"] : []]);
  const roles: SchemaRole[] = [];
  for (const role of [...spec.required, ...spec.optional]) {
    const schema = raw[role];
    if (schema === undefined) {
      if (spec.required.includes(role))
        reader.problems.push(`"schemas.${role}" is required.`);
    } else if (isStandardSchema(schema)) {
      roles.push({ role, schema });
    } else {
      reader.problems.push(`"schemas.${role}" must be a Standard Schema.`);
    }
  }
  const { responses } = raw as { readonly responses?: unknown };
  if (spec.responses && responses !== undefined) {
    const statuses = typeof responses === "object" && responses !== null ? Object.keys(responses).filter(status => /^[1-5]\d\d$/.test(status)) : [];
    const byStatus: Readonly<Record<string, unknown>> = reader.object(responses, "schemas.responses", statuses);
    for (const status of statuses) {
      const schema = byStatus[status];
      if (isStandardSchema(schema))
        roles.push({ role: `response.${status}`, schema });
      else
        reader.problems.push(`"schemas.responses.${status}" must be a Standard Schema.`);
    }
  }
  roles.sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
  return { roles, problems: reader.problems };
}