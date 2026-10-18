import type { JsonValue } from "@/json";
import type { DescriptorProtocol } from "@/protocol/version";
import type { StandardSchemaV1 } from "@/schema/standard-schema";

/**
 * A declared configuration entry: a secret or a non-sensitive variable, with
 * the schema its value must satisfy. Holds no value; values come from a
 * runtime binding.
 */
export interface ConfigDescriptor {
  readonly protocol: DescriptorProtocol;
  readonly type: "config";
  /** The entry's name: its key in the application's `env` declaration. */
  readonly name: string;
  /** `true` for secrets, which must never appear in manifests, logs or generated clients. */
  readonly sensitive: boolean;
  readonly schema: StandardSchemaV1;
  /** The value used when none is supplied. Only variables have defaults. */
  readonly defaultValue?: JsonValue;
}