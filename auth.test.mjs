import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveKey } from "./auth.ts";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authFile(value) {
  const dir = mkdtempSync(join(tmpdir(), "pi-openlimits-auth-"));
  dirs.push(dir);
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("resolveKey", () => {
  test("reads Pi's canonical api_key credential shape", () => {
    const result = resolveKey({
      env: {},
      authPath: authFile({ openlimits: { type: "api_key", key: "sk-ol-canonical" } }),
    });
    expect(result).toEqual({ apiKey: "sk-ol-canonical", source: "auth.json:openlimits" });
  });

  test("keeps environment precedence", () => {
    const result = resolveKey({
      env: { OPENLIMITS_API_KEY: "sk-ol-env" },
      authPath: authFile({ openlimits: { type: "api_key", key: "sk-ol-file" } }),
    });
    expect(result).toEqual({ apiKey: "sk-ol-env", source: "env:OPENLIMITS_API_KEY" });
  });

  test("does not return a literal missing credential", () => {
    expect(resolveKey({ env: {}, authPath: authFile({}) })).toEqual({ source: "missing" });
  });
});
