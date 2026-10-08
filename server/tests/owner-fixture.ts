import assert from "node:assert/strict";

export async function ownerFixture(origin: string, register = true, username = "test-owner") {
  const response = await globalThis.fetch(origin + (register ? "/api/auth/register" : "/api/auth/login"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test-only-owner-password-not-a-real-secret" }),
  });
  assert.equal(response.status, 200);
  const { user } = await response.json() as { user: { id: string; username: string } };
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", [cookie, headers.get("cookie")].filter(Boolean).join("; "));
    return globalThis.fetch(input, { ...init, headers });
  };
  return { user, cookie, fetch };
}
