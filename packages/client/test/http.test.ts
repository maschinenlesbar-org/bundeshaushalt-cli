import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { nodeHttpTransport } from "../src/http.js";
import { HaushaltNetworkError } from "../src/errors.js";

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

/** Serve one raw HTTP answer from a TCP server for one test and return its base URL. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds (I)", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(res.body.equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof HaushaltNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x", "alice:s3cret-pw@h.example/x"]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof HaushaltNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof HaushaltNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});
