---
"@holqa/core": minor
"@holqa/sdk": minor
"@holqa/compiler": minor
"@holqa/runtime-bun": minor
"@holqa/local": minor
"@holqa/testing": minor
"@holqa/cli": patch
---

Add static frontend hosting as the `static.site` resource kind.

- `@holqa/core`: the `static.site` kind (config `{ directory, basePath }`, requirement and capability `spaFallback`, driver `fetch(path, request)`), the `static.site` binding contract (mandatory for complete platforms), and its capability vocabulary (`static.site`, `static.site.spa-fallback`). `ResourceKind` and `DrivenResourceKind` gain a member, so exhaustive `switch`es over them need a new case.
- `@holqa/sdk`: `staticSite({ id, directory, basePath?, spa? })`.
- `@holqa/compiler`: normalizes static sites and records them in manifest version 1 (additive; manifests without sites are unchanged; older readers reject manifests with sites). The published manifest JSON Schema gains the `resource-static-site` definition.
- `@holqa/runtime-bun`: serves unmatched `GET` and `HEAD` requests from the static site with the longest matching base path; routes always win; two sites under one base path are `HOLQA_ROUTE_CONFLICT`.
- `@holqa/local`: local static hosting from the application root (`root` option) with SPA fallback and path traversal protection; the platform provider binds `static.site`.
- `@holqa/testing`: `createTestApp({ root })`.
- `@holqa/cli`: `holqa dev` and the operation commands serve static sites from the application root; inspection describes them.
