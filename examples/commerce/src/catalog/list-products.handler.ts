import { z } from "zod";

import { resources } from "@/infra";
import { catalog } from "@/src/store";

/** `GET /api/products?category=office`: lists the catalog, optionally filtered. */
export default resources.api.route({
  id: "catalog.list",
  method: "GET",
  path: "/products",
  query: z.object({ category: z.enum(["kitchen", "office"]).optional() }),
  responses: {
    200: z.object({ products: z.array(z.object({ sku: z.string(), name: z.string(), price: z.number() })) })
  },
  handler: ({ query, reply }) => reply(200, {
    products: [...catalog]
      .filter(([, product]) => query.category === undefined || product.category === query.category)
      .map(([sku, product]) => ({ sku, name: product.name, price: product.price }))
  })
});