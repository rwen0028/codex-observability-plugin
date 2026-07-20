import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PLUGIN_VERSION } from "../src/version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookConfigFile = path.join(repoRoot, "plugins/tracing/hooks/hooks.json");

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readHookCommand(): string {
  const config = JSON.parse(fs.readFileSync(hookConfigFile, "utf-8")) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  return config.hooks.Stop[0].hooks[0].command;
}

function runShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string },
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("hook command timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("bundled Stop hook command", () => {
  it("runs from an arbitrary session cwd via the Codex-provided PLUGIN_ROOT", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");

    const { code, stderr, stdout } = await runShellCommand(readHookCommand(), {
      cwd: sessionCwd,
      env: {
        ...process.env,
        PLUGIN_ROOT: path.join(repoRoot, "plugins/tracing"),
        CODEX_HOME: codexHome,
        HOME: codexHome,
      },
      input: JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: path.join(sessionCwd, "rollout.jsonl"),
      }),
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("does not depend on the old marketplace-root relative path", () => {
    expect(readHookCommand()).not.toContain("plugins/cache/");
  });

  it("keeps an identical trusted command across plugin versions", () => {
    expect(readHookCommand()).toBe('node "${PLUGIN_ROOT}/dist/index.mjs"');
    expect(readHookCommand()).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("keeps package, manifest, and trace metadata versions aligned", () => {
    const packageVersion = (
      JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
        version: string;
      }
    ).version;
    const manifestVersion = (
      JSON.parse(
        fs.readFileSync(path.join(repoRoot, "plugins/tracing/.codex-plugin/plugin.json"), "utf-8"),
      ) as { version: string }
    ).version;
    expect(PLUGIN_VERSION).toBe(packageVersion);
    expect(manifestVersion).toBe(packageVersion);
  });
});
