import type { DiagnosticLocation } from "@holqa/core";

import type {
  EventPublication,
  HandlerAnalysisCoverage,
  PublicationCertainty,
  PublicationOperation,
  PublicationTarget
} from "@/events/event-graph";
import type {
  ScannedSource,
  Token
} from "@/events/source-scanner";

import { getResourceDescriptor } from "@holqa/core";

import { compareCodeUnits } from "@/discovery/module-path";
import { scanSource } from "@/events/source-scanner";

// Static analysis of what handlers publish. The compiler evaluates modules
// rather than parsing them (ADR 0014), so this analysis combines a lexical
// scan of a handler's source with the evaluated values of the modules it
// imports: a call such as `resources.orders.send(...)` is resolved by reading
// `resources.orders` from the evaluated module that exports `resources`, and
// checking that the value is a queue handle. Whatever the scan cannot follow
// (computed receivers, parameters, code outside the application) becomes an
// `unknown` publication, never a guess.

/** A module the host located for an import specifier. */
export interface ResolvedModule {
  /** The module's path relative to the application root, with `/` separators. */
  readonly path: string;
  /** The module's namespace, when the host has evaluated it. */
  readonly exports?: Readonly<Record<string, unknown>>;
}

/**
 * Locates the module an import specifier refers to. Hosts resolve
 * specifiers the way the runtime does (path aliases, extensions, index
 * files) and return only modules inside the application root.
 */
export type ModuleResolver = (specifier: string, from: string) => Promise<ResolvedModule | undefined>;

/** One handler to analyze. */
export interface HandlerToAnalyze {
  readonly id: string;
  /** The root-relative module the handler is exported from. */
  readonly module: string;
  /** Where the handler is registered, if known. */
  readonly location?: DiagnosticLocation;
}

/** Everything publication analysis reads: handlers, sources, evaluated namespaces and a resolver. */
export interface PublicationAnalysisInput {
  readonly handlers: readonly HandlerToAnalyze[];
  /** Source texts by root-relative path. */
  readonly sources: Readonly<Record<string, string>>;
  /** Namespaces of modules the host evaluated, by root-relative path. */
  readonly namespaces: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** Resolves import specifiers. Without it, relative specifiers and `@/`-style aliases are matched against known paths. */
  readonly resolve?: ModuleResolver;
}

/** What analysis found for one handler. */
export interface HandlerPublications {
  readonly handler: string;
  readonly coverage: HandlerAnalysisCoverage;
  /** Publications, sorted by location. Unknown publications have no target. */
  readonly publications: readonly EventPublication[];
}

/** An import binding of a module. */
interface ImportBinding {
  readonly specifier: string;
  /** The imported name, `default`, or `*` for a namespace import. */
  readonly imported: string;
}

/** What a local name is declared as. */
type Declaration
  = | { readonly kind: "function"; readonly start: number; readonly end: number }
    | { readonly kind: "alias"; readonly chain: readonly string[] }
    | { readonly kind: "value" }
    | { readonly kind: "other" }
    | { readonly kind: "ambiguous" };

/** A scanned module with its import bindings and local declarations. */
interface ModuleIndex {
  readonly path: string;
  readonly text: string;
  readonly scanned: ScannedSource;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** The local name exported by `export default <name>`, if any. */
  readonly defaultName?: string;
}

/** The result of resolving a member chain. */
type Resolution
  = | { readonly status: "value"; readonly value: unknown }
    | { readonly status: "not-resource" }
    | { readonly status: "unresolved" };

/** Method names that publish when called on a queue or bucket handle. */
const operations: ReadonlySet<string> = new Set<PublicationOperation>(["send", "put", "delete"]);

/** Identifiers that are keywords, never callable functions or chain roots. */
const keywords = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await", "new", "function", "async", "yield", "void", "delete", "throw", "in", "of", "instanceof", "else", "do", "case", "class", "super", "import", "export", "const", "let", "var", "as", "satisfies"]);

/** Tokens after which an expression continues on the next line. */
const continuesAfter = new Set(["=", "(", "[", "{", ",", ".", "?.", "+", "-", "*", "/", "%", "&&", "||", "??", "?", ":", "=>", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "&", "|", "^", "!", "~", "...", "+=", "-=", "await", "new", "typeof", "void", "in", "of", "instanceof", "as", "satisfies", "extends"]);

/** Tokens that continue the previous line's expression when they start a line. */
const continuesWith = new Set([".", "?.", ")", "]", "}", ",", "=>", "?", ":", "&&", "||", "??", "+", "-", "*", "/", "%", "=", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "&", "|", "^", "as", "satisfies"]);

/** How many helper functions deep analysis follows calls. */
const maxCallDepth = 4;

/** How many aliases deep a member chain is followed. */
const maxAliasDepth = 8;

/** File extensions tried when resolving specifiers without a host resolver. */
const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Finds what every handler publishes: queue sends and object writes and
 * deletes, resolved to declared resources where the code allows, with their
 * certainty and source location. Runtime-neutral: never reads files or
 * evaluates code itself; sources, evaluated namespaces and the resolver come
 * from the host.
 *
 * @param input - Handlers, sources, evaluated namespaces and the resolver.
 * @returns One entry per handler, sorted by handler identifier.
 */
export async function analyzePublications(input: PublicationAnalysisInput): Promise<HandlerPublications[]> {
  const analyzer = new Analyzer(input);
  const results: HandlerPublications[] = [];
  for (const handler of [...input.handlers].sort((left, right) => compareCodeUnits(left.id, right.id)))
    results.push(await analyzer.handler(handler));
  return results;
}

/** Context of one walk through a range of code. */
interface Walk {
  readonly handler: string;
  readonly certainty: Exclude<PublicationCertainty, "unknown">;
  readonly via: readonly string[];
  readonly visited: Set<string>;
  readonly found: EventPublication[];
}

/** Holds the per-analysis caches. */
class Analyzer {
  /** Handlers, sources, namespaces and the resolver being analyzed. */
  private readonly input: PublicationAnalysisInput;
  /** Scanned modules by path; `null` when a module cannot be scanned. */
  private readonly modules = new Map<string, ModuleIndex | null>();
  /** Resolved specifiers by `from` and specifier. */
  private readonly resolutions = new Map<string, Promise<ResolvedModule | undefined>>();
  /** Evaluated namespaces by path: the host's, and those the resolver returned. */
  private readonly namespaces: Map<string, Readonly<Record<string, unknown>>>;

  /**
   * Creates an analyzer.
   *
   * @param input - The analysis input.
   */
  constructor(input: PublicationAnalysisInput) {
    this.input = input;
    this.namespaces = new Map(input.namespaces);
  }

  /**
   * Analyzes one handler: locates its registration and walks its handler function.
   *
   * @param handler - The handler's identifier, module and registration location.
   * @returns Its publications and coverage.
   */
  async handler(handler: HandlerToAnalyze): Promise<HandlerPublications> {
    const located = this.locate(handler);
    if (located === undefined)
      return { handler: handler.id, coverage: "unavailable", publications: [] };
    const walk: Walk = { handler: handler.id, certainty: located.exact ? "known" : "potential", via: [], visited: new Set(), found: [] };
    await this.walk(located.module, located.start, located.end, walk);
    const publications = dedupe(walk.found);
    const complete = located.exact && publications.every(publication => publication.certainty !== "unknown");
    return { handler: handler.id, coverage: complete ? "complete" : "partial", publications };
  }

  /**
   * Finds the code of a handler: the `handler` property of the options
   * object whose `id` is the handler's identifier, in the handler's module
   * first, then in every other source. Falls back to the whole module when
   * the registration cannot be found.
   *
   * @param handler - The handler's identifier, module and registration location.
   * @returns The module and token range, and whether it is exactly the handler's code.
   */
  private locate(handler: HandlerToAnalyze): { readonly module: ModuleIndex; readonly start: number; readonly end: number; readonly exact: boolean } | undefined {
    const paths = [handler.module, ...Object.keys(this.input.sources).filter(path => path !== handler.module).sort(compareCodeUnits)];
    for (const path of paths) {
      const module = this.module(path);
      if (module === undefined)
        continue;
      const range = handlerRange(module, handler.id);
      if (range !== undefined)
        return { module, ...range, exact: true };
    }
    const own = this.module(handler.module);
    return own === undefined ? undefined : { module: own, start: 0, end: own.scanned.tokens.length, exact: false };
  }

  /**
   * Returns the scanned index of a module.
   *
   * @param path - A root-relative path.
   * @returns The index, or `undefined` when its source is unavailable or cannot be scanned.
   */
  private module(path: string): ModuleIndex | undefined {
    if (this.modules.has(path))
      return this.modules.get(path) ?? undefined;
    const text = this.input.sources[path];
    let index: ModuleIndex | null = null;
    if (text !== undefined) {
      try {
        const scanned = scanSource(text);
        const defaultName = readDefaultExportName(scanned);
        index = { path, text, scanned, imports: readImports(scanned), declarations: readDeclarations(scanned), ...defaultName === undefined ? {} : { defaultName } };
      } catch {
        // A module the scanner cannot read is unavailable to analysis; its publications are not guessed.
        index = null;
      }
    }
    this.modules.set(path, index);
    return index ?? undefined;
  }

  /**
   * Walks a token range: records publication calls, handles passed to other
   * functions, and follows calls of functions declared in the application.
   *
   * @param module - The scanned module the code is written in.
   * @param start - The first token.
   * @param end - The token after the range.
   * @param walk - The walk's context; receives publications.
   * @returns A promise that settles once the range and the functions it calls are walked.
   */
  private async walk(module: ModuleIndex, start: number, end: number, walk: Walk): Promise<void> {
    const key = `${module.path}:${start}:${end}`;
    if (walk.visited.has(key))
      return;
    walk.visited.add(key);
    const { tokens, partner } = module.scanned;
    for (let index = start; index < end; index++) {
      const token = tokens[index]!;
      if (token.kind !== "identifier")
        continue;
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      const member = previous?.kind === "punctuator" && (previous.text === "." || previous.text === "?.");
      if (member && operations.has(token.text) && isCallOpen(tokens, index + 1)) {
        await this.publicationCall(module, index, walk);
        continue;
      }
      if (member || keywords.has(token.text))
        continue;
      if (next?.kind === "punctuator" && next.text === "(" && previous?.text !== "function") {
        await this.functionCall(module, token.text, walk);
        continue;
      }
      if (startsArgument(tokens, partner, index))
        await this.handleArgument(module, index, walk);
    }
  }

  /**
   * Records one `<chain>.send(...)`, `.put(...)` or `.delete(...)` call.
   *
   * @param module - The scanned module the code is written in.
   * @param index - The index of the method name.
   * @param walk - The walk's context.
   */
  private async publicationCall(module: ModuleIndex, index: number, walk: Walk): Promise<void> {
    const { tokens } = module.scanned;
    const operation = tokens[index]!.text as PublicationOperation;
    const receiver = chainBefore(tokens, index - 1);
    const call = `${receiver === undefined ? "…" : module.text.slice(tokens[receiver.start]!.start, tokens[index]!.start + tokens[index]!.text.length)}()`;
    const location = locationOf(module, receiver?.start ?? index);
    const resolution = receiver === undefined ? { status: "unresolved" as const } : await this.resolveChain(module, receiver.names, 0);
    if (resolution.status === "not-resource")
      return;
    const target = resolution.status === "value" ? targetOf(resolution.value) : undefined;
    if (resolution.status === "value" && target === undefined)
      return;
    if (target !== undefined && (target.kind === "queue") !== (operation === "send"))
      return;
    const key = operation === "send" ? undefined : keyOf(tokens, index + 1);
    walk.found.push({
      handler: walk.handler,
      operation,
      ...target === undefined ? {} : { target },
      certainty: target === undefined ? "unknown" : walk.certainty,
      origin: "analysis",
      call,
      location,
      ...key === undefined ? {} : { keyPrefix: key.prefix, keyExact: key.exact },
      ...walk.via.length === 0 ? {} : { via: walk.via }
    });
  }

  /**
   * Follows a call of a function declared in the application, so that
   * publications in helpers are found. They are potential: the helper may
   * not publish on every call.
   *
   * @param module - The module the call is written in.
   * @param name - The called name.
   * @param walk - The walk's context.
   */
  private async functionCall(module: ModuleIndex, name: string, walk: Walk): Promise<void> {
    if (walk.via.length >= maxCallDepth)
      return;
    const target = await this.resolveFunction(module, name);
    if (target === undefined)
      return;
    await this.walk(target.module, target.start, target.end, { ...walk, certainty: "potential", via: [...walk.via, target.label] });
  }

  /**
   * Records a queue or bucket handle passed to a function, which may publish
   * to it: queues potentially receive messages, buckets potential writes and deletes.
   *
   * @param module - The scanned module the code is written in.
   * @param index - The index of the argument's first token.
   * @param walk - The walk's context.
   */
  private async handleArgument(module: ModuleIndex, index: number, walk: Walk): Promise<void> {
    const { tokens } = module.scanned;
    const chain = chainAfter(tokens, index);
    if (chain === undefined)
      return;
    const after = tokens[chain.end];
    if (after === undefined || after.kind !== "punctuator" || (after.text !== "," && after.text !== ")"))
      return;
    const resolution = await this.resolveChain(module, chain.names, 0);
    const target = resolution.status === "value" ? targetOf(resolution.value) : undefined;
    if (target === undefined)
      return;
    const call = `${module.text.slice(tokens[index]!.start, tokens[chain.end - 1]!.start + tokens[chain.end - 1]!.text.length)} passed to a function`;
    for (const operation of target.kind === "queue" ? ["send" as const] : ["put" as const, "delete" as const])
      walk.found.push({ handler: walk.handler, operation, target, certainty: "potential", origin: "analysis", call, location: locationOf(module, index), ...walk.via.length === 0 ? {} : { via: walk.via } });
  }

  /**
   * Resolves a member chain such as `resources.orders` to a value.
   *
   * @param module - The module the chain is written in.
   * @param names - The chain's names, root first.
   * @param depth - How many aliases were followed so far.
   * @returns The value, or why there is none.
   */
  private async resolveChain(module: ModuleIndex, names: readonly string[], depth: number): Promise<Resolution> {
    if (depth > maxAliasDepth)
      return { status: "unresolved" };
    const [root, ...rest] = names as [string, ...string[]];
    const own = this.namespaces.get(module.path);
    if (own !== undefined && Object.hasOwn(own, root))
      return readPath(own[root], rest);
    if (own !== undefined && module.defaultName === root && Object.hasOwn(own, "default"))
      return readPath(own, ["default", ...rest]);
    const declaration = module.declarations.get(root);
    if (declaration?.kind === "alias")
      return this.resolveChain(module, [...declaration.chain, ...rest], depth + 1);
    if (declaration?.kind === "value")
      return { status: "not-resource" };
    if (declaration !== undefined)
      return { status: "unresolved" };
    const binding = module.imports.get(root);
    const resolved = binding === undefined ? undefined : await this.resolveImport(binding.specifier, module.path);
    if (binding === undefined || resolved === undefined)
      return { status: "unresolved" };
    if (resolved.exports !== undefined && (binding.imported === "*" || Object.hasOwn(resolved.exports, binding.imported)))
      return readPath(binding.imported === "*" ? resolved.exports : resolved.exports[binding.imported], rest);
    // The module was not evaluated, or does not export the name directly: follow its source.
    const source = this.module(resolved.path);
    const name = binding.imported === "default" ? source?.defaultName : binding.imported;
    return source === undefined || name === undefined || binding.imported === "*" ? { status: "unresolved" } : this.resolveChain(source, [name, ...rest], depth + 1);
  }

  /**
   * Finds the code of a called function: declared in the same module, or
   * imported from another application module whose source is available.
   *
   * @param module - The module the call is written in.
   * @param name - The called name.
   * @returns The function's module, token range and a label, or `undefined`.
   */
  private async resolveFunction(module: ModuleIndex, name: string): Promise<{ readonly module: ModuleIndex; readonly start: number; readonly end: number; readonly label: string } | undefined> {
    const declaration = module.declarations.get(name);
    if (declaration?.kind === "function")
      return { module, start: declaration.start, end: declaration.end, label: name };
    if (declaration !== undefined)
      return undefined;
    const binding = module.imports.get(name);
    if (binding === undefined || binding.imported === "*" || binding.imported === "default")
      return undefined;
    const resolved = await this.resolveImport(binding.specifier, module.path);
    const target = resolved === undefined ? undefined : this.module(resolved.path);
    const exported = target?.declarations.get(binding.imported);
    return target !== undefined && exported?.kind === "function" ? { module: target, start: exported.start, end: exported.end, label: `${target.path}#${binding.imported}` } : undefined;
  }

  /**
   * Resolves an import specifier once per importing module.
   *
   * @param specifier - The specifier as written.
   * @param from - The importing module's path.
   * @returns The module, or `undefined` when it is outside the application or unknown.
   */
  private async resolveImport(specifier: string, from: string): Promise<ResolvedModule | undefined> {
    const key = `${from}\u0000${specifier}`;
    let resolution = this.resolutions.get(key);
    if (resolution === undefined) {
      resolution = (this.input.resolve === undefined
        ? Promise.resolve(fallbackResolve(specifier, from, [...new Set([...Object.keys(this.input.sources), ...this.input.namespaces.keys()])], this.input.namespaces))
        // A specifier the host cannot resolve is unresolved, which analysis reports as unknown.
        : this.input.resolve(specifier, from).catch(() => undefined)).then((resolved) => {
        if (resolved?.exports !== undefined && !this.namespaces.has(resolved.path))
          this.namespaces.set(resolved.path, resolved.exports);
        return resolved;
      });
      this.resolutions.set(key, resolution);
    }
    return resolution;
  }
}

/**
 * Finds the `handler` property of the registration whose `id` is a handler's identifier.
 *
 * @param module - The scanned module.
 * @param id - The handler's identifier.
 * @returns The token range of the handler function, or `undefined` when the registration is not in this module.
 */
function handlerRange(module: ModuleIndex, id: string): { readonly start: number; readonly end: number } | undefined {
  const { tokens, partner, depth } = module.scanned;
  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "string" || token.value !== id || tokens[index - 1]!.text !== ":" || !isPropertyName(tokens[index - 2]!, "id"))
      continue;
    // The options object is the innermost `{` that encloses the identifier.
    let open = index - 1;
    while (open >= 0 && !(tokens[open]!.text === "{" && partner[open]! > index))
      open--;
    if (open < 0)
      continue;
    const close = partner[open]!;
    const level = depth[open]! + 1;
    for (let property = open + 1; property < close; property++) {
      if (depth[property] !== level || !isPropertyName(tokens[property]!, "handler"))
        continue;
      const before = tokens[property - 1]!;
      if (!(before.text === "{" || before.text === "," || before.text === "async"))
        continue;
      const after = tokens[property + 1]!;
      if (after.text === ":")
        return functionOrReference(module, property + 2, expressionEnd(module.scanned, property + 2));
      if (after.text === "(") {
        // Method shorthand: `handler(context) { ... }`.
        const body = nextAt(tokens, depth, partner[property + 1]! + 1, "{", depth[property + 1]!);
        return body === undefined ? undefined : { start: property, end: partner[body]! + 1 };
      }
      if (after.text === "," || after.text === "}")
        return functionOrReference(module, property, property + 1);
    }
  }
  return undefined;
}

/**
 * Turns a property value into the code to walk: an inline function, or the
 * function a name refers to in the same module.
 *
 * @param module - The scanned module.
 * @param start - The value's first token.
 * @param end - The token after the value.
 * @returns The range to walk.
 */
function functionOrReference(module: ModuleIndex, start: number, end: number): { readonly start: number; readonly end: number } {
  const { tokens } = module.scanned;
  if (end === start + 1 && tokens[start]!.kind === "identifier") {
    const declaration = module.declarations.get(tokens[start]!.text);
    if (declaration?.kind === "function")
      return { start: declaration.start, end: declaration.end };
  }
  return { start, end };
}

/**
 * Reports whether a token names a property: an identifier or a string with that name.
 *
 * @param token - A token that may be a property key.
 * @param name - The property name to look for.
 * @returns `true` for `name` or `"name"`.
 */
function isPropertyName(token: Token, name: string): boolean {
  return (token.kind === "identifier" && token.text === name) || (token.kind === "string" && token.value === name);
}

/**
 * Reports whether a call's argument list opens at a token: `(`, or `?.(`.
 *
 * @param tokens - The scanned tokens of the module.
 * @param index - The token after the method name.
 * @returns `true` when a call follows.
 */
function isCallOpen(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  return token?.text === "(" || (token?.text === "?." && tokens[index + 1]?.text === "(");
}

/**
 * Reads the member chain that ends at a token, walking backwards: `a.b?.c!`.
 *
 * @param tokens - The scanned tokens of the module.
 * @param dot - The index of the `.` or `?.` before the method name.
 * @returns The chain's names and first token, or `undefined` when the receiver is not a plain chain.
 */
function chainBefore(tokens: readonly Token[], dot: number): { readonly names: string[]; readonly start: number } | undefined {
  const names: string[] = [];
  let index = dot - 1;
  for (;;) {
    while (tokens[index]?.text === "!")
      index--;
    const token = tokens[index];
    if (token?.kind !== "identifier" || keywords.has(token.text) || token.text === "this")
      return undefined;
    names.unshift(token.text);
    const before = tokens[index - 1];
    if (before?.kind === "punctuator" && (before.text === "." || before.text === "?.")) {
      index -= 2;
      continue;
    }
    return { names, start: index };
  }
}

/**
 * Reads the member chain that starts at a token: `a.b?.c!`.
 *
 * @param tokens - The scanned tokens of the module.
 * @param start - The chain's first token.
 * @returns The names and the index after the chain, or `undefined` when no chain starts there.
 */
function chainAfter(tokens: readonly Token[], start: number): { readonly names: string[]; readonly end: number } | undefined {
  const first = tokens[start];
  if (first?.kind !== "identifier" || keywords.has(first.text) || first.text === "this")
    return undefined;
  const names = [first.text];
  let index = start + 1;
  for (;;) {
    while (tokens[index]?.text === "!")
      index++;
    const token = tokens[index];
    const name = tokens[index + 1];
    if (token?.kind === "punctuator" && (token.text === "." || token.text === "?.") && name?.kind === "identifier") {
      names.push(name.text);
      index += 2;
      continue;
    }
    return { names, end: index };
  }
}

/**
 * Reports whether a token starts a direct argument of a function call: it
 * follows the call's `(` or a `,` of its argument list.
 *
 * @param tokens - The scanned tokens of the module.
 * @param partner - Bracket partners.
 * @param index - The candidate token.
 * @returns `true` for the first token of a call argument.
 */
function startsArgument(tokens: readonly Token[], partner: readonly number[], index: number): boolean {
  const previous = tokens[index - 1];
  if (previous === undefined || previous.kind !== "punctuator")
    return false;
  let open: number;
  if (previous.text === "(") {
    open = index - 1;
  } else if (previous.text === ",") {
    // The enclosing bracket of the comma.
    open = index - 2;
    while (open >= 0 && !(["(", "[", "{"].includes(tokens[open]!.text) && partner[open]! > index)) {
      const candidate = tokens[open]!.text;
      open = [")", "]", "}"].includes(candidate) ? partner[open]! - 1 : open - 1;
    }
    if (open < 0 || tokens[open]!.text !== "(")
      return false;
  } else {
    return false;
  }
  const callee = tokens[open - 1];
  return callee !== undefined && ((callee.kind === "identifier" && !keywords.has(callee.text)) || callee.text === ")" || callee.text === "]");
}

/**
 * Reads the static beginning of an object key argument.
 *
 * @param tokens - The scanned tokens of the module.
 * @param open - The index of the call's `(` (or `?.` before it).
 * @returns The prefix and whether it is the whole key, or `undefined` when the key is computed.
 */
function keyOf(tokens: readonly Token[], open: number): { readonly prefix: string; readonly exact: boolean } | undefined {
  const index = tokens[open]?.text === "?." ? open + 2 : open + 1;
  const token = tokens[index];
  if (token === undefined || (token.kind !== "string" && (token.kind !== "template" || token.continuation === true)))
    return undefined;
  const after = tokens[index + 1];
  const ends = after?.kind === "punctuator" && (after.text === "," || after.text === ")");
  return { prefix: token.value ?? "", exact: (token.kind === "string" || token.complete === true) && ends };
}

/**
 * Reads a property path of an evaluated value without running getters.
 *
 * @param value - The start value.
 * @param path - Property names.
 * @returns The value at the end of the path, or `unresolved` when a step is missing or a getter.
 */
function readPath(value: unknown, path: readonly string[]): Resolution {
  let current = value;
  for (const name of path) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null)
      return { status: "unresolved" };
    const property = Object.getOwnPropertyDescriptor(current, name);
    if (property === undefined || !("value" in property))
      return { status: "unresolved" };
    current = property.value;
  }
  return { status: "value", value: current };
}

/**
 * Reads the queue or bucket a value is a handle of.
 *
 * @param value - An evaluated value.
 * @returns The target, or `undefined` when the value is no queue or bucket handle.
 */
function targetOf(value: unknown): PublicationTarget | undefined {
  const descriptor = getResourceDescriptor(value);
  return descriptor?.kind === "queue" || descriptor?.kind === "bucket" ? { kind: descriptor.kind, id: descriptor.id } : undefined;
}

/**
 * Computes the location of a token.
 *
 * @param module - The scanned module the token belongs to.
 * @param index - The token's index.
 * @returns A root-relative location.
 */
function locationOf(module: ModuleIndex, index: number): DiagnosticLocation {
  const token = module.scanned.tokens[index]!;
  return { file: module.path, line: token.line, column: token.column };
}

/**
 * Removes repeated publications (the same call found through two paths),
 * keeping the most certain, and sorts them by location.
 *
 * @param found - Publications in discovery order.
 * @returns Unique publications.
 */
function dedupe(found: readonly EventPublication[]): EventPublication[] {
  const rank: Readonly<Record<PublicationCertainty, number>> = { known: 0, potential: 1, unknown: 2 };
  const best = new Map<string, EventPublication>();
  for (const publication of found) {
    const key = JSON.stringify([publication.operation, publication.target, publication.call, publication.location]);
    const existing = best.get(key);
    if (existing === undefined || rank[publication.certainty] < rank[existing.certainty])
      best.set(key, publication);
  }
  return [...best.values()].sort((left, right) => compareCodeUnits(left.location?.file ?? "", right.location?.file ?? "")
    || (left.location?.line ?? 0) - (right.location?.line ?? 0)
    || (left.location?.column ?? 0) - (right.location?.column ?? 0)
    || compareCodeUnits(left.operation, right.operation));
}

/**
 * Finds the end of the expression that starts at a token: the first `,` or
 * `;` at the same bracket depth, a bracket that closes an enclosing one, or a
 * line break where the expression cannot continue.
 *
 * @param scanned - The scanned module.
 * @param start - The expression's first token.
 * @returns The index after the expression.
 */
function expressionEnd(scanned: ScannedSource, start: number): number {
  const { tokens, partner, depth } = scanned;
  const base = depth[start] ?? 0;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (depth[index]! < base)
      break;
    if (index > start && (token.text === "," || token.text === ";") && token.kind === "punctuator")
      break;
    if (index > start && token.newline && !continues(tokens[index - 1]!, token))
      break;
    index = partner[index]! > index ? partner[index]! + 1 : index + 1;
  }
  return index;
}

/**
 * Decides whether a line break between two tokens continues an expression.
 *
 * @param previous - The token before the line break.
 * @param current - The token after it.
 * @returns `true` when the expression continues.
 */
function continues(previous: Token, current: Token): boolean {
  if (current.kind === "punctuator" || current.text === "as" || current.text === "satisfies")
    return continuesWith.has(current.text);
  return (previous.kind === "punctuator" || previous.kind === "identifier") && continuesAfter.has(previous.text);
}

/**
 * Finds the next token with a given text at a given depth.
 *
 * @param tokens - The scanned tokens of the module.
 * @param depth - Bracket depths.
 * @param from - Where to start.
 * @param text - The token text to find.
 * @param level - The depth it must have.
 * @returns Its index, or `undefined`.
 */
function nextAt(tokens: readonly Token[], depth: readonly number[], from: number, text: string, level: number): number | undefined {
  for (let index = from; index < tokens.length; index++) {
    if (depth[index]! < level)
      return undefined;
    if (depth[index] === level && tokens[index]!.text === text)
      return index;
  }
  return undefined;
}

/**
 * Reads a module's value imports. Type-only imports are skipped.
 *
 * @param scanned - The scanned module.
 * @returns Import bindings by local name.
 */
function readImports(scanned: ScannedSource): Map<string, ImportBinding> {
  const { tokens, depth } = scanned;
  const imports = new Map<string, ImportBinding>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier" || token.text !== "import" || depth[index] !== 0 || tokens[index - 1]?.text === ".")
      continue;
    const next = tokens[index + 1];
    if (next === undefined || next.text === "(" || next.text === "." || (next.text === "type" && tokens[index + 2]?.text !== "," && tokens[index + 2]?.text !== "from"))
      continue;
    const from = tokens.findIndex((candidate, position) => position > index && candidate.kind === "identifier" && candidate.text === "from" && tokens[position + 1]?.kind === "string");
    if (from === -1)
      continue;
    const specifier = tokens[from + 1]!.value!;
    let cursor = index + 1;
    while (cursor < from) {
      const current = tokens[cursor]!;
      if (current.text === "*" && tokens[cursor + 1]?.text === "as" && tokens[cursor + 2]?.kind === "identifier") {
        imports.set(tokens[cursor + 2]!.text, { specifier, imported: "*" });
        cursor += 3;
      } else if (current.text === "{") {
        cursor = readNamedImports(tokens, cursor + 1, specifier, imports);
      } else if (current.kind === "identifier" && current.text !== "type") {
        imports.set(current.text, { specifier, imported: "default" });
        cursor++;
      } else {
        cursor++;
      }
    }
    index = from + 1;
  }
  return imports;
}

/**
 * Finds the local name a module exports as its default: `export default app;`.
 *
 * @param scanned - The scanned module.
 * @returns The name, or `undefined` when the default export is not a plain name.
 */
function readDefaultExportName(scanned: ScannedSource): string | undefined {
  const { tokens, depth } = scanned;
  for (let index = 0; index + 2 < tokens.length; index++) {
    if (depth[index] !== 0 || tokens[index]!.text !== "export" || tokens[index + 1]!.text !== "default")
      continue;
    const name = tokens[index + 2]!;
    const after = tokens[index + 3];
    if (name.kind === "identifier" && !keywords.has(name.text) && (after === undefined || after.text === ";" || after.newline))
      return name.text;
  }
  return undefined;
}

/**
 * Reads the `{ a, type b, c as d }` part of an import.
 *
 * @param tokens - The scanned tokens of the module.
 * @param start - The token after `{`.
 * @param specifier - The import's specifier.
 * @param imports - Receives the bindings.
 * @returns The index after the closing `}`.
 */
function readNamedImports(tokens: readonly Token[], start: number, specifier: string, imports: Map<string, ImportBinding>): number {
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor]!.text !== "}") {
    let current = tokens[cursor]!;
    if (current.text === "type" && tokens[cursor + 1]?.kind === "identifier" && tokens[cursor + 1]!.text !== "as") {
      // A type-only specifier: skip it and its alias.
      cursor += tokens[cursor + 2]?.text === "as" ? 4 : 2;
      continue;
    }
    if (current.kind === "identifier" || current.kind === "string") {
      const imported = current.kind === "string" ? current.value! : current.text;
      let local = imported;
      if (tokens[cursor + 1]?.text === "as" && tokens[cursor + 2]?.kind === "identifier") {
        local = tokens[cursor + 2]!.text;
        cursor += 2;
      }
      imports.set(local, { specifier, imported });
    }
    cursor++;
    current = tokens[cursor] ?? current;
    if (current.text === ",")
      cursor++;
  }
  return cursor + 1;
}

/**
 * Reads a module's declarations by name: functions with their bodies, `const`
 * aliases of member chains (also from destructuring), and other values. A
 * name declared more than once with different meanings becomes ambiguous.
 *
 * @param scanned - The scanned module.
 * @returns Declarations by name.
 */
function readDeclarations(scanned: ScannedSource): Map<string, Declaration> {
  const { tokens, partner, depth } = scanned;
  const declarations = new Map<string, Declaration>();
  /**
   * Records a declaration, marking conflicting ones as ambiguous.
   *
   * @param name - The declared name.
   * @param declaration - What it is.
   */
  const record = (name: string, declaration: Declaration): void => {
    const existing = declarations.get(name);
    declarations.set(name, existing === undefined || JSON.stringify(existing) === JSON.stringify(declaration) ? declaration : { kind: "ambiguous" });
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier" || tokens[index - 1]?.text === ".")
      continue;
    if (token.text === "function") {
      const nameIndex = tokens[index + 1]?.text === "*" ? index + 2 : index + 1;
      const name = tokens[nameIndex];
      const params = tokens[nameIndex + 1]?.text === "(" ? nameIndex + 1 : tokens[nameIndex + 1]?.text === "<" ? nextAt(tokens, depth, nameIndex + 1, "(", depth[nameIndex]!) : undefined;
      if (name?.kind !== "identifier" || params === undefined)
        continue;
      const body = nextAt(tokens, depth, partner[params]! + 1, "{", depth[params]!);
      if (body !== undefined)
        record(name.text, { kind: "function", start: tokens[index - 1]?.text === "async" ? index - 1 : index, end: partner[body]! + 1 });
      continue;
    }
    if (token.text !== "const" && token.text !== "let" && token.text !== "var")
      continue;
    let cursor = index + 1;
    for (;;) {
      const target = tokens[cursor];
      if (target === undefined)
        break;
      const level = depth[cursor]!;
      const patternEnd = target.text === "{" || target.text === "[" ? partner[cursor]! + 1 : cursor + 1;
      const equals = nextAt(tokens, depth, patternEnd, "=", level);
      const stop = nextAt(tokens, depth, patternEnd, ";", level);
      if (equals === undefined || (stop !== undefined && stop < equals) || equals > patternEnd + 8) {
        if (target.kind === "identifier")
          record(target.text, { kind: "other" });
        break;
      }
      const start = equals + 1;
      const end = expressionEnd(scanned, start);
      const chain = chainRange(tokens, start, end);
      if (target.kind === "identifier") {
        record(target.text, isFunctionExpression(tokens, start)
          ? { kind: "function", start, end }
          : chain !== undefined
            ? { kind: "alias", chain }
            : isPlainValue(tokens[start]) ? { kind: "value" } : { kind: "other" });
      } else if (target.text === "{") {
        readObjectPattern(tokens, depth, cursor, chain, record);
      }
      if (tokens[end]?.text !== ",")
        break;
      cursor = end + 1;
    }
  }
  return declarations;
}

/**
 * Records the names an object pattern declares: aliases of the source chain's
 * properties when the source is a chain, other values otherwise.
 *
 * @param tokens - The scanned tokens of the module.
 * @param depth - Bracket depths.
 * @param open - The index of the pattern's opening `{`.
 * @param source - The chain the pattern destructures, if any.
 * @param record - Records a declaration.
 */
function readObjectPattern(tokens: readonly Token[], depth: readonly number[], open: number, source: readonly string[] | undefined, record: (name: string, declaration: Declaration) => void): void {
  const level = depth[open]! + 1;
  for (let index = open + 1; index < tokens.length && depth[index]! >= level; index++) {
    const token = tokens[index]!;
    if (depth[index] !== level || token.kind !== "identifier")
      continue;
    const before = tokens[index - 1]!.text;
    const after = tokens[index + 1]?.text;
    if (before === "...")
      record(token.text, { kind: "other" });
    else if ((before === "{" || before === ",") && after === ":" && tokens[index + 2]?.kind === "identifier" && [",", "}", "="].includes(tokens[index + 3]?.text ?? ""))
      record(tokens[index + 2]!.text, source === undefined ? { kind: "other" } : { kind: "alias", chain: [...source, token.text] });
    else if ((before === "{" || before === ",") && (after === "," || after === "}" || after === "="))
      record(token.text, source === undefined ? { kind: "other" } : { kind: "alias", chain: [...source, token.text] });
  }
}

/**
 * Reads a token range that consists of exactly one member chain.
 *
 * @param tokens - The scanned tokens of the module.
 * @param start - The first token.
 * @param end - The token after the range.
 * @returns The chain's names, or `undefined`.
 */
function chainRange(tokens: readonly Token[], start: number, end: number): string[] | undefined {
  const chain = chainAfter(tokens, start);
  return chain !== undefined && chain.end === end ? chain.names : undefined;
}

/**
 * Reports whether an expression is a function: `function`, `async`, an arrow with parameters in parentheses, or `x =>`.
 *
 * @param tokens - The scanned tokens of the module.
 * @param start - The expression's first token.
 * @returns `true` for function expressions.
 */
function isFunctionExpression(tokens: readonly Token[], start: number): boolean {
  const first = tokens[start];
  if (first === undefined)
    return false;
  if (first.text === "function" || (first.text === "async" && (tokens[start + 1]?.text === "function" || tokens[start + 1]?.text === "(" || tokens[start + 2]?.text === "=>")))
    return true;
  return (first.kind === "identifier" && tokens[start + 1]?.text === "=>") || first.text === "(" ? arrowFollows(tokens, start) : false;
}

/**
 * Reports whether a parenthesized group (or single parameter) is followed by `=>`, possibly after a return type.
 *
 * @param tokens - The scanned tokens of the module.
 * @param start - The `(` or the parameter name.
 * @returns `true` for arrow functions.
 */
function arrowFollows(tokens: readonly Token[], start: number): boolean {
  if (tokens[start]?.kind === "identifier")
    return tokens[start + 1]?.text === "=>";
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text;
    if (text === "(")
      depth++;
    else if (text === ")" && --depth === 0)
      return tokens[index + 1]?.text === "=>" || tokens[index + 1]?.text === ":";
  }
  return false;
}

/**
 * Reports whether an initializer is certainly not a resource handle: a
 * literal, an object or array literal, or a `new` expression.
 *
 * @param token - The initializer's first token.
 * @returns `true` for such values.
 */
function isPlainValue(token: Token | undefined): boolean {
  return token !== undefined && (token.kind === "string" || token.kind === "number" || token.kind === "template" || token.kind === "regex" || token.text === "new" || token.text === "[" || token.text === "{" || token.text === "true" || token.text === "false" || token.text === "null");
}

/**
 * Resolves a specifier against known module paths, for hosts without a
 * resolver: relative specifiers by path (with the usual extensions and
 * index files, and `.js` standing for `.ts`), and alias-style specifiers
 * (`@/`, `~/`, `#`) by the longest unique path suffix.
 *
 * @param specifier - The specifier as written.
 * @param from - The importing module's path.
 * @param paths - Every known module path.
 * @param namespaces - Evaluated namespaces by path.
 * @returns The module, or `undefined`.
 */
export function fallbackResolve(specifier: string, from: string, paths: readonly string[], namespaces: ReadonlyMap<string, Readonly<Record<string, unknown>>>): ResolvedModule | undefined {
  const known = new Set(paths);
  /**
   * Builds the result for a known path.
   *
   * @param path - A known path.
   * @returns The module with its namespace when evaluated.
   */
  const result = (path: string): ResolvedModule => {
    const exports = namespaces.get(path);
    return exports === undefined ? { path } : { path, exports };
  };
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = joinPath(from.slice(0, from.lastIndexOf("/") + 1), specifier);
    if (base === undefined)
      return undefined;
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const candidate of [base, ...extensions.map(extension => stem + extension), ...extensions.map(extension => `${base}/index${extension}`)]) {
      if (known.has(candidate))
        return result(candidate);
    }
    return undefined;
  }
  const alias = /^(?:[@~]\/|#)(.+)$/.exec(specifier)?.[1];
  if (alias === undefined)
    return undefined;
  const matches = paths.filter((path) => {
    const stem = path.replace(/\.[^./]+$/, "").replace(/\/index$/, "");
    return alias === stem || alias.endsWith(`/${stem}`);
  });
  return matches.length === 1 ? result(matches[0]!) : undefined;
}

/**
 * Joins a relative specifier to a directory and normalizes `.` and `..`.
 *
 * @param directory - The importing module's directory, ending in `/` or empty.
 * @param specifier - A relative specifier.
 * @returns The root-relative path, or `undefined` when it leaves the root.
 */
function joinPath(directory: string, specifier: string): string | undefined {
  const segments: string[] = [];
  for (const segment of `${directory}${specifier}`.split("/")) {
    if (segment === "" || segment === ".")
      continue;
    if (segment === "..") {
      if (segments.length === 0)
        return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}