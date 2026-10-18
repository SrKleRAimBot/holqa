import type {
  ApplicationScope,
  HandlerInvoke,
  HttpProcedureOperation,
  InferInput,
  InferOutput,
  InvocationLogger,
  JsonValue,
  ResourceId,
  RpcSuccessEnvelope,
  StandardSchemaV1
} from "@holqa/core";

import type {
  AnyHttpMiddleware,
  CheckMiddlewareChain,
  MiddlewareChainContext
} from "@/http/middleware";
import type { HandlerRegistration } from "@/resources/handle";

import {
  decodeJsonPayload,
  descriptorKey,
  descriptorProtocol,
  diagnosticCodes,
  failWith,
  InputValidationError,
  rpcInputQueryParameter,
  rpcProtocolFormat,
  rpcProtocolVersion,
  rpcVersionHeader,
  validateInput
} from "@holqa/core";

import { middlewareList } from "@/http/middleware";
import { runHttpPipeline } from "@/http/pipeline";
import {
  readJsonBody,
  readRequestPart
} from "@/http/request";
import {
  encodeContractValue,
  jsonResponse,
  responseInvalid
} from "@/http/response";
import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  requireOptions
} from "@/internal/declaration";

/** What a procedure handler receives. `input` is validated before the handler runs. */
export interface ProcedureContext<Input, Context extends object> {
  /** The validated input; `undefined` for procedures without an input schema. */
  readonly input: Input extends StandardSchemaV1 ? InferOutput<Input> : undefined;
  /** The typed context added by middleware. */
  readonly context: Readonly<Context>;
  readonly request: Request;
  readonly url: URL;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  readonly scope: ApplicationScope;
}

/**
 * Options accepted by {@link HttpApiHandle.procedure}.
 *
 * @typeParam Context - The context the API's middleware provides.
 */
export interface ProcedureOptions<
  HandlerId extends string,
  Operation extends HttpProcedureOperation,
  Input extends StandardSchemaV1 | undefined,
  Output extends StandardSchemaV1,
  Middleware extends readonly AnyHttpMiddleware[],
  Context extends object
> {
  /** The procedure's persistent identity; it is also the last segment of its path. */
  readonly id: HandlerId;
  /** `query` for safe reads (callable with GET as well as POST), `mutation` for changes (POST only). */
  readonly operation: Operation;
  readonly input?: Input;
  readonly output: Output;
  /** Middleware for this procedure only; it runs after application and API middleware. */
  readonly middleware?: Middleware & CheckMiddlewareChain<Context, Middleware>;
  /** The implementation. Returns the output in the output schema's input form; it is validated and sent in its output form. */
  readonly handler: (context: ProcedureContext<Input, MiddlewareChainContext<Context, Middleware>>) => NoInfer<InferInput<Output> | Promise<InferInput<Output>>>;
}

/**
 * The client-facing contract of a procedure.
 *
 * @typeParam Operation - `query` or `mutation`.
 * @typeParam Input - The input schema, or `undefined`.
 * @typeParam Output - The output schema.
 */
export interface ProcedureContract<Operation extends HttpProcedureOperation, Input, Output extends StandardSchemaV1> {
  readonly operation: Operation;
  readonly input: Input extends StandardSchemaV1 ? InferInput<Input> : undefined;
  readonly output: InferOutput<Output>;
}

/**
 * A registered RPC procedure. Export it from a handler module.
 *
 * @typeParam ApiId - The API's identifier.
 * @typeParam HandlerId - The procedure's identifier.
 * @typeParam Contract - The procedure's client-facing contract.
 */
export interface HttpProcedure<ApiId extends string, HandlerId extends string, Contract> extends HandlerRegistration<"http.procedure", HandlerId, ApiId> {
  /** Phantom type carrier for client contracts; never present at run time. */
  readonly "~contract"?: Contract;
}

/** The client-facing contract of a procedure registration. */
export type InferProcedureContract<Procedure> = Procedure extends { readonly "~contract"?: infer Contract } ? NonNullable<Contract> : never;

/** What an API handle hands to {@link createProcedure}. */
export interface ProcedureHost {
  readonly apiId: ResourceId;
  /** Returns the middleware to run before the procedure's own: the application's, then the API's. */
  readonly middleware: () => readonly AnyHttpMiddleware[];
}

/** The untyped view of procedure options used at run time. */
interface RuntimeProcedureOptions {
  readonly id: string;
  readonly operation: HttpProcedureOperation;
  readonly input?: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly middleware?: readonly AnyHttpMiddleware[];
  readonly handler: (context: never) => unknown;
}

/**
 * Validates a procedure declaration and builds its registration. The runtime
 * serves it at `<basePath>/rpc/<id>` with the `holqa.rpc/1` protocol.
 *
 * @param host - The API the procedure belongs to.
 * @param options - The procedure declaration.
 * @returns The frozen registration.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` or `HOLQA_DECLARATION_INVALID` for a malformed declaration.
 */
export function createProcedure(host: ProcedureHost, options: RuntimeProcedureOptions): HttpProcedure<string, string, unknown> {
  const raw = requireOptions(options, `procedure of http.api "${host.apiId}"`);
  const problems = new DeclarationProblems(`procedure "${String(raw.id)}" of http.api "${host.apiId}"`);
  const idCandidate = problems.identifier(raw.id, "procedure id");
  problems.oneOf(raw.operation, ["query", "mutation"], "operation");
  if (raw.input !== undefined)
    problems.schema(raw.input, "input");
  problems.schema(raw.output, "output");
  const ownMiddleware = middlewareList(raw.middleware, problems);
  if (typeof raw.handler !== "function")
    problems.invalid("\"handler\" must be a function.");
  const id = problems.valid(idCandidate);
  const subject = `procedure "${id}"`;

  /**
   * Checks the protocol version, runs the middleware chain, decodes and
   * validates the input, calls the handler and wraps its validated output in
   * a success envelope.
   *
   * @param input - The untrusted `{ request, params }` from the runtime.
   * @param context - The invocation context.
   * @returns The response with a `holqa.rpc/1` success envelope.
   */
  const invoke: HandlerInvoke<"http.procedure"> = async (input, context) => runHttpPipeline(input, context, [...host.middleware(), ...ownMiddleware], async (args) => {
    const validated = await readRequestPart(async () => {
      const version = args.request.headers.get(rpcVersionHeader);
      if (version !== null && version !== rpcProtocolVersion)
        failWith(diagnosticCodes.rpcVersionUnsupported, `The RPC protocol version "${version}" is not supported; this runtime implements version ${rpcProtocolVersion}.`, `Send ${rpcVersionHeader}: ${rpcProtocolVersion}, or omit the header.`);
      const received = args.request.method === "GET" ? queryInput(args.url, subject) : envelopeInput(await readJsonBody(args.request, `request of ${subject}`), subject);
      if (options.input !== undefined)
        return validateInput(options.input, received, `input of ${subject}`);
      if (received !== undefined)
        throw new InputValidationError(`input of ${subject}`, [{ message: "This procedure takes no input.", path: "" }]);
      return undefined;
    });
    const output: unknown = await options.handler({ ...args, input: validated } as never);
    let payload: JsonValue | undefined;
    try {
      payload = await encodeContractValue(options.output, output, `output of ${subject}`);
    } catch (error) {
      throw responseInvalid(`The output of ${subject} does not match its schema.`, error);
    }
    const envelope: RpcSuccessEnvelope = { format: rpcProtocolFormat, ok: true, ...payload === undefined ? {} : { output: payload } };
    return jsonResponse(200, envelope, undefined, `response of ${subject}`);
  });

  return Object.freeze({
    [descriptorKey]: Object.freeze({
      protocol: descriptorProtocol,
      type: "handler" as const,
      definition: freezeJson({
        id,
        trigger: { kind: "http.procedure" as const, resource: { kind: "http.api" as const, id: host.apiId }, options: { operation: options.operation } }
      }),
      schemas: Object.freeze({ ...definedEntries({ input: options.input }), output: options.output }),
      invoke
    }),
    trigger: "http.procedure" as const,
    id: options.id,
    resourceId: host.apiId
  });
}

/**
 * Reads the input of a query called with `GET` from its `input` query parameter.
 *
 * @param url - The request URL.
 * @param subject - The procedure, for messages.
 * @returns The decoded input, or `undefined` when the parameter is absent.
 * @throws {HolqaError} `HOLQA_PAYLOAD_MALFORMED` when the parameter is not JSON or appears more than once.
 */
function queryInput(url: URL, subject: string): JsonValue | undefined {
  const values = url.searchParams.getAll(rpcInputQueryParameter);
  if (values.length > 1)
    failWith(diagnosticCodes.payloadMalformed, `The "${rpcInputQueryParameter}" query parameter of ${subject} appears more than once.`);
  return values[0] === undefined ? undefined : decodeJsonPayload(values[0], `input of ${subject}`);
}

/**
 * Reads the input from a `POST` request envelope `{ "input": ... }`.
 *
 * @param body - The decoded JSON body, or `undefined` for an empty body.
 * @param subject - The procedure, for messages.
 * @returns The input, or `undefined` when the body or its `input` is absent.
 * @throws {HolqaError} `HOLQA_PAYLOAD_MALFORMED` when the body is not an object with only an `input` property.
 */
function envelopeInput(body: JsonValue | undefined, subject: string): JsonValue | undefined {
  if (body === undefined)
    return undefined;
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(key => key !== "input"))
    failWith(diagnosticCodes.payloadMalformed, `The request body of ${subject} must be an object of the form { "input": ... }.`);
  return (body as { readonly input?: JsonValue }).input;
}