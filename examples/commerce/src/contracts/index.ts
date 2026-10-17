// Re-exported so infra.ts imports contracts through one module, as larger apps would.
export {
  amount,
  orderLine,
  orderPlaced,
  paymentEvent,
  sku
} from "@/src/contracts/orders";