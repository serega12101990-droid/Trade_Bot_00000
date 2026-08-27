interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type D1Database = import("drizzle-orm/d1").DrizzleD1Database<Record<string, never>>["$client"];

declare module "cloudflare:workers" {
  export const env: { DB?: D1Database };
}
