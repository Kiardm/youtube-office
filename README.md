# YouTube Office 4.0

YouTube Office is a portable Windows production workspace that represents a Researcher, Editor, and Manager as human pixel-office employees. Each installation uses its owner's local Codex or Claude Code authentication, stores personalities and learning locally, and never starts production until the user explicitly does so.

Highlights:

- A furnished animated office with permanent idle employees and independent or Whole Team chat.
- Provider-neutral Codex and Claude Code adapters with per-worker selection.
- A private SQLite Memory Center with provenance, confidence, corrections, approval, export, and forgetting.
- Scoped local capability grants for files, applications, browser, network, rendering, publishing, and destructive actions.
- Manual solo-mode End Workday reflection; co-op tasks return directly to idle.
- Encrypted, signed, replay-resistant six-worker co-op rooms. Private chats, memories, credentials, and unrelated files never synchronize.
- Windows-user-encrypted backups, update checkpoints, and Git-visible shared prompts without personal state.

## Install

Requirements: Windows 10/11, Node.js 24+, Git, and either Codex or Claude Code signed in locally.

```powershell
git clone https://github.com/Kiardm/youtube-office.git
cd youtube-office
powershell -ExecutionPolicy Bypass -File .\scripts\install-youtube-office.ps1 -OfficeProvider codex
```

The installer uses each Windows user's own local Codex or Claude authentication. No provider credential, personal memory, or private project data is copied into the repository.

## Privacy and authority

Local private data lives under the current Windows profile. The bridge binds to localhost and rejects non-local browser origins. Co-op messages and explicitly attached artifacts are encrypted end to end; the relay forwards ciphertext only. A remote collaborator cannot grant access to your computer or publish through your accounts.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm check-types
pnpm office:test
pnpm office:audit-distribution
pnpm build
```

## Pixel Office foundation

> A pixel art virtual office where your AI agents come to life.

Real-time visual dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents. Watch your coding assistants work, wander, and wait — as animated characters in a customizable office.

![Pixel Office Demo](docs/screenshots/demo.gif)

## Origin & Credits

**Pixel Office is built upon [Pixel Agents](https://github.com/pablodelucca/pixel-agents), created by [Pablo De Lucca](https://github.com/pablodelucca).**

Pablo's original VS Code extension — which visualizes AI coding agents as pixel art characters in a virtual office — is where this project began. The pixel art rendering engine, character animation system, and the entire "office where your agents work" concept all come from Pablo's work, released under the [MIT License](https://github.com/pablodelucca/pixel-agents/blob/main/LICENSE).

Pixel Office has since grown in a different direction (standalone server, multi-machine monitoring, community gallery, office pets, and more), but none of it would exist without that original foundation. We are deeply grateful for Pablo's creativity and generosity in open-sourcing Pixel Agents.

## Why Pixel Office?

When you're running multiple Claude Code sessions across projects (or machines), it's hard to know what's happening. Pixel Office gives you a single glanceable view:

- **Who's working** — characters sit at desks typing when their agent is active
- **Who's waiting** — speech bubbles appear when an agent needs your approval
- **Who's idle** — characters wander the office between tasks
- **What they're doing** — hover to see the current tool (Read, Edit, Bash, etc.)

Perfect for a wall-mounted monitor, a second screen, or just a corner of your desktop.

## Quick Start

**Requirements:** Node.js 18+

```bash
git clone https://github.com/fedevgonzalez/pixel-office.git
cd pixel-office
pnpm install && cd webview-ui && pnpm install && cd ..
pnpm build
node standalone-server.js
```

Open [http://localhost:3300](http://localhost:3300) — agents appear automatically as you start Claude Code sessions.

For wall displays, use [http://localhost:3300/?kiosk](http://localhost:3300/?kiosk) (auto-framing camera, no UI controls).

### Environment Variables

All optional. Can be set in a `.env` file in the project root or as system env vars.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | HTTP + WebSocket server port |
| `GITHUB_TOKEN` | _(empty)_ | GitHub personal access token for private gallery repos |
| `NO_SCAN` | `0` | Set to `1` to disable auto-scanning `~/.claude/projects/` (useful when only receiving remote reporters) |
| `GITHUB_APP_CLIENT_ID` | _(empty)_ | GitHub App client ID for gallery voting (optional) |
| `GITHUB_APP_CLIENT_SECRET` | _(empty)_ | GitHub App client secret for gallery voting (optional) |

### Data Directory

Pixel Office stores layout data in `~/.pixel-office/layout.json`. This is created automatically on first run. To use a different location, the path is defined in `standalone-server.js`.

## Features

| Feature | Description |
|---|---|
| Standalone server | No VS Code required — just Node.js |
| Auto-discovery | Detects active Claude Code sessions across all projects |
| Live activity | Characters animate based on current tool usage |
| Sub-agents | Task tool spawns child characters near their parent |
| Speech bubbles | Permission (amber dots) and waiting (green check) indicators |
| Sound notifications | Audio chime when an agent finishes and needs attention |
| Office pets | Cats and dogs with customizable colors, patterns, and personalities |
| Door system | Agents enter/exit through doors with matrix spawn animation |
| Break room | Idle agents grab coffee and lounge on the couch |
| Layout editor | Design your office with floors, walls, and 50+ furniture items |
| Community gallery | Browse, star, and import layouts shared by other users |
| Kiosk mode | Auto-framing camera, status sidebar — perfect for wall displays |
| Multi-PC | WebSocket reporters aggregate agents from multiple machines |
| SDK agents | Report custom agents (Claude SDK, cron jobs, any process) |
| Cross-tab sync | Layout changes sync across all open tabs/windows |
| HTTP API | `/api/status` for monitoring, `/api/reload` for remote control |

### Office Pets

Add cats and dogs to your office. Each pet has customizable colors (body, eyes, nose), coat patterns (solid, striped, spotted, bicolor, tuxedo), and personality traits that affect behavior.

Pick a **breed** to use a PNG sprite sheet directly (32×32 frames), then optionally **recolor zones** — the server extracts the top-frequency colors from the variant and exposes them as swatches you can remap one at a time. Save the combo as a named **template** to reuse later.

![Pet Editor](docs/screenshots/03-pet-editor.png)

### Layout Editor

Toggle the editor to customize your office:

- **Floor** — 7 tile patterns with HSB color controls
- **Walls** — Auto-tiling with 16 bitmask variants
- **Furniture** — Desks, chairs, monitors, bookshelves, plants, wall art...
- **Rotate** (R) / **Toggle** (T) / **Pick** (eyedropper) / **Drag** to move
- **Undo/Redo** (Ctrl+Z/Y) with 50-level history
- **Export/Import** layouts as JSON

![Layout Editor](docs/screenshots/04-layout-editor.png)

### Community Gallery

Browse community-shared content across five tabs — **Layouts**, **Pets**, **Characters**, **Props**, and **Backgrounds** — and import with one click. Share your own designs via a pre-filled GitHub Issue; the CI bot validates dimensions, auto-generates a thumbnail, and opens a PR.

![Community Gallery](docs/screenshots/07-community-gallery.png)

### Kiosk Mode

Full-screen mode with auto-framing camera that follows agent activity. Perfect for wall-mounted monitors.

![Kiosk Mode](docs/screenshots/06-kiosk-mode.png)

## Multi-PC Setup

Run a central server on your homeserver and report agents from any machine:

```
 ┌──────────┐     WebSocket      ┌──────────────┐     Browser      ┌─────────┐
 │  Dev PC   │ ──────────────▶  │  Homeserver   │ ◀──────────────  │ Display │
 │ reporter  │   ws://...:3300   │ standalone    │   http://...:3300│ (kiosk) │
 └──────────┘                    └──────────────┘                   └─────────┘
```

**On the central server:**
```bash
node standalone-server.js
```

**On each dev machine:**
```bash
node pixel-office-reporter.js ws://<server-ip>:3300/ws/report
```

The reporter watches local `~/.claude/projects/` JSONL files and streams updates to the server.

**Custom agents (SDK, cron, any process):**
```js
const { createPixelReporter } = require('./reporter-sdk');
const reporter = createPixelReporter({
  serverUrl: 'ws://<server-ip>:3300/ws/report',
  agentName: 'my-agent',
});
reporter.connect();
reporter.taskStart('Processing data');
reporter.toolStart('Bash', { command: 'python analyze.py' });
// ... work ...
reporter.toolEnd('Bash');
reporter.taskEnd();
```

See [docs/standalone.md](docs/standalone.md) for full setup, SDK integration, WebSocket protocol, and API docs.

## Office Assets

The office tileset is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg** ($2 on itch.io). Characters are based on **[Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)** by **JIK-A-4**.

The tileset is not included in this repo. The app runs without it — agents still appear and animate — but the layout editor won't have any furniture items. To unlock the full furniture catalog:

1. Purchase the tileset from the link above
2. Run `pnpm import-tileset` and follow the prompts

## Tech Stack

- **Server**: Node.js, WebSocket (`ws`)
- **Frontend**: React 19, TypeScript, Vite, Canvas 2D
- **Rendering**: Pixel-perfect integer scaling, z-sorted isometric-style sprites

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned. Next up: timeline/activity log, aggregate metrics, push notifications.

## License

[MIT](LICENSE)

## Acknowledgments

- [Pablo De Lucca](https://github.com/pablodelucca) — Creator of [Pixel Agents](https://github.com/pablodelucca/pixel-agents), the original VS Code extension that inspired this project. The pixel art foundation, character animations, and office concept all originated from Pablo's work.
- The open source community for the MIT license that makes projects like this possible.
