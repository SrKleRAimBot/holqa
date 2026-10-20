// Uploads one document through the API and its signed URL, then waits until
// the background pipeline has processed it. Runs inside the Compose network,
// where the signed URL's host (the store's service name) resolves.

/** The document's content. */
const text = "Holqa runs the same handlers locally and on external infrastructure.\nThis document went through S3 notifications, RabbitMQ and a queue consumer.\n";

/**
 * Uploads the document and polls its status until it is processed.
 *
 * @param api - The application's base URL.
 * @returns The exit code: 0 when processed within a minute.
 */
async function main(api: string): Promise<number> {
  const accepted = await fetch(`${api}/api/documents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: "demo.txt", contentType: "text/plain", size: new TextEncoder().encode(text).length }) });
  if (accepted.status !== 201)
    throw new Error(`The upload was not accepted: ${accepted.status} ${await accepted.text()}`);
  const { documentId, upload } = await accepted.json() as { documentId: string; upload: { url: string; method: string; headers: Record<string, string> } };
  const stored = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: text });
  process.stdout.write(`accepted ${documentId}; upload answered ${stored.status}\n`);
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await (await fetch(`${api}/api/documents/${documentId}`)).json() as { status: string };
    if (status.status === "processed") {
      process.stdout.write(`${JSON.stringify(status, undefined, 2)}\n`);
      return 0;
    }
    await Bun.sleep(500);
  }
  process.stderr.write("The document was not processed within a minute.\n");
  return 1;
}

const { API: api = "http://app:3000" } = process.env;
main(api).then(code => process.exit(code), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});