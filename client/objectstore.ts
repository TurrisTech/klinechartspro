// The one door to the OBJECT STORES: the chart tiles (tiles/), the stored-indicator tiles
// (indicatortiles/) and the book tiles (books/tiles.ts). Its counterpart for wdashboard-server
// is config.ts `serverFetch`; client/serverfetch.test.ts fails if a browser module reaches the
// network through anything else.
//
// These reads are ANONYMOUS and must stay so. Deployed, client/nginx.conf proxies /tiles/ and
// /indicator-tiles/ to the SeaweedFS S3 gateway with `proxy_pass_request_headers on`, so a
// header the browser sends reaches S3, which reads `Authorization` as a request signature: a
// bearer there is at best ignored and at worst fails the read, and either way it hands the
// session token to a system that has no use for it. In dev, client/devtiles.ts forwards only
// the conditional and range headers, for the same reason. The session's bearer is the
// server's business only, so this door never carries one, whatever a caller passes.
//
// Note what that means for the login: tiled bar and indicator history is readable by anyone
// who can reach the host, whatever the server enforces. The buckets allow anonymous reads.

export function objectStoreFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (init?.headers === undefined) return fetch(url, init)
  const headers = new Headers(init.headers)
  headers.delete('authorization')
  return fetch(url, { ...init, headers })
}
