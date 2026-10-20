import {
  externalBindings,
  provisioningOf
} from "@/app/environments";

/**
 * Provisions environment B's queues, notification exchange, bucket and
 * notification rule for the Docker Compose demonstration, from the host:
 * the store is reached on its published port, and RABBITMQ_ADMIN_URL,
 * S3_ADMIN_ACCESS_KEY_ID and S3_ADMIN_SECRET_ACCESS_KEY are read from the
 * environment of `holqa provision apply`.
 */
export default provisioningOf(externalBindings(), "arn:rustfs:sqs::primary:amqp", "http://localhost:29000");