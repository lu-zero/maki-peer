import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = join(ROOT, "skills", "peer-lane-coordination");
const NAME = "peer-lane-coordination";
const DESCRIPTION =
  "Coordinate peer agents across Maki, OpenCode, Grok, Vibe and Claude Code through linked git worktrees. Use when the user asks for a roll call of peers, wants a coordination protocol for agents, is about to dispatch or retask a peer, suspects a peer stalled or vanished, finds peers reviewing work that already landed, or wants stale agent worktrees and branches cleaned up after merges.";

const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));

// The plugin hosts ship their skill directory. Maki and OpenCode have no
// package-provided skill discovery, so their copies are install sources.
const harnesses = [
  {
    name: "maki",
    target: "skills/install/maki",
    install: join(config, "maki", "skills"),
    list: "peer_list",
    send: "peer_send",
    broadcast: "peer_broadcast",
  },
  {
    name: "opencode",
    target: "skills/install/opencode",
    install: join(config, "opencode", "skills"),
    list: "peer_list",
    send: "peer_send",
    broadcast: "peer_broadcast",
  },
  {
    name: "grok",
    target: "grok/skills",
    list: "peer__peer_list",
    send: "peer__peer_send",
    broadcast: "peer__peer_broadcast",
  },
  {
    name: "vibe",
    target: "vibe/skills",
    list: "mcp_peer.peer_list",
    send: "mcp_peer.peer_send",
    broadcast: "mcp_peer.peer_broadcast",
  },
  {
    name: "claude",
    target: "claude/skills",
    install: join(homedir(), ".claude", "skills"),
    list: "mcp__plugin_maki-peer_peer__peer_list",
    send: "mcp__plugin_maki-peer_peer__peer_send",
    broadcast: "mcp__plugin_maki-peer_peer__peer_broadcast",
  },
] as const;

const common = readFileSync(join(SKILLS, "common.md"), "utf8");
const header = `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n---\n\n`;
const check = process.argv.includes("--check");
const install = process.argv.includes("--install");
let stale = false;

for (const harness of harnesses) {
  const notes = readFileSync(join(SKILLS, "harnesses", `${harness.name}.md`), "utf8");
  const body = common
    .replaceAll("{{PEER_LIST}}", harness.list)
    .replaceAll("{{PEER_SEND}}", harness.send)
    .replaceAll("{{PEER_BROADCAST}}", harness.broadcast)
    .replaceAll("{{HARNESS_NOTES}}", notes.trimEnd());
  const content = header + body;
  const target = join(ROOT, harness.target, NAME, "SKILL.md");

  if (check) {
    if (readFileSync(target, "utf8") !== content) {
      console.log(`stale: ${harness.target}/${NAME}/SKILL.md`);
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${harness.target}/${NAME}/SKILL.md`);

  if (install && "install" in harness) {
    const dest = join(harness.install, NAME);
    mkdirSync(dest, { recursive: true });
    cpSync(target, join(dest, "SKILL.md"));
    console.log(`installed ${dest}`);
  }
}

if (stale) {
  console.log("run `just skills` to regenerate");
  process.exit(1);
}
