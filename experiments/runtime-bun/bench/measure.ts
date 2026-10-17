// Measures generation load time, per-invocation overhead and memory growth
// across reloads for both reload strategies. Run with `bun run bench`.
// Numbers are machine-dependent; record the machine with any result you quote.
import type { ReloadStrategy } from "@/hosts/types";

import { createRuntime } from "@/runtime";

import {
  basicEnv,
  copyFixture,
  removeFixtureCopies,
  setFixtureVersion
} from "../tests/support/fixture";

/**
 * Returns the median of a list of numbers.
 *
 * @param values - The samples.
 * @returns The median sample.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * Forces garbage collection and returns heap and resident memory in MiB.
 *
 * @returns The main thread's heap usage and the process's resident set size.
 */
function memory(): { readonly heapMiB: number; readonly rssMiB: number } {
  Bun.gc(true);
  const usage = process.memoryUsage();
  return { heapMiB: usage.heapUsed / 2 ** 20, rssMiB: usage.rss / 2 ** 20 };
}

/**
 * Rounds a number for display.
 *
 * @param value - The number.
 * @returns The value rounded to two decimals.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Measures one strategy.
 *
 * @param strategy - The reload strategy.
 * @param reloads - How many reloads to perform for the memory measurement.
 * @returns The measurements.
 */
async function measure(strategy: ReloadStrategy, reloads: number): Promise<Record<string, number | string>> {
  const root = copyFixture("basic");
  const runtime = createRuntime({ root, strategy, env: basicEnv, drainMs: 0 });
  let start = performance.now();
  const loaded = await runtime.load();
  if (!loaded.ok)
    throw new Error(JSON.stringify(loaded.error));
  const firstLoadMs = performance.now() - start;

  const input = { params: { name: "a" }, body: { value: "x" } };
  for (let index = 0; index < 200; index++)
    await runtime.invoke("echo", input);
  const sequential: number[] = [];
  for (let index = 0; index < 2000; index++) {
    start = performance.now();
    await runtime.invoke("echo", input);
    sequential.push(performance.now() - start);
  }
  start = performance.now();
  await Promise.all(Array.from({ length: 2000 }, async () => runtime.invoke("echo", input)));
  const concurrentMs = performance.now() - start;

  const before = memory();
  const reloadTimes: number[] = [];
  for (let index = 0; index < reloads; index++) {
    setFixtureVersion(root, `v${String(index + 2)}`);
    start = performance.now();
    const reloaded = await runtime.reload();
    reloadTimes.push(performance.now() - start);
    if (!reloaded.ok)
      throw new Error(JSON.stringify(reloaded.error));
    await runtime.invoke("echo", input);
  }
  await runtime.retired();
  await Bun.sleep(50);
  const after = memory();
  await runtime.dispose({ graceMs: 0 });

  return {
    strategy,
    firstLoadMs: round(firstLoadMs),
    reloadMedianMs: round(median(reloadTimes)),
    invokeMedianUs: round(median(sequential) * 1000),
    concurrent2000Ms: round(concurrentMs),
    [`heapGrowthMiBOver${String(reloads)}Reloads`]: round(after.heapMiB - before.heapMiB),
    [`rssGrowthMiBOver${String(reloads)}Reloads`]: round(after.rssMiB - before.rssMiB)
  };
}

/**
 * Measures both strategies and prints a Markdown table to standard output.
 *
 * @param reloads - How many reloads each strategy performs.
 */
async function main(reloads: number): Promise<void> {
  const results: Record<string, number | string>[] = [];
  for (const strategy of ["in-process", "worker"] as const)
    results.push(await measure(strategy, reloads));
  removeFixtureCopies();
  const columns = Object.keys(results[0] ?? {});
  const lines = [
    `Bun ${Bun.version} on ${process.platform}/${process.arch}`,
    "",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...results.map(result => `| ${columns.map(column => String(result[column])).join(" | ")} |`)
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main(Number(process.argv[2] ?? "50"));