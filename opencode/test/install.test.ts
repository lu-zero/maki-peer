import { describe, expect, test } from "bun:test"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const installer = join(root, "opencode", "install.ts")

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "maki-peer-install-"))
}

function configDir(home: string): string {
  return join(home, "config", "opencode")
}

function install(home: string): void {
  const result = Bun.spawnSync([process.execPath, installer], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config") },
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
}

describe("OpenCode installer", () => {
  test("writes the shim, the TUI link, and the cli.json entry", () => {
    const home = tempHome()
    try {
      install(home)
      const config = configDir(home)
      expect(readFileSync(join(config, "plugins/maki-peer.ts"), "utf8")).toBe(
        `export { default } from ${JSON.stringify(join(root, "opencode/src/index.ts"))}\n`,
      )
      expect(readlinkSync(join(config, "tui-plugins/maki-peer/tui.ts"))).toBe(
        join(root, "opencode/src/tui.ts"),
      )
      const cli = JSON.parse(readFileSync(join(config, "cli.json"), "utf8"))
      expect(cli.plugins).toEqual([join(config, "tui-plugins/maki-peer")])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("keeps other config and does not duplicate the entry", () => {
    const home = tempHome()
    try {
      const config = configDir(home)
      mkdirSync(config, { recursive: true })
      writeFileSync(
        join(config, "cli.json"),
        JSON.stringify({ theme: "dark", plugins: ["other"] }),
      )
      install(home)
      install(home)
      const cli = JSON.parse(readFileSync(join(config, "cli.json"), "utf8"))
      expect(cli.theme).toBe("dark")
      expect(cli.plugins).toContain("other")
      expect(cli.plugins.filter((entry: string) => entry.includes("maki-peer"))).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("replaces a symlinked shim instead of writing through it", () => {
    const home = tempHome()
    try {
      const config = configDir(home)
      mkdirSync(join(config, "plugins"), { recursive: true })
      const target = join(home, "elsewhere.ts")
      writeFileSync(target, "old\n")
      symlinkSync(target, join(config, "plugins/maki-peer.ts"))
      install(home)
      const shim = join(config, "plugins/maki-peer.ts")
      expect(lstatSync(shim).isSymbolicLink()).toBe(false)
      expect(readFileSync(target, "utf8")).toBe("old\n")
      expect(readFileSync(shim, "utf8")).toContain("src/index.ts")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
