import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ErrorCodes } from "@pi-desktop/shared";
import { fetchPinnedDirect } from "../electron/main/public-https-direct.ts";
import {
  createPublicHttpsClient,
  PublicNetworkPolicyError,
} from "../electron/main/public-https-fetch.ts";

/**
 * Connection-time route policy for the public-network guard (ADR 0272).
 *
 * The guard judged the address a *local* resolver returned for every request,
 * while the request itself travels through the session's own proxy stack
 * (ADR 0177, ADR 0243). Under a Clash-style TUN / fake-IP resolver that local
 * answer is a synthesized `198.18.0.0/15` address — the address of a connection
 * this app never makes — so a proxied user was refused for an address the
 * transport never dials (issue #419).
 *
 * These tests pin the replacement: the verdict follows the route the transport
 * will actually take. A proxied route tolerates only the resolver-artifact
 * class, a direct route keeps the strict local verdict, and a route nobody can
 * read keeps the strict verdict too.
 */

const FAKE_IP = "198.18.0.1";
const LOOPBACK = "127.0.0.1";
const PROXIED = "PROXY 127.0.0.1:7890";

function response(status, body, location) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === "location" ? location ?? null : null) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** A client whose session reports `route` and whose resolver answers `address`. */
function clientFor({ route, address, addresses, fetchImpl, pinnedFetchImpl, allowFakeIp }) {
  return createPublicHttpsClient({
    fetchImpl: fetchImpl ?? (async () => response(200, "# skill\n")),
    lookupImpl: async () => addresses ?? (address ? [{ address }] : []),
    ...(route === undefined ? {} : { routeImpl: async () => route }),
    ...(pinnedFetchImpl ? { pinnedFetchImpl } : {}),
    ...(allowFakeIp === undefined ? {} : { allowFakeIp }),
  });
}

test("a direct request pins the selected IP and retains the original Host header", async (t) => {
  const server = createServer((request, outgoing) => {
    assert.equal(request.headers.host, `localhost:${server.address().port}`);
    outgoing.writeHead(200, { "content-type": "text/plain" });
    outgoing.end("pinned response");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetchPinnedDirect(
    `http://localhost:${server.address().port}/document`,
    { signal: AbortSignal.timeout(2_000) },
    { address: "127.0.0.1", family: 4 },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "pinned response");
});

test("a proxied route stops treating a fake-IP answer as a refusal", async () => {
  // The whole point of the change: `net.fetch` dials the proxy, so the local
  // `198.18.0.1` describes no connection this app makes. Before ADR 0272 this
  // exact case was a `NETWORK_POLICY_BLOCKED` refusal.
  const seen = [];
  const client = clientFor({
    route: PROXIED,
    address: FAKE_IP,
    fetchImpl: async (url) => {
      seen.push(url);
      return response(200, "# skill\n");
    },
  });
  const body = await client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text");
  assert.equal(body, "# skill\n");
  assert.deepEqual(seen, ["https://cdn.jsdelivr.net/gh/x/SKILL.md"]);
});

test("a proxied route still refuses an answer that names a real private target", async () => {
  // Only the resolver-artifact class is tolerated on a proxied route: an answer
  // that names an internal target is positive evidence of a split-horizon or
  // hostile resolver, and the app cannot see which address the proxy would dial.
  for (const address of ["10.0.0.8", LOOPBACK, "169.254.169.254"]) {
    const client = clientFor({
      route: PROXIED,
      address,
      fetchImpl: async () => {
        throw new Error("a refused request must never reach the network");
      },
    });
    await assert.rejects(
      () => client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"),
      (error) =>
        error instanceof PublicNetworkPolicyError &&
        error.reason === "non-public-address" &&
        error.addressKind !== "benchmark" &&
        error.host === "cdn.jsdelivr.net",
      `expected ${address} to stay refused on a proxied route`,
    );
  }
});

test("a proxied route still refuses an unanswered resolver", async () => {
  const client = clientFor({ route: PROXIED, address: null });
  await assert.rejects(
    () => client.assertPublicUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "resolve-failed" &&
      error.errorCode === ErrorCodes.NETWORK_RESOLVE_FAILED,
  );
});

test("a direct route keeps the strict verdict for fake-IP and private answers alike", async () => {
  for (const [address, addressKind] of [
    [FAKE_IP, "benchmark"],
    [LOOPBACK, "loopback"],
  ]) {
    const client = clientFor({
      route: "DIRECT",
      address,
      fetchImpl: async () => {
        throw new Error("a refused request must never reach the network");
      },
    });
    await assert.rejects(
      () => client.assertPublicUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md"),
      (error) =>
        error instanceof PublicNetworkPolicyError &&
        error.reason === "non-public-address" &&
        error.addressKind === addressKind &&
        error.route === "direct" &&
        error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED,
      `expected ${address} to stay refused on a direct route`,
    );
  }
});

test("a direct request pins its public answer when DNS also returns a ULA address", async () => {
  const pinned = [];
  const client = clientFor({
    route: "DIRECT",
    addresses: [{ address: "fd00::9c" }, { address: "151.101.1.229" }],
    fetchImpl: async () => {
      throw new Error("mixed DNS answers must use the pinned transport");
    },
    pinnedFetchImpl: async (_url, _init, address) => {
      pinned.push(address);
      return response(200, "# skill\n");
    },
  });

  assert.equal(await client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"), "# skill\n");
  assert.deepEqual(pinned, [{ address: "151.101.1.229", family: 4 }]);
});

test("a direct TUN request pins the opted-in benchmark answer instead of a paired ULA answer", async () => {
  const pinned = [];
  const client = clientFor({
    route: "DIRECT",
    addresses: [{ address: "fd00::9c" }, { address: FAKE_IP }],
    allowFakeIp: true,
    fetchImpl: async () => {
      throw new Error("paired fake-IP answers must use the pinned transport");
    },
    pinnedFetchImpl: async (_url, _init, address) => {
      pinned.push(address);
      return response(200, "# skill\n");
    },
  });

  assert.equal(await client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"), "# skill\n");
  assert.deepEqual(pinned, [{ address: FAKE_IP, family: 4 }]);
});

test("a direct ULA-only answer remains refused even with fake-IP tolerance", async () => {
  let fetched = false;
  const client = clientFor({
    route: "DIRECT",
    address: "fd00::9c",
    allowFakeIp: true,
    pinnedFetchImpl: async () => {
      fetched = true;
      return response(200, "# skill\n");
    },
    fetchImpl: async () => {
      fetched = true;
      return response(200, "# skill\n");
    },
  });

  await assert.rejects(
    () => client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"),
    (error) => error instanceof PublicNetworkPolicyError && error.addressKind === "ula",
  );
  assert.equal(fetched, false);
});
test("an explicit fake-IP opt-in permits only the benchmark class on a direct route", async () => {
  const client = clientFor({ route: "DIRECT", address: FAKE_IP, allowFakeIp: true });
  assert.equal(
    await client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"),
    "# skill\n",
  );

  const privateClient = clientFor({
    route: "DIRECT",
    address: "10.0.0.8",
    allowFakeIp: true,
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
  });
  await assert.rejects(
    () => privateClient.assertPublicUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md"),
    (error) => error instanceof PublicNetworkPolicyError && error.addressKind === "private",
  );
});

test("a route the transport cannot name falls back to the strict verdict", async () => {
  // Fail-closed: no route resolver at all, a resolver that throws, an empty
  // answer, and an answer Chromium could fall back to `DIRECT` from. Every one
  // of them judges the fake-IP answer exactly as the app did before ADR 0272.
  const unroutable = [
    undefined,
    () => Promise.reject(new Error("session unavailable")),
    () => Promise.reject("not an error"),
    async () => "",
    async () => "  ",
    async () => "PROXY 127.0.0.1:7890; DIRECT",
    async () => "DIRECT; PROXY 127.0.0.1:7890",
    async () => "MAGIC 127.0.0.1:7890",
    async () => null,
    async () => 7890,
  ];
  for (const routeImpl of unroutable) {
    const client = createPublicHttpsClient({
      fetchImpl: async () => {
        throw new Error("a refused request must never reach the network");
      },
      lookupImpl: async () => [{ address: FAKE_IP }],
      ...(routeImpl ? { routeImpl } : {}),
    });
    await assert.rejects(
      () => client.assertPublicUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md"),
      (error) =>
        error instanceof PublicNetworkPolicyError &&
        error.reason === "non-public-address" &&
        error.addressKind === "benchmark" &&
        error.route === "unknown",
      "an unreadable route is never permission",
    );
  }
});

test("every redirect hop asks for its own route", async () => {
  // The route is per hop, like the address verdict: a redirect can leave the
  // proxied path, and the hop that would be dialed directly must be judged.
  const seen = [];
  const client = createPublicHttpsClient({
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === "https://start.example/catalog.json") {
        return response(302, "", "https://next.example/catalog.json");
      }
      return response(200, { ok: true });
    },
    lookupImpl: async () => [{ address: FAKE_IP }],
    routeImpl: async (url) =>
      new URL(url).hostname === "start.example" ? PROXIED : "DIRECT",
  });
  await assert.rejects(
    () => client.request("https://start.example/catalog.json", "json"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "non-public-address" &&
      error.host === "next.example" &&
      error.route === "direct",
  );
  assert.deepEqual(seen, ["https://start.example/catalog.json"]);
});

test("the route a hop is judged on travels with its refusal", async () => {
  const client = clientFor({ route: PROXIED, address: null });
  try {
    await client.assertPublicUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md");
    assert.fail("expected a refusal");
  } catch (error) {
    assert.equal(error.route, "proxied");
  }
});

test("too many redirects stays a policy refusal and is not retried", async () => {
  let calls = 0;
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      calls += 1;
      return response(302, "", "https://next.example/hop");
    },
    lookupImpl: async () => [{ address: FAKE_IP }],
    routeImpl: async () => PROXIED,
  });
  await assert.rejects(
    () => client.request("https://start.example/catalog.json", "json"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "redirect-limit" &&
      error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED,
  );
  assert.equal(calls, 6);
});

test("the market catalog client asks the session that carries its fetch", async () => {
  // The guard can only follow the route when its caller wires the session whose
  // `fetch` it also passes in: `net.fetch` uses the default session (ADR 0272).
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../electron/main/skill-market-catalog.ts"),
    "utf8",
  );
  assert.match(source, /import \{ net, session \} from "electron"/);
  assert.match(source, /fetchImpl: \(url, init\) => net\.fetch\(url, init\)/);
  assert.match(source, /routeImpl: \(url\) => session\.defaultSession\.resolveProxy\(url\)/);
  assert.match(source, /pinnedFetchImpl: \(url, init, address\) => fetchPinnedDirect\(url, init, address\)/);
});

test("a user-supplied endpoint reaches its own LAN on any route", async () => {
  // `benchmark` is the only class the route decides for a third-party hop, and
  // it stays that way. A user-supplied endpoint is a different trust input: the
  // address is theirs, so a private one is dialed whether the session goes
  // direct or through a proxy.
  for (const route of ["DIRECT", PROXIED]) {
    const client = clientFor({ route, address: "10.0.0.8" });
    assert.equal(
      await client.request("https://nas.local/catalog.json", "text", "user"),
      "# skill\n",
    );
  }

  // The same address on the default origin keeps the strict verdict, whichever
  // route carries it.
  for (const route of ["DIRECT", PROXIED]) {
    const client = clientFor({
      route,
      address: "10.0.0.8",
      fetchImpl: async () => {
        throw new Error("a refused request must never reach the network");
      },
    });
    await assert.rejects(
      () => client.assertPublicUrl("https://nas.example/catalog.json"),
      (error) =>
        error instanceof PublicNetworkPolicyError &&
        error.reason === "non-public-address" &&
        error.addressKind === "private",
    );
  }

  // A fake-IP answer is the proxy's own placeholder rather than a service the
  // user runs, so it is refused on the user's own endpoint too unless the route
  // says this app dials a proxy — the same rule the third-party hop has.
  const fakeIp = clientFor({
    route: "DIRECT",
    address: FAKE_IP,
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
  });
  await assert.rejects(
    () => fakeIp.assertPublicUrl("https://nas.local/catalog.json", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "non-public-address" &&
      error.addressKind === "benchmark",
  );
});
