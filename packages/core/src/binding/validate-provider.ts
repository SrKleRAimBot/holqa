import type {
  AnyBindingProvider,
  BindingServiceName
} from "@/binding/provider";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { ResourceKind } from "@/resources/kinds";

import {
  bindingProtocolVersion,
  contractVersionProblem,
  isBindingContractName,
  mandatoryBindingContracts
} from "@/binding/contracts";
import { bindingFailure } from "@/binding/failures";
import {
  isCredentialReference,
  isProviderId
} from "@/binding/provider";
import { extensionReferenceProblems } from "@/extensions/extension";
import { isJsonValue } from "@/json";
import {
  isResourceKind,
  resourceKinds
} from "@/resources/kinds";

/** Every service a provider may supply, by name. The `satisfies` clause fails to compile when a service is missing. */
const serviceSet = { "config": true, "telemetry": true, "idempotency": true, "operation-budgets": true } as const satisfies Record<BindingServiceName, true>;

/** An untrusted object whose named fields are read. */
type Fields<Name extends string> = { readonly [Field in Name]?: unknown };

/** Matches a provider instance name: segments of lowercase letters, digits and hyphens, separated by dots. */
const namePattern = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

/** Matches a capability name in the required-capability vocabulary, for example `queue.backoff.exponential`. */
const capabilityPattern = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

/**
 * Checks a provider declaration in depth, without opening it: the protocol
 * version, identifiers, role, contract versions, advertised capabilities,
 * services, emulations, topology, settings and credential references. A
 * provider that passes can be selected, inspected and recorded in a binding
 * manifest; whether it satisfies an application's requirements is a separate
 * check.
 *
 * @param value - The candidate provider, typically from a binding configuration module.
 * @returns Every problem found: `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` for a protocol or contract version
 * this version of Holqa does not implement, `HOLQA_BINDING_CONFIG_INVALID` for everything else. Empty when the provider is valid.
 */
export function validateProvider(value: unknown): readonly Diagnostic[] {
  if (typeof value !== "object" || value === null)
    return [bindingFailure("configuration", { binding: "unknown", message: "A binding provider must be an object created by a provider factory, such as local.platform()." })];
  const candidate = value as Partial<Record<keyof AnyBindingProvider, unknown>>;
  const name = typeof candidate.name === "string" && candidate.name !== "" ? candidate.name : "unknown";
  const problems: Diagnostic[] = [];
  /**
   * Records a malformed part of the declaration.
   *
   * @param message - What is wrong.
   */
  const invalid = (message: string): void => {
    problems.push(bindingFailure("configuration", { binding: name, message: `Provider "${name}": ${message}` }));
  };
  /**
   * Records an incompatible version.
   *
   * @param message - What is incompatible.
   */
  const incompatible = (message: string): void => {
    problems.push(bindingFailure("version", { binding: name, message: `Provider "${name}": ${message}`, hint: "Use a release of the provider built for this version of Holqa." }));
  };

  if (candidate.bindingProtocol !== bindingProtocolVersion) {
    incompatible(`it implements version ${JSON.stringify(candidate.bindingProtocol) ?? "(none)"} of the provider protocol, but this version of Holqa implements version ${bindingProtocolVersion}.`);
    return problems;
  }
  if (!isProviderId(candidate.provider))
    invalid("\"provider\" must be a namespaced identifier such as \"holqa.local\" or \"example.queue\".");
  if (typeof candidate.name !== "string" || !namePattern.test(candidate.name) || candidate.name.length > 128)
    invalid("\"name\" must be lowercase letters, digits and hyphens, in dot-separated segments, at most 128 characters.");
  if (typeof candidate.open !== "function")
    invalid("\"open\" must be a function.");
  const role = candidate.role;
  if (role !== "platform" && role !== "resource" && role !== "service")
    invalid("\"role\" must be \"platform\", \"resource\" or \"service\".");

  const contracts = readRecord(candidate.contracts, "contracts", invalid);
  for (const [contract, version] of Object.entries(contracts)) {
    if (!isBindingContractName(contract)) {
      incompatible(`it implements the ${contract} contract, which this version of Holqa does not define.`);
      continue;
    }
    const problem = contractVersionProblem(contract, version);
    if (problem !== undefined)
      incompatible(`${problem}.`);
  }
  /**
   * Reports whether the provider declares a contract.
   *
   * @param contract - The contract's name.
   * @returns `true` when it is declared.
   */
  const declares = (contract: string): boolean => Object.hasOwn(contracts, contract);

  const resources = readRecord(candidate.resources, "resources", invalid);
  const kinds: ResourceKind[] = [];
  for (const [kind, capabilities] of Object.entries(resources)) {
    if (!isResourceKind(kind)) {
      incompatible(`it binds ${kind} resources, a kind this version of Holqa does not define.`);
      continue;
    }
    kinds.push(kind);
    if (!declares(kind))
      invalid(`it binds ${kind} resources but does not declare the ${kind} contract.`);
    for (const problem of capabilityProblems(kind, capabilities))
      invalid(`its ${kind} capabilities are malformed: ${problem}.`);
    if (kind === "bucket" && hasEvents(capabilities) && !declares("bucket.events"))
      invalid("it advertises object events but does not declare the bucket.events contract.");
  }
  const services = readRecord(candidate.services, "services", invalid);
  for (const [service, flag] of Object.entries(services)) {
    if (!Object.hasOwn(serviceSet, service)) {
      incompatible(`it supplies the ${service} service, which this version of Holqa does not define.`);
      continue;
    }
    if (flag !== true)
      invalid(`"services.${service}" must be true.`);
    if (!declares(service))
      invalid(`it supplies the ${service} service but does not declare the ${service} contract.`);
  }
  for (const contract of Object.keys(contracts)) {
    if (!isBindingContractName(contract) || contract === "execution" || contract === "bucket.events")
      continue;
    if (isResourceKind(contract) ? !Object.hasOwn(resources, contract) : !Object.hasOwn(services, contract))
      invalid(`it declares the ${contract} contract but does not ${isResourceKind(contract) ? `bind ${contract} resources` : `supply the ${contract} service`}.`);
  }
  if (declares("bucket.events") && !(Object.hasOwn(resources, "bucket") && hasEvents((resources as Fields<"bucket">).bucket)))
    invalid("it declares the bucket.events contract but advertises no object event types.");

  const execution = candidate.execution;
  if (declares("execution") !== (execution !== undefined))
    invalid("\"execution\" capabilities must be given exactly when the execution contract is declared.");
  if (execution !== undefined) {
    for (const problem of executionProblems(execution))
      invalid(`its execution capabilities are malformed: ${problem}.`);
  }

  if (role === "platform") {
    const missing = mandatoryBindingContracts.filter(contract => !declares(contract));
    if (missing.length > 0)
      invalid(`a platform provider must implement every mandatory contract; it lacks ${missing.join(", ")}.`);
    const unbound = resourceKinds.filter(kind => !kinds.includes(kind));
    if (unbound.length > 0 && missing.length === 0)
      invalid(`a platform provider must bind every resource kind; it lacks ${unbound.join(", ")}.`);
  }
  if (role === "resource" && kinds.length === 0)
    invalid("a resource provider must bind at least one resource kind.");
  const extensions = candidate.extensions;
  if (extensions !== undefined) {
    if (!Array.isArray(extensions)) {
      invalid("\"extensions\" must be a list of extension declarations.");
    } else {
      for (const [index, entry] of (extensions as unknown[]).entries()) {
        for (const problem of extensionReferenceProblems(entry, `extensions[${index}]`))
          invalid(problem);
        const declaration: Fields<"dependsOn" | "runtimes"> = typeof entry === "object" && entry !== null ? entry : {};
        if (declaration.dependsOn !== undefined && !(Array.isArray(declaration.dependsOn) && declaration.dependsOn.every(reference => extensionReferenceProblems(reference, "").length === 0)))
          invalid(`extensions[${index}].dependsOn must be a list of extension references.`);
        if (declaration.runtimes !== undefined && !(Array.isArray(declaration.runtimes) && declaration.runtimes.every(runtime => typeof runtime === "string")))
          invalid(`extensions[${index}].runtimes must be a list of runtime names.`);
      }
    }
  }
  const extensionCount = Array.isArray(extensions) ? extensions.length : 0;
  if (role === "service" && (kinds.length > 0 || Object.keys(services).length + extensionCount === 0))
    invalid("a service provider must supply at least one service or extension and bind no resources.");

  if (candidate.emulations !== undefined) {
    if (!Array.isArray(candidate.emulations)) {
      invalid("\"emulations\" must be a list.");
    } else {
      for (const [index, emulation] of (candidate.emulations as unknown[]).entries()) {
        const entry: Fields<"kind" | "capability" | "mechanism" | "requires"> = typeof emulation === "object" && emulation !== null ? emulation : {};
        if (!isResourceKind(entry.kind) || !kinds.includes(entry.kind))
          invalid(`emulations[${index}] must name a resource kind the provider binds.`);
        if (typeof entry.capability !== "string" || !capabilityPattern.test(entry.capability) || (isResourceKind(entry.kind) && !entry.capability.startsWith(`${entry.kind}.`)))
          invalid(`emulations[${index}].capability must be a capability of its kind, such as "queue.backoff.exponential".`);
        if (typeof entry.mechanism !== "string" || entry.mechanism.trim() === "")
          invalid(`emulations[${index}].mechanism must describe how the capability is emulated.`);
        if (entry.requires !== undefined && !(Array.isArray(entry.requires) && entry.requires.every(item => typeof item === "string")))
          invalid(`emulations[${index}].requires must be a list of descriptions.`);
      }
    }
  }
  if (candidate.topology !== undefined) {
    const topology: Fields<"delivery" | "state" | "connectors"> = typeof candidate.topology === "object" && candidate.topology !== null ? candidate.topology : {};
    if (topology.delivery !== "pull" && topology.delivery !== "push" && topology.delivery !== "none")
      invalid("\"topology.delivery\" must be \"pull\", \"push\" or \"none\".");
    if (topology.state !== "process" && topology.state !== "host" && topology.state !== "shared")
      invalid("\"topology.state\" must be \"process\", \"host\" or \"shared\".");
    if (topology.connectors !== undefined && !(Array.isArray(topology.connectors) && topology.connectors.every(item => typeof item === "string")))
      invalid("\"topology.connectors\" must be a list of descriptions.");
  }
  if (candidate.settings !== undefined && !(isJsonValue(candidate.settings) && typeof candidate.settings === "object" && !Array.isArray(candidate.settings)))
    invalid("\"settings\" must be a plain JSON object.");
  if (candidate.credentials !== undefined && !(Array.isArray(candidate.credentials) && candidate.credentials.every(isCredentialReference)))
    invalid("\"credentials\" must be a list of credential references created with credentialRef.");
  return problems;
}

/**
 * Reads a record-valued field, reporting a non-object.
 *
 * @param value - The field's value.
 * @param field - The field's name, for messages.
 * @param invalid - Records a problem.
 * @returns The record, or an empty one when the value is not an object.
 */
function readRecord(value: unknown, field: string, invalid: (message: string) => void): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  invalid(`"${field}" must be an object.`);
  return {};
}

/**
 * Reports whether bucket capabilities advertise at least one object event type.
 *
 * @param capabilities - Bucket capabilities, unvalidated.
 * @returns `true` when `events` is a non-empty list.
 */
function hasEvents(capabilities: unknown): boolean {
  const events = (capabilities as { readonly events?: unknown } | undefined)?.events;
  return Array.isArray(events) && events.length > 0;
}

/**
 * Checks one kind's advertised capabilities against the shape the kind
 * registry defines, so that a malformed declaration fails here rather than as
 * a confusing capability mismatch later.
 *
 * @param kind - The resource kind.
 * @param value - The advertised capabilities, unvalidated.
 * @returns One sentence per problem.
 */
function capabilityProblems(kind: ResourceKind, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return ["they must be an object"];
  const capabilities = value as Readonly<Record<string, unknown>> & Fields<"deadLetter" | "signedUrls" | "spaFallback">;
  const problems: string[] = [];
  /**
   * Records a problem unless a field is a list drawn from allowed values.
   *
   * @param field - The field's name.
   * @param allowed - The allowed values.
   * @param optional - Whether the field may be absent.
   */
  const list = (field: string, allowed: readonly string[], optional = false): void => {
    const entry = capabilities[field];
    if (optional && entry === undefined)
      return;
    if (!(Array.isArray(entry) && entry.every(item => allowed.includes(item as string))))
      problems.push(`"${field}" must be a list of ${allowed.map(item => `"${item}"`).join(", ")}`);
  };
  /**
   * Records a problem unless a field is a positive whole number.
   *
   * @param field - The field's name.
   * @param optional - Whether the field may be absent.
   */
  const count = (field: string, optional = false): void => {
    const entry = capabilities[field];
    if (optional && entry === undefined)
      return;
    if (!(typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 1))
      problems.push(`"${field}" must be a positive whole number`);
  };
  switch (kind) {
    case "queue":
      list("delivery", ["at-least-once"]);
      count("maxAttempts");
      if (typeof capabilities.deadLetter !== "boolean")
        problems.push("\"deadLetter\" must be a boolean");
      list("backoff", ["fixed", "exponential"], true);
      count("maxDelaySeconds", true);
      count("maxMessageBytes", true);
      break;
    case "bucket": {
      list("access", ["private", "public-read"]);
      list("events", ["object.created", "object.deleted"], true);
      const signed: unknown = capabilities.signedUrls;
      const expiry = typeof signed === "object" && signed !== null ? (signed as Fields<"maxExpiresInSeconds">).maxExpiresInSeconds : undefined;
      if (signed !== undefined && !(typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry >= 1))
        problems.push("\"signedUrls.maxExpiresInSeconds\" must be a positive whole number");
      break;
    }
    case "schedule":
      list("overlap", ["skip", "allow"]);
      break;
    case "http.api":
      break;
    case "static.site":
      if (typeof capabilities.spaFallback !== "boolean")
        problems.push("\"spaFallback\" must be a boolean");
      break;
    default: {
      const unknown: never = kind;
      problems.push(`the kind ${String(unknown)} has no capability check`);
    }
  }
  return problems;
}

/**
 * Checks advertised execution capabilities.
 *
 * @param value - The capabilities, unvalidated.
 * @returns One sentence per problem.
 */
function executionProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null)
    return ["they must be an object"];
  const execution = value as Fields<"runtimes" | "mode" | "maxTimeoutMs" | "maxConcurrency">;
  const problems: string[] = [];
  if (!(Array.isArray(execution.runtimes) && execution.runtimes.length > 0 && execution.runtimes.every(item => typeof item === "string")))
    problems.push("\"runtimes\" must be a non-empty list of runtime names");
  if (execution.mode !== "long-running" && execution.mode !== "request-driven")
    problems.push("\"mode\" must be \"long-running\" or \"request-driven\"");
  for (const field of ["maxTimeoutMs", "maxConcurrency"] as const) {
    const entry = execution[field];
    if (entry !== undefined && !(typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 1))
      problems.push(`"${field}" must be a positive whole number`);
  }
  return problems;
}