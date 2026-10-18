// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import type {
  QueryClient,
  UseMutationOptions,
  UseQueryOptions
} from "@tanstack/react-query";

import type {
  ProcedureInput,
  ProcedureOutput
} from "./generated/holqa-client";

import { createQueryOptions } from "@holqa/tanstack-query";

import { createClient } from "./generated/holqa-client";

/**
 * Browser-safe client from the compiler's planned client generation. It contains only
 * procedure IDs, input/output contracts and transport code; handlers, server
 * modules and secrets are never part of the generated output.
 */
const client = createClient({ baseUrl: "/api/rpc" });

/** TanStack Query helpers derived from the generated client, including stable query keys. */
const api = createQueryOptions(client);

/**
 * Builds query options for the most recent orders.
 *
 * @param limit - Maximum number of orders to fetch, validated again on the server.
 * @returns Options for `useQuery`, keyed by the `orders.list` procedure and its input.
 */
export function recentOrdersQuery(limit: number): UseQueryOptions<ProcedureOutput<"orders.list">> {
  return api.orders.list.queryOptions({ limit });
}

/**
 * Builds mutation options for placing an order and refreshing order lists afterwards.
 *
 * @param queryClient - The application's query client, used to invalidate cached lists.
 * @returns Options for `useMutation`; callers pass `{ sku, quantity, idempotencyKey }`.
 */
export function createOrderMutation(queryClient: QueryClient): UseMutationOptions<ProcedureOutput<"orders.create">, Error, ProcedureInput<"orders.create">> {
  return api.orders.create.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.orders.list.key() });
    }
  });
}