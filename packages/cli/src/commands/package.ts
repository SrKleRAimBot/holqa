import type { CliHost } from "@/analysis/host";
import type { CliIo } from "@/io";

import {
  dirname,
  join,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";

import { createBindingManifest } from "@holqa/bindings";
import {
  canonicalJsonStringify,
  serializeManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf
} from "@holqa/core";

import {
  analyzeApplication,
  defaultAppModule,
  displayPath,
  reportDiagnostics
} from "@/commands/analysis-command";
import { defaultBindingsModule } from "@/commands/bindings-commands";
import { exitCodes } from "@/exit-codes";
import {
  artifactEntry,
  packageFailure,
  writeArtifact
} from "@/package/write-artifact";

/** Where artifacts go when `--out-dir` is not given: `<root>/.holqa/package/<binding name>`. */
export const defaultPackageDir = join(".holqa", "package");

/** The parsed options of `holqa package`. */
export interface PackageOptions {
  readonly app: string | undefined;
  readonly bindings: string | undefined;
  readonly outDir: string | undefined;
}

/**
 * Resolves the container runtime module the generated entry point imports.
 *
 * @returns Its absolute path.
 */
function containerModule(): string {
  return fileURLToPath(import.meta.resolve("@holqa/container"));
}

/**
 * Runs `holqa package`: analyzes the application, resolves and validates the
 * binding configuration (`--bindings`, default `bindings.ts` next to the
 * application module), and writes a deployment artifact for it: the bundled
 * application with the container runtime (`server.js`), the application
 * manifest, the binding manifest (`bindings.json`), static site files, a
 * reference Dockerfile and `artifact.json` with every file's hash. An invalid
 * binding configuration produces no artifact. Nothing is provisioned: the
 * artifact binds to infrastructure that already exists.
 *
 * @param host - The CLI host.
 * @param io - Output streams.
 * @param json - Whether output is machine-readable.
 * @param options - The `--app`, `--bindings` and `--out-dir` values.
 * @returns `0` on success, `1` when analysis, validation or writing fails.
 */
export async function packageCommand(host: CliHost, io: CliIo, json: boolean, options: PackageOptions): Promise<number> {
  const appPath = resolve(host.cwd, options.app ?? defaultAppModule);
  const bindingsPath = resolve(host.cwd, options.bindings ?? resolve(dirname(appPath), defaultBindingsModule));
  const result = await analyzeApplication(host, io, json, options.app, { bindingsPath });
  if (result === undefined)
    return exitCodes.failure;
  const { manifest, entrypoints, bindings: report } = result.analysis;
  if (report === undefined) {
    reportDiagnostics(io, json, [createDiagnostic({ code: diagnosticCodes.analysisFailed, severity: "error", message: "The analysis did not resolve the binding configuration; this CLI host does not support packaging." })]);
    return exitCodes.failure;
  }
  let bindingManifest;
  try {
    bindingManifest = createBindingManifest(report, { applicationManifest: entrypoints.manifest });
  } catch (error) {
    reportDiagnostics(io, json, diagnosticsOf(error));
    return exitCodes.failure;
  }
  const root = dirname(appPath);
  const outDir = options.outDir === undefined ? join(root, defaultPackageDir, report.name) : resolve(host.cwd, options.outDir);
  let written;
  try {
    written = await writeArtifact({
      root,
      appPath,
      bindingsPath,
      outDir,
      application: manifest.application.name,
      bindingsName: report.name,
      manifest: { text: `${serializeManifest(manifest)}\n`, fingerprint: entrypoints.manifest },
      bindingManifest: `${canonicalJsonStringify(bindingManifest)}\n`,
      handlers: entrypoints.handlers.map(handler => ({ id: handler.id, module: handler.module, export: handler.export })),
      staticSites: manifest.resources.flatMap(resource => resource.kind === "static.site" ? [{ id: resource.id, directory: resource.config.directory }] : []),
      containerModule: containerModule(),
      bunVersion: Bun.version
    });
  } catch (error) {
    reportDiagnostics(io, json, packageFailure(error, displayPath(host.cwd, outDir)));
    return exitCodes.failure;
  }
  const { descriptor, fingerprint } = written;
  const warnings = [...result.analysis.diagnostics, ...report.diagnostics];
  if (json) {
    io.stdout(canonicalJsonStringify({
      artifact: { path: displayPath(host.cwd, outDir), fingerprint, application: descriptor.application, bindings: descriptor.bindings, manifest: descriptor.manifest, entry: descriptor.entry, files: descriptor.files.length },
      diagnostics: warnings
    }));
    return exitCodes.success;
  }
  const bundle = descriptor.files.find(file => file.path === artifactEntry);
  io.stdout([
    `Packaged ${descriptor.application} with the binding "${descriptor.bindings}" into ${displayPath(host.cwd, outDir)}`,
    `  ${artifactEntry}: ${((bundle?.bytes ?? 0) / 1024).toFixed(1)} KiB; ${descriptor.files.length} files; static sites: ${descriptor.staticSites.length}`,
    `  artifact ${fingerprint}`,
    `  manifest ${descriptor.manifest}`,
    ...bindingManifest.credentials.length === 0 ? [] : [`  credentials it reads at start: ${bindingManifest.credentials.join(", ")}`],
    ...bindingManifest.connectors.map(connector => `  needs: ${connector.connector} (${connector.provider})`),
    `Run it with "bun ${artifactEntry}" in that directory, or build the image from its Dockerfile.`
  ].join("\n"));
  return exitCodes.success;
}