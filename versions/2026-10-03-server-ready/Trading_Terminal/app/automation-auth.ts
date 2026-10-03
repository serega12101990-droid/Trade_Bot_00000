import type { NextRequest } from "next/server";

async function configuredToken() {
  try {
    const { env } = await import("cloudflare:workers");
    const value = String(env.NORTHSTAR_AUTOMATION_TOKEN ?? "").trim();
    if (value) return value;
  } catch {
    // Node-based tests and tooling do not expose Cloudflare bindings.
  }
  return typeof process === "undefined" ? "" : String(process.env.NORTHSTAR_AUTOMATION_TOKEN ?? "").trim();
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export async function authorizeAutomationRequest(request: NextRequest) {
  if (isLoopbackHost(request.nextUrl.hostname)) return true;
  const token = await configuredToken();
  if (token) {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization === `Bearer ${token}`;
  }
  // A remote automation endpoint is never enabled without an explicit token.
  return false;
}
