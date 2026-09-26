import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { nodeHttpTransport } from "../src/client/http.js";
import { HaushaltNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/internalapi/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/internalapi/" });
    },
  );
});

test("transparently decompresses a gzip-encoded body and strips the encoding header", async () => {
  const payload = JSON.stringify({ ok: true });
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-type", "application/json");
      res.end(zlib.gzipSync(Buffer.from(payload)));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: baseUrl });
      assert.equal(resp.body.toString("utf8"), payload);
      assert.equal(resp.headers["content-encoding"], undefined);
    },
  );
});

test("rejects an unsupported protocol with HaushaltNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    HaushaltNetworkError,
  );
});

test("a non-Latin-1 header value rejects with HaushaltNetworkError, not a raw TypeError", async () => {
  // Node's outgoing-header validation throws a synchronous TypeError for a value
  // outside Latin-1 (emoji/CJK). It must surface as the typed transport error.
  await assert.rejects(
    () =>
      nodeHttpTransport({
        method: "GET",
        url: "https://example.test/x",
        headers: { "User-Agent": "🌦" },
      }),
    HaushaltNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        HaushaltNetworkError,
      );
    },
  );
});

test("rejects a malformed URL with HaushaltNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "not a url" }),
    HaushaltNetworkError,
  );
});

test("rejects on a connection error with HaushaltNetworkError", async () => {
  // Port 1 on loopback is (essentially always) refused.
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:1/x", timeoutMs: 2000 }),
    HaushaltNetworkError,
  );
});

test("a timeout above setTimeout's 32-bit ceiling is clamped, not warned about", async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error): void => {
    warnings.push(w.name);
  };
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => res.end("{}"),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({
          method: "GET",
          url: baseUrl,
          timeoutMs: 2_147_483_648,
        });
        assert.equal(resp.status, 200);
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", onWarning);
  }
  assert.ok(
    !warnings.includes("TimeoutOverflowWarning"),
    `unexpected warnings: ${warnings.join(", ")}`,
  );
});

test("timeoutMs bounds the whole response, not just idle gaps", async () => {
  // A server that trickles a byte every 50 ms for 2 s never goes idle for the timeout.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const drip = setInterval(() => res.write(" "), 50);
      const finish = setTimeout(() => res.end("]"), 2000);
      res.on("close", () => {
        clearInterval(drip);
        clearTimeout(finish);
      });
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 300 }),
        (err) => err instanceof HaushaltNetworkError && /timed out after 300ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    },
  );
});

test("times out a stalled response with HaushaltNetworkError", async () => {
  await withServer(
    () => {
      /* never responds */
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 50 }),
        (err) => err instanceof HaushaltNetworkError && /timed out/.test(err.message),
      );
    },
  );
});

test("userinfo in the URL is sent as Basic auth; a failure message redacts it", async () => {
  let auth: string | undefined;
  await withServer(
    (req, res) => {
      auth = req.headers.authorization;
      res.end("{}");
    },
    async (baseUrl) => {
      await nodeHttpTransport({ method: "GET", url: baseUrl.replace("http://", "http://user:pw@") + "/x" });
    },
  );
  assert.equal(auth, `Basic ${Buffer.from("user:pw").toString("base64")}`);

  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "http://user:secret@127.0.0.1:1/x" }),
    (err: unknown) =>
      err instanceof HaushaltNetworkError && !err.message.includes("secret") && err.message.includes("http://***@127.0.0.1:1/x"),
  );
});
