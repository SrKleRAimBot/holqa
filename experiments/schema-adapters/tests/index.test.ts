import type {
  InferInput,
  InferOutput,
  StandardSchemaV1
} from "@holqa/experiment-model";

import {
  readdirSync,
  readFileSync
} from "node:fs";
import {
  getHandlerDescriptor,
  InputValidationError,
  isStandardSchema,
  validateInput
} from "@holqa/experiment-model";
import {
  defineApp,
  queue
} from "@holqa/experiment-sdk";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import * as v from "valibot";
import { z } from "zod";

import {
  valibotAdapter,
  zodAdapter
} from "@/index";

/** The same logical order message, declared once per library. */
const zodOrder = z.object({
  orderId: z.uuid(),
  quantity: z.int().min(1),
  priority: z.enum(["normal", "urgent"]).default("normal")
});

/** The Valibot equivalent of {@link zodOrder}. */
const valibotOrder = v.object({
  orderId: v.pipe(v.string(), v.uuid()),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
  priority: v.optional(v.picklist(["normal", "urgent"]), "normal")
});

/**
 * Collects the contents of every file in a package's `dist/` directory.
 *
 * @param experiment - The experiment directory name, for example `model`.
 * @returns The concatenated file contents.
 */
function distContents(experiment: string): string {
  const directory = new URL(`../../${experiment}/dist/`, import.meta.url);
  const files = readdirSync(directory);
  expect(files.length).toBeGreaterThan(0);
  return files.map(file => readFileSync(new URL(file, directory), "utf8")).join("\n");
}

/** A Standard Schema written by hand, without any schema library. */
const handwrittenSku: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "handwritten",
    validate: value => typeof value === "string" && value.startsWith("SKU-") ? { value } : { issues: [{ message: "Expected an SKU." }] }
  }
};

describe("schema interoperability", () => {
  it("produces different JSON Schema for the same logical schema in Zod and Valibot", () => {
    const fromZod = zodAdapter.convert(zodOrder, "input");
    const fromValibot = valibotAdapter.convert(valibotOrder, "input");
    if (!fromZod.ok || !fromValibot.ok)
      throw new Error("Both conversions should succeed.");
    expect(fromZod.value.jsonSchema).not.toEqual(fromValibot.value.jsonSchema);
    expect(fromZod.value.jsonSchema).toMatchObject({ properties: { quantity: { type: "integer", minimum: 1, maximum: 9007199254740991 } } });
    expect(fromValibot.value.jsonSchema).toMatchObject({ properties: { quantity: { type: "integer", minimum: 1 } } });
    // Zod adds a validation pattern to the uuid format; Valibot emits the format only.
    expect(fromZod.value.jsonSchema).toMatchObject({ properties: { orderId: { type: "string", format: "uuid" } } });
    expect(JSON.stringify(fromZod.value.jsonSchema)).toContain("pattern");
    expect(JSON.stringify(fromValibot.value.jsonSchema)).not.toContain("pattern");
    // Both libraries treat the defaulted property as optional on the input side.
    expect(fromZod.value.jsonSchema).toMatchObject({ required: ["orderId", "quantity"] });
    expect(fromValibot.value.jsonSchema).toMatchObject({ required: ["orderId", "quantity"] });
  });

  it("validates both libraries through the neutral validateInput", async () => {
    const message = { orderId: "6f1c3a52-1f3e-4b7a-9a2e-0c2b1f6d8e11", quantity: 2 };
    expect(await validateInput(zodOrder, message, "order")).toEqual({ ...message, priority: "normal" });
    expect(await validateInput(valibotOrder, message, "order")).toEqual({ ...message, priority: "normal" });
  });

  it("normalizes issue paths from both libraries", async () => {
    const zodLines = z.object({ lines: z.array(z.object({ quantity: z.int().min(1) })) });
    const valibotLines = v.object({ lines: v.array(v.object({ quantity: v.pipe(v.number(), v.minValue(1)) })) });
    for (const schema of [zodLines, valibotLines]) {
      const error = await validateInput(schema, { lines: [{ quantity: 0 }] }, "order").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as InputValidationError).issues.map(issue => issue.path)).toEqual(["lines.0.quantity"]);
      expect((error as InputValidationError).diagnostic.code).toBe("HOLQA_INPUT_INVALID");
    }
  });

  it("awaits asynchronous validation from both libraries", async () => {
    const zodAsync = z.string().refine(async value => value === "ok");
    const valibotAsync = v.pipeAsync(v.string(), v.checkAsync(async value => value === "ok"));
    for (const schema of [zodAsync, valibotAsync]) {
      expect(schema["~standard"].validate("ok")).toBeInstanceOf(Promise);
      expect(await validateInput(schema, "ok", "value")).toBe("ok");
      expect(validateInput(schema, "no", "value")).rejects.toBeInstanceOf(InputValidationError);
    }
  });

  it("keeps the built model and SDK free of any schema library import or type reference", () => {
    // Comments and hints may name libraries as examples; imports and type references may not.
    const reference = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:zod|valibot|@valibot\/[^"']*|@standard-schema\/[^"']*)["']|\bZod[A-Z]\w*|\bv\.GenericSchema/;
    for (const experiment of ["model", "sdk"]) {
      const contents = distContents(experiment);
      expect(contents).not.toMatch(reference);
      expect(contents).toContain("~standard");
    }
  });

  it("lets the SDK accept a hand-written Standard Schema", async () => {
    expect(isStandardSchema(handwrittenSku)).toBe(true);
    const skus = queue({ id: "skus", message: handwrittenSku, schemaVersion: 1 });
    defineApp({ name: "handwritten", handlers: [], resources: { skus } });
    const seen: string[] = [];
    const consumer = getHandlerDescriptor(skus.consume({ id: "skus.consume", handler: ({ message }) => {
      seen.push(message);
    } }));
    const context = { invocationId: "1", signal: new AbortController().signal, metadata: {}, log: { info: () => undefined, warn: () => undefined, error: () => undefined } };
    await consumer?.invoke("SKU-1", context);
    expect(seen).toEqual(["SKU-1"]);
    expect(consumer?.invoke("nope", context)).rejects.toBeInstanceOf(InputValidationError);
  });

  it("infers input and output types from library schemas through the neutral model types", () => {
    const _transformed = z.string().transform(value => value.length);
    expectTypeOf<InferInput<typeof _transformed>>().toEqualTypeOf<string>();
    expectTypeOf<InferOutput<typeof _transformed>>().toEqualTypeOf<number>();

    expectTypeOf<InferInput<typeof zodOrder>>().toEqualTypeOf<{ orderId: string; quantity: number; priority?: "normal" | "urgent" | undefined }>();
    expectTypeOf<InferOutput<typeof zodOrder>>().toEqualTypeOf<{ orderId: string; quantity: number; priority: "normal" | "urgent" }>();
    expectTypeOf<InferInput<typeof valibotOrder>>().toEqualTypeOf<{ orderId: string; quantity: number; priority?: "normal" | "urgent" | undefined }>();
    expectTypeOf<InferOutput<typeof valibotOrder>>().toEqualTypeOf<{ orderId: string; quantity: number; priority: "normal" | "urgent" }>();

    const _valibotTransformed = v.pipe(v.string(), v.transform(value => value.length));
    expectTypeOf<InferOutput<typeof _valibotTransformed>>().toEqualTypeOf<number>();
    expectTypeOf<InferOutput<typeof handwrittenSku>>().toEqualTypeOf<string>();

    // A value that does not implement Standard Schema is rejected at compile time.
    // @ts-expect-error -- `{ parse }` is not a Standard Schema.
    expectTypeOf<InferInput<{ parse: (value: unknown) => string }>>().toBeString();

    // Producers send the input type and consumers receive the output type.
    const _orders = queue({ id: "orders", message: zodOrder, schemaVersion: 1 });
    expectTypeOf<Parameters<typeof _orders.send>[0]>().toEqualTypeOf<InferInput<typeof zodOrder>>();
  });
});