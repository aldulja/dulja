const safeKey = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export async function serveUpdate(bucket: R2Bucket, pathname: string): Promise<Response> {
  const key = pathname.slice("/updates/".length);
  if (!key || !safeKey.test(key)) return new Response("bad request", { status: 400 });
  const object = await bucket.get(key);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    headers: { ETag: object.httpEtag, "Cache-Control": "public, max-age=60" },
  });
}
