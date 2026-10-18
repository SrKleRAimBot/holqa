/**
 * Enforces Holqa's package and module boundaries.
 *
 * Checks performed:
 * 1. Every internal (`@holqa/*`) dependency follows the allowed dependency
 *    directions documented in docs/architecture/package-boundaries.md.
 * 2. Internal dependencies use the `workspace:*` protocol.
 * 3. The workspace package graph has no cycles.
 * 4. Every `@holqa/*` import in `src/` is declared in `package.json`.
 * 5. Modules inside each package's `src/` have no circular imports.
 * 6. No test files live inside a shipped `src/` directory.
 * 7. Disposable M0 experiments (`experiments/*`) follow the layering in
 *    `experimentDependencies`; their development dependencies are exempt.
 *
 * Usage: bun scripts/check-boundaries.ts
 */
import {
  existsSync,
  readdirSync,
  readFileSync
} from "node:fs";
import {
  dirname,
  join,
  relative,
  resolve,
  sep
} from "node:path";

/** Repository root, resolved from this script's location. */
const root = join(import.meta.dir, "..");

/** Directories whose children may be workspace packages. */
const workspaceParents = ["packages", "packages/integrations", "examples", "experiments"];

/**
 * Allowed internal dependencies for each framework package. Dependencies point
 * inward toward framework-neutral contracts. A package missing from this table
 * fails the check until its allowed dependencies are decided and documented.
 */
const allowedDependencies: Readonly<Record<string, readonly string[]>> = {
  "@holqa/core": [],
  "@holqa/sdk": ["@holqa/core"],
  "@holqa/client": ["@holqa/core"],
  "@holqa/compiler": ["@holqa/core"],
  "@holqa/runtime-bun": ["@holqa/core"],
  "@holqa/local": ["@holqa/core", "@holqa/runtime-bun"],
  "@holqa/testing": ["@holqa/core", "@holqa/sdk", "@holqa/local", "@holqa/runtime-bun"],
  "@holqa/cli": ["@holqa/core", "@holqa/compiler", "@holqa/local", "@holqa/runtime-bun"]
};

/**
 * Allowed internal dependencies for the disposable M0 experiments under
 * `experiments/`. They mirror the target layering so the experiments test it:
 * `experiment-model` stands in for future `@holqa/core` contracts, and the
 * compiler and runtime prototypes must not depend on the SDK prototype.
 * Development dependencies are exempt so tests can use the SDK as a fixture.
 */
const experimentDependencies: Readonly<Record<string, readonly string[]>> = {
  "@holqa/experiment-model": ["@holqa/core"],
  "@holqa/experiment-sdk": ["@holqa/core", "@holqa/experiment-model"],
  "@holqa/experiment-schema-adapters": ["@holqa/core", "@holqa/experiment-model"],
  "@holqa/experiment-compiler": ["@holqa/core", "@holqa/compiler", "@holqa/experiment-model"],
  "@holqa/experiment-runtime-bun": ["@holqa/core", "@holqa/experiment-model"]
};

/** Allowed internal dependencies for any package under `packages/integrations/`. */
const integrationDependencies = ["@holqa/core", "@holqa/sdk", "@holqa/client"];

/**
 * Schema adapters are integrations with a narrower rule (ADR 0017, ADR 0021):
 * they may depend on `@holqa/core` only, so that the compiler can load them
 * without pulling in the SDK or client.
 */
const schemaAdapterDependencies: Readonly<Record<string, readonly string[]>> = {
  "@holqa/zod": ["@holqa/core"]
};

/** Source file extensions considered when scanning modules. */
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];

/** A workspace package discovered on disk. */
interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly kind: "framework" | "integration" | "example" | "experiment";
  readonly internalDependencies: ReadonlyMap<string, string>;
  /** Internal runtime and peer dependencies, excluding development dependencies. */
  readonly productionDependencies: ReadonlySet<string>;
}

/**
 * Finds every directory with a `package.json` under the workspace parents.
 *
 * @returns The discovered packages with their internal dependency specifiers.
 */
function discoverPackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const parent of workspaceParents) {
    const parentPath = join(root, parent);
    if (!existsSync(parentPath))
      continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      const directory = join(parentPath, entry.name);
      const manifestPath = join(directory, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath))
        continue;

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const internalDependencies = new Map<string, string>();
      const productionDependencies = new Set<string>();
      for (const field of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
        for (const [name, specifier] of Object.entries(field ?? {})) {
          if (!name.startsWith("@holqa/"))
            continue;
          internalDependencies.set(name, specifier);
          if (field !== manifest.devDependencies)
            productionDependencies.add(name);
        }
      }
      const kind = parent === "examples" ? "example" : parent === "experiments" ? "experiment" : parent === "packages/integrations" ? "integration" : "framework";
      packages.push({ name: manifest.name, directory, kind, internalDependencies, productionDependencies });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Validates dependency directions and the `workspace:` protocol for one package.
 *
 * @param pkg - The package to validate.
 * @returns Human-readable problems, empty when the package is valid.
 */
function checkDependencyDirections(pkg: WorkspacePackage): string[] {
  const problems: string[] = [];
  const allowed = pkg.kind === "example"
    ? undefined
    : pkg.kind === "integration"
      ? schemaAdapterDependencies[pkg.name] ?? integrationDependencies
      : pkg.kind === "experiment" ? experimentDependencies[pkg.name] : allowedDependencies[pkg.name];

  if (pkg.kind === "framework" && allowed === undefined)
    problems.push(`${pkg.name}: not listed in allowedDependencies (scripts/check-boundaries.ts). Decide and document its dependency direction.`);
  if (pkg.kind === "experiment" && allowed === undefined)
    problems.push(`${pkg.name}: not listed in experimentDependencies (scripts/check-boundaries.ts).`);

  for (const [dependency, specifier] of pkg.internalDependencies) {
    if (!specifier.startsWith("workspace:"))
      problems.push(`${pkg.name}: internal dependency ${dependency} must use the workspace: protocol (found "${specifier}").`);
    const checked = pkg.kind !== "experiment" || pkg.productionDependencies.has(dependency);
    if (checked && allowed !== undefined && !allowed.includes(dependency))
      problems.push(`${pkg.name}: must not depend on ${dependency}. Allowed: ${allowed.length === 0 ? "none" : allowed.join(", ")}.`);
  }
  return problems;
}

/**
 * Finds the first cycle in a directed graph using depth-first search.
 *
 * @param graph - Adjacency lists keyed by node.
 * @returns The nodes forming a cycle (first node repeated at the end), or `undefined`.
 */
function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  /**
   * Visits `node` and its descendants, returning a cycle as soon as one is found.
   *
   * @param node - The node to visit.
   * @returns A cycle, or `undefined` if none is reachable from `node`.
   */
  function visit(node: string): string[] | undefined {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "visiting")
        return [...stack.slice(stack.indexOf(next)), next];
      if (state.get(next) === undefined) {
        const cycle = visit(next);
        if (cycle !== undefined)
          return cycle;
      }
    }
    stack.pop();
    state.set(node, "done");
    return undefined;
  }

  for (const node of [...graph.keys()].sort()) {
    if (state.get(node) === undefined) {
      const cycle = visit(node);
      if (cycle !== undefined)
        return cycle;
    }
  }
  return undefined;
}

/**
 * Lists every source file under a directory, recursively.
 *
 * @param directory - The directory to walk.
 * @returns Absolute paths of TypeScript source files.
 */
function listSourceFiles(directory: string): string[] {
  if (!existsSync(directory))
    return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return listSourceFiles(path);
    return sourceExtensions.some(extension => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/**
 * Resolves an intra-package import specifier (`@/...` or relative) to a source file.
 *
 * @param specifier - The module path as written in the import statement.
 * @param importer - The absolute path of the importing file.
 * @param sourceRoot - The package's `src/` directory, which `@/` maps to.
 * @returns The resolved absolute path, or `undefined` for external or unresolvable specifiers.
 */
function resolveLocalImport(specifier: string, importer: string, sourceRoot: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/"))
    base = join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = resolve(dirname(importer), specifier);
  else
    return undefined;

  const candidates = [base, ...sourceExtensions.map(extension => `${base}${extension}`), ...sourceExtensions.map(extension => join(base, `index${extension}`))];
  return candidates.find(candidate => existsSync(candidate) && candidate.startsWith(sourceRoot) && sourceExtensions.some(extension => candidate.endsWith(extension)));
}

/**
 * Scans a package's `src/` modules for circular imports, undeclared internal
 * package imports and misplaced test files.
 *
 * @param pkg - The package to scan.
 * @returns Human-readable problems, empty when the package is valid.
 */
function checkModules(pkg: WorkspacePackage): string[] {
  const problems: string[] = [];
  const sourceRoot = join(pkg.directory, "src");
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const graph = new Map<string, string[]>();

  for (const file of listSourceFiles(sourceRoot)) {
    const display = relative(root, file).split(sep).join("/");
    if (/\.(?:test|spec)\.[cm]?tsx?$/.test(file))
      problems.push(`${display}: test files belong under tests/, not src/.`);

    // The transpiler rejects hashbang lines, so blank them out before scanning.
    const contents = readFileSync(file, "utf8").replace(/^#!.*/, "");
    const imports = transpiler.scanImports(contents);
    const edges: string[] = [];
    for (const { path: specifier } of imports) {
      const packageName = specifier.match(/^@holqa\/[^/]+/)?.[0];
      if (packageName !== undefined && packageName !== pkg.name && !pkg.internalDependencies.has(packageName))
        problems.push(`${display}: imports ${packageName}, which is not declared in ${pkg.name}'s package.json.`);
      // Experiments may use other experiments as test fixtures, but shipped src/ code may only import production dependencies.
      else if (packageName !== undefined && packageName !== pkg.name && pkg.kind === "experiment" && !pkg.productionDependencies.has(packageName))
        problems.push(`${display}: imports ${packageName}, which ${pkg.name} declares only as a development dependency.`);

      const target = resolveLocalImport(specifier, file, sourceRoot);
      if (target !== undefined)
        edges.push(target);
    }
    graph.set(file, edges);
  }

  const cycle = findCycle(graph);
  if (cycle !== undefined)
    problems.push(`${pkg.name}: circular module imports: ${cycle.map(file => relative(pkg.directory, file)).join(" -> ")}`);
  return problems;
}

/**
 * Runs every boundary check and reports the results.
 */
function main(): void {
  const packages = discoverPackages();
  const problems = packages.flatMap(pkg => [...checkDependencyDirections(pkg), ...checkModules(pkg)]);

  const packageGraph = new Map(packages.map(pkg => [pkg.name, [...pkg.internalDependencies.keys()]]));
  const cycle = findCycle(packageGraph);
  if (cycle !== undefined)
    problems.push(`Circular workspace dependencies: ${cycle.join(" -> ")}`);

  if (problems.length > 0) {
    for (const problem of problems)
      console.error(`✖ ${problem}`);
    console.error(`\n${problems.length} boundary problem(s) found.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Boundaries OK: ${packages.length} workspace package(s) checked.`);
}

main();