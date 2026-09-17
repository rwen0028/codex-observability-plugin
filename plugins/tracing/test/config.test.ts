import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";

const tmpDirs: string[] = [];

function makeTmpHome(file?: { rel: string; contents: unknown }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-"));
  tmpDirs.push(dir);
  if (file) {
    const full = path.join(dir, file.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(file.contents));
  }
  return dir;
}

function makeJwt(payload: unknown): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const emptyHome = () => makeTmpHome();

describe("getConfig", () => {
  it("defaults to disabled with EU cloud base URL", async () => {
    const home = emptyHome();
    const config = await getConfig({ home, cwd: emptyHome(), env: {} });
    expect(config.enabled).toBe(false);
    expect(config.base_url).toBe("https://cloud.langfuse.com");
    expect(config.max_chars).toBe(20_000);
    expect(config.fail_on_error).toBe(false);
    expect(config.pricing_mode).toBe("standard");
    expect(config.regional_processing).toBe(false);
    expect(config.support_context_dir).toBe(path.join(home, ".codex/cctrace/support-context"));
  });

  it("resolves the support context directory from CODEX_HOME or an explicit override", async () => {
    const codexHome = emptyHome();
    const fromCodexHome = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: { CODEX_HOME: codexHome },
    });
    expect(fromCodexHome.support_context_dir).toBe(path.join(codexHome, "cctrace/support-context"));

    const explicit = path.join(emptyHome(), "support-sidecars");
    const overridden = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: { LANGFUSE_CODEX_SUPPORT_CONTEXT_DIR: explicit },
    });
    expect(overridden.support_context_dir).toBe(explicit);
  });

  it("uses the selected Codex home without merging the default home configuration", async () => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: {
        enabled: false,
        public_key: "pk-default",
        secret_key: "sk-default",
        base_url: "https://default.invalid",
        tags: ["ordinary-codex"],
        metadata: { source: "default-home" },
        trace_seed: "default-seed",
      },
    });
    const codexHome = path.join(home, ".solidagent", "codex-home", "default");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "langfuse.json"),
      JSON.stringify({
        enabled: true,
        public_key: "pk-solidagent",
        secret_key: "sk-solidagent",
        base_url: "https://solidagent.invalid",
      }),
    );
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: { id_token: makeJwt({ email: "solidagent@example.invalid" }) },
      }),
    );
    const config = await getConfig({ home, cwd: emptyHome(), env: { CODEX_HOME: codexHome } });
    expect(config).toMatchObject({
      enabled: true,
      public_key: "pk-solidagent",
      secret_key: "sk-solidagent",
      base_url: "https://solidagent.invalid",
      user_id: "solidagent@example.invalid",
      support_context_dir: path.join(codexHome, "cctrace", "support-context"),
    });
    expect(config.tags).toBeUndefined();
    expect(config.metadata).toBeUndefined();
    expect(config.trace_seed).toBeUndefined();
  });

  it.each(["missing", "invalid", "partial"])(
    "does not fall back to ordinary Codex credentials when the selected config is %s",
    async (scenario) => {
      const home = makeTmpHome({
        rel: ".codex/langfuse.json",
        contents: { enabled: true, public_key: "pk-default", secret_key: "sk-default" },
      });
      const codexHome = emptyHome();
      if (scenario !== "missing") {
        fs.writeFileSync(
          path.join(codexHome, "langfuse.json"),
          scenario === "invalid"
            ? "{ broken"
            : JSON.stringify({ enabled: true, public_key: "pk-isolated" }),
        );
      }
      const config = await getConfig({ home, cwd: emptyHome(), env: { CODEX_HOME: codexHome } });
      expect(config.secret_key).toBeUndefined();
      expect(config.public_key).toBe(scenario === "partial" ? "pk-isolated" : undefined);
      expect(config.enabled).toBe(scenario === "partial");
    },
  );

  it("does not reinterpret the default global config as project config when cwd is the user home", async () => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { enabled: true, public_key: "pk-default", secret_key: "sk-default" },
    });
    const config = await getConfig({ home, cwd: home, env: { CODEX_HOME: emptyHome() } });
    expect(config.enabled).toBe(false);
    expect(config.public_key).toBeUndefined();
    expect(config.secret_key).toBeUndefined();
  });

  it.each(["", "   "])("keeps the default home when CODEX_HOME is blank (%j)", async (value) => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { enabled: true, public_key: "pk-default", secret_key: "sk-default" },
    });
    const config = await getConfig({ home, cwd: home, env: { CODEX_HOME: value } });
    expect(config).toMatchObject({
      enabled: true,
      public_key: "pk-default",
      secret_key: "sk-default",
    });
  });

  it("keeps project and environment overrides above the selected Codex home", async () => {
    const codexHome = makeTmpHome({
      rel: "langfuse.json",
      contents: {
        enabled: true,
        public_key: "pk-selected",
        secret_key: "sk-selected",
        tags: ["selected"],
      },
    });
    const cwd = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { tags: ["project"], max_chars: 1234 },
    });
    const config = await getConfig({
      home: emptyHome(),
      cwd,
      env: { CODEX_HOME: codexHome, LANGFUSE_CODEX_MAX_CHARS: "4321" },
    });
    expect(config).toMatchObject({
      enabled: true,
      public_key: "pk-selected",
      secret_key: "sk-selected",
      tags: ["project"],
      max_chars: 4321,
    });
  });

  it("reads credentials and enable flag from environment variables", async () => {
    const config = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: {
        TRACE_TO_LANGFUSE: "true",
        LANGFUSE_PUBLIC_KEY: "pk-lf-1",
        LANGFUSE_SECRET_KEY: "sk-lf-1",
        LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.public_key).toBe("pk-lf-1");
    expect(config.secret_key).toBe("sk-lf-1");
    expect(config.base_url).toBe("https://us.cloud.langfuse.com");
  });

  it("prefers LANGFUSE_CODEX_* over the standard LANGFUSE_* variables", async () => {
    const config = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: {
        TRACE_TO_LANGFUSE: "1",
        LANGFUSE_PUBLIC_KEY: "pk-standard",
        LANGFUSE_CODEX_PUBLIC_KEY: "pk-codex",
        LANGFUSE_SECRET_KEY: "sk-standard",
      },
    });
    expect(config.public_key).toBe("pk-codex");
    expect(config.secret_key).toBe("sk-standard");
  });

  it("uses the Codex auth email as the default user id when available", async () => {
    const home = makeTmpHome({
      rel: ".codex/auth.json",
      contents: {
        tokens: {
          id_token: makeJwt({ email: "  user@example.com  " }),
        },
      },
    });

    const config = await getConfig({ home, cwd: emptyHome(), env: {} });

    expect(config.user_id).toBe("user@example.com");
  });

  it("reads the Codex auth email from CODEX_HOME when set", async () => {
    const codexHome = makeTmpHome({
      rel: "auth.json",
      contents: {
        tokens: {
          id_token: makeJwt({ email: "codex-home@example.com" }),
        },
      },
    });

    const config = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: { CODEX_HOME: codexHome },
    });

    expect(config.user_id).toBe("codex-home@example.com");
  });

  it("ignores missing or malformed Codex auth email claims", async () => {
    const home = makeTmpHome({
      rel: ".codex/auth.json",
      contents: {
        tokens: {
          id_token: makeJwt({ name: "Codex User" }),
        },
      },
    });

    const config = await getConfig({ home, cwd: emptyHome(), env: {} });

    expect(config.user_id).toBeUndefined();
  });

  it("keeps explicit user id config ahead of the Codex auth email", async () => {
    const home = makeTmpHome({
      rel: ".codex/auth.json",
      contents: {
        tokens: {
          id_token: makeJwt({ email: "codex@example.com" }),
        },
      },
    });

    const config = await getConfig({
      home,
      cwd: emptyHome(),
      env: { LANGFUSE_CODEX_USER_ID: "configured-user" },
    });

    expect(config.user_id).toBe("configured-user");
  });

  it("parses tags (JSON array or comma-separated) and metadata JSON", async () => {
    const jsonArray = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: {
        TRACE_TO_LANGFUSE: "yes",
        LANGFUSE_CODEX_TAGS: '["a","b"]',
        LANGFUSE_CODEX_METADATA: '{"team":"infra","n":5}',
      },
    });
    expect(jsonArray.tags).toEqual(["a", "b"]);
    expect(jsonArray.metadata).toEqual({ team: "infra", n: "5" });

    const csv = await getConfig({
      home: emptyHome(),
      cwd: emptyHome(),
      env: { TRACE_TO_LANGFUSE: "on", LANGFUSE_CODEX_TAGS: "x, y ,z" },
    });
    expect(csv.tags).toEqual(["x", "y", "z"]);
  });

  it("layers global config, local config, then env (highest precedence)", async () => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { enabled: true, public_key: "pk-global", base_url: "https://global" },
    });
    const cwd = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { public_key: "pk-local" },
    });

    const config = await getConfig({
      home,
      cwd,
      env: { LANGFUSE_BASE_URL: "https://env" },
    });

    expect(config.enabled).toBe(true); // from global
    expect(config.public_key).toBe("pk-local"); // local overrides global
    expect(config.base_url).toBe("https://env"); // env overrides both
  });

  it("ignores malformed JSON config files", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-"));
    tmpDirs.push(home);
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "langfuse.json"), "{ not json ");

    const config = await getConfig({ home, cwd: emptyHome(), env: {} });
    expect(config.enabled).toBe(false);
  });

  it("leaves trace_seed unset by default and reads it from config files and env", async () => {
    const unset = await getConfig({ home: emptyHome(), cwd: emptyHome(), env: {} });
    expect(unset.trace_seed).toBeUndefined();

    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { trace_seed: "seed-from-file" },
    });

    const fromFile = await getConfig({ home, cwd: emptyHome(), env: {} });
    expect(fromFile.trace_seed).toBe("seed-from-file");

    const fromEnv = await getConfig({
      home,
      cwd: emptyHome(),
      env: { LANGFUSE_CODEX_TRACE_SEED: "seed-from-env" },
    });
    expect(fromEnv.trace_seed).toBe("seed-from-env");
  });

  it("parses fail-on-error from config and environment", async () => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { fail_on_error: "true" },
    });

    const fromFile = await getConfig({ home, cwd: emptyHome(), env: {} });
    expect(fromFile.fail_on_error).toBe(true);

    const fromEnv = await getConfig({
      home,
      cwd: emptyHome(),
      env: { LANGFUSE_CODEX_FAIL_ON_ERROR: "false" },
    });
    expect(fromEnv.fail_on_error).toBe(false);
  });

  it("reads pricing mode and regional processing with env precedence", async () => {
    const home = makeTmpHome({
      rel: ".codex/langfuse.json",
      contents: { pricing_mode: "batch", regional_processing: false },
    });

    const fromFile = await getConfig({ home, cwd: emptyHome(), env: {} });
    expect(fromFile.pricing_mode).toBe("batch");
    expect(fromFile.regional_processing).toBe(false);

    const fromEnv = await getConfig({
      home,
      cwd: emptyHome(),
      env: {
        LANGFUSE_CODEX_PRICING_MODE: "priority",
        LANGFUSE_CODEX_REGIONAL_PROCESSING: "true",
      },
    });
    expect(fromEnv.pricing_mode).toBe("priority");
    expect(fromEnv.regional_processing).toBe(true);
  });
});
