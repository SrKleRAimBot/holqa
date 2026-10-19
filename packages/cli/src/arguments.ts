/** Which options a command accepts. */
export interface OptionSpec {
  /** Options that take no value, such as `--manifest`. */
  readonly flags: readonly string[];
  /** Options that take a value, written `--name value` or `--name=value`. */
  readonly values: readonly string[];
  /** The names of the positional arguments the command requires, in order, for messages. Default none. */
  readonly positionals?: readonly string[];
}

/** Parsed command options, or the problems that prevented parsing. */
export type ParsedOptions
  = | { readonly ok: true; readonly flags: ReadonlySet<string>; readonly values: ReadonlyMap<string, string>; readonly positionals: readonly string[] }
    | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Parses the options that follow a command's words. Every argument must be a
 * known option or one of the command's positional arguments, exactly as many
 * as it requires; extra positionals and repeated options are rejected so
 * that a typo never silently changes what a command does. An argument after
 * `--` is always positional, so values may start with `--`.
 *
 * @param args - The arguments after the command word, without `--json`.
 * @param spec - The options the command accepts.
 * @returns The flags and values, or every problem found.
 */
export function parseOptions(args: readonly string[], spec: OptionSpec): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const problems: string[] = [];
  const expected = spec.positionals ?? [];
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--" && !literal) {
      literal = true;
      continue;
    }
    if (literal || !argument.startsWith("--")) {
      if (positionals.length < expected.length)
        positionals.push(argument);
      else
        problems.push(`Unexpected argument "${argument}".`);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (spec.flags.includes(name)) {
      if (equals !== -1)
        problems.push(`The option "--${name}" takes no value.`);
      else if (flags.has(name))
        problems.push(`The option "--${name}" is given more than once.`);
      else
        flags.add(name);
    } else if (spec.values.includes(name)) {
      const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
      if (equals === -1 && value !== undefined && !value.startsWith("--"))
        index++;
      if (value === undefined || value === "" || (equals === -1 && value.startsWith("--")))
        problems.push(`The option "--${name}" requires a value.`);
      else if (values.has(name))
        problems.push(`The option "--${name}" is given more than once.`);
      else
        values.set(name, value);
    } else {
      problems.push(`Unknown option "--${name}".`);
    }
  }
  for (const name of expected.slice(positionals.length))
    problems.push(`The argument <${name}> is missing.`);
  return problems.length === 0 ? { ok: true, flags, values, positionals } : { ok: false, problems };
}