#!/usr/bin/env bun
import { createProcessHost } from "@/analysis/process-host";
import { runCli } from "@/run";

import packageJson from "../package.json" with { type: "json" };

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: text => process.stdout.write(`${text}\n`),
  stderr: text => process.stderr.write(`${text}\n`)
}, packageJson.version, createProcessHost());