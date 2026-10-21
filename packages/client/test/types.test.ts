// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings, and the runtime rule those types promise (an option given as undefined is omitted).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BundeshaushaltClient } from "../src/index.js";
import { constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "bundeshaushalt-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { BundeshaushaltClient, type BudgetParams, type EngineOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const client = new BundeshaushaltClient({ baseUrl: process.env.BUNDESHAUSHALT_BASE_URL, timeoutMs: 15_000 });",
        "const optional: Omit<BudgetParams, \"year\" | \"account\"> = allUndefined<Omit<BudgetParams, \"year\" | \"account\">>();",
        "export const label = async (): Promise<string> => (await client.budgetData({ year: 2024, account: \"expenses\", ...optional })).detail.label as string;",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson({ meta: {}, detail: {} });
  const client = new BundeshaushaltClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    onWarning: undefined,
    bigIntegerKeys: undefined,
    transport: mt.transport,
  });
  await client.budgetData({ year: 2024, account: "expenses", quota: undefined, unit: undefined, id: undefined });
  assert.equal(mt.last().url, "https://bundeshaushalt.de/internalapi/budgetData?year=2024&account=expenses");
  assert.equal(mt.last().headers?.["User-Agent"], "bundeshaushalt-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
});
