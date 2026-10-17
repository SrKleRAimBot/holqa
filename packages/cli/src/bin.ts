#!/usr/bin/env bun
import { runCli } from "@/run";

import packageJson from "../package.json" with { type: "json" };

process.exitCode = runCli(process.argv.slice(2), {
  stdout: text => process.stdout.write(`${text}\n`),
  stderr: text => process.stderr.write(`${text}\n`)
}, packageJson.version);