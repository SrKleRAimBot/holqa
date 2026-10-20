# @holqa/s3

An S3-compatible object storage binding provider for Holqa buckets: SigV4-signed object operations, paged listing and
presigned URLs over `fetch`, and object events from S3 event notifications delivered through a separate event channel.

> **Status:** Implemented, private and unpublished. The API may change before the first release.

```ts
s3.buckets({ endpoint: "http://object-store:9000", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") });
```

The provider never creates buckets or configures notifications: provision them first. It depends only on
`@holqa/core`. See the [S3-compatible provider reference](../../../docs/reference/providers/s3.md).
