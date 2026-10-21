// stdout is never cut short silently (fix plan 2026-10-21, D6; the kit's T6). When stdout is a
// regular file (`> out.json`), Node's stream wrote it with one writeSync and ignored a short
// count, so a file-size limit or a full disk cut the output short with exit 0. The unit test
// pins the writer; the process test is the case of conformance test P26 that applies to a repo
// without -o (P26 itself is about -o): stdout redirected to a file under `ulimit -f` exits 1
// with an ERROR record of bundeshaushalt.output.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { stdoutWriter } from "../src/cli/io.js";

/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

// The process test starts the built CLI: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bundeshaushalt-stdout-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
    // Not a file (a pipe, a terminal): the stream writes it, as before.
    const piped: string[] = [];
    stdoutWriter({ write: (text: string) => piped.push(text), emit: () => true })("data");
    assert.deepEqual(piped, ["data"]);
  });
});

/**
 * Run the bin with files limited to a few kB and stdout redirected to `stdoutFile`; SIGXFSZ
 * ignored, so a write fails with EFBIG. Node passes NODE_V8_COVERAGE to every child; under the
 * limit the child's coverage file would be cut short and break `npm run coverage`, so the shell
 * drops it.
 */
function runLimited(argv: string[], stdoutFile: string): Promise<{ code: number; stderr: string }> {
  const sh = `trap '' XFSZ; ulimit -f 8; unset NODE_V8_COVERAGE; exec "$0" "$@" > "$OUT"`;
  return new Promise((resolve) =>
    execFile("/bin/sh", ["-c", sh, process.execPath, BIN, ...argv], { env: { PATH: process.env.PATH ?? "", OUT: stdoutFile } }, (err, _stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr }),
    ),
  );
}

test("stdout redirected to a file and cut short is an error (exit 1, ERROR of output), never exit 0", STARTS_A_PROCESS, async () => {
  // An answer of about 200 kB: a budget element with 10 000 children.
  const children = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), label: `Titel ${i}`, value: i }));
  const answer = JSON.stringify({ meta: { year: 2024, account: "expenses" }, detail: { label: "Ausgaben", value: 1 }, children });
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(answer);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await inTempDir(async (dir) => {
      const cut = await runLimited(["--base-url", base, "--max-retries", "0", "expenses", "2024"], join(dir, "stdout.json"));
      assert.equal(cut.code, 1, cut.stderr);
      assert.match(cut.stderr, /ERROR \[bundeshaushalt\.output\] Could not write to stdout: .*EFBIG/, cut.stderr);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
