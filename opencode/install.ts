import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.HOME ?? homedir()
const config = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode")
  : join(home, ".config", "opencode")

if (!existsSync(join(here, "node_modules/@opencode/plugin"))) {
  const result = spawnSync(process.execPath, ["install", "--frozen-lockfile"], {
    cwd: here,
    stdio: "inherit",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const shim = join(config, "plugins/maki-peer.ts")
mkdirSync(dirname(shim), { recursive: true })
if (lstatSync(shim, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(shim)
writeFileSync(shim, `export { default } from ${JSON.stringify(join(here, "src/index.ts"))}\n`)

const tuiDir = join(config, "tui-plugins/maki-peer")
mkdirSync(tuiDir, { recursive: true })
const link = join(tuiDir, "tui.ts")
if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
symlinkSync(join(here, "src/tui.ts"), link)

const cli = join(config, "cli.json")
let data: Record<string, unknown> = {}
try {
  data = JSON.parse(readFileSync(cli, "utf8"))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}
if (typeof data !== "object" || data === null || Array.isArray(data)) {
  throw new Error(`${cli} must hold a JSON object`)
}
const plugins = Array.isArray(data.plugins) ? [...data.plugins] : []
if (!plugins.includes(tuiDir)) plugins.push(tuiDir)
const next = `${JSON.stringify({ ...data, plugins }, null, 2)}\n`
if (!existsSync(cli) || readFileSync(cli, "utf8") !== next) writeFileSync(cli, next)

console.log(`server shim: ${shim}`)
console.log(`tui plugin:  ${link}`)
console.log(`cli config:  ${cli}`)
console.log("Restart the OpenCode TUI to load /peer.")
