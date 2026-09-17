# Install Your Own YouTube Office

This private repository provides the same three employee roles, personalities,
office artwork, and shared production rules on a second Windows computer. Each
installation uses its owner's own Codex account, usage, files, chat history,
projects, and publishing credentials.

## Install

1. Install current Git and Node.js on Windows.
2. Sign into the Codex desktop app with your own ChatGPT account.
3. Clone this private repository and open PowerShell in the cloned folder.
4. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-youtube-office.ps1
```

5. Open **YouTube Office 4.0** from the desktop shortcut.

The installer creates private per-user locations by default:

- Creator prompt and project records: `Documents\YouTube Office\content-workspace`
- Chats, office state, activity, and logs: `%LOCALAPPDATA%\YouTube Office\data`
- Local configuration: `%APPDATA%\YouTube Office\config.json`

Edit the private `MASTER_PROMPT.md` in the content workspace to describe your
own channel and creator preferences. The repository's shared role prompts and
baseline remain updateable without overwriting that file.

## Update

Updates are intentionally pull-only for invited users:

```powershell
git pull --ff-only
powershell -ExecutionPolicy Bypass -File .\scripts\install-youtube-office.ps1 -SkipDependencyInstall
```

The installer never replaces an existing local `MASTER_PROMPT.md`, approved
rules file, conversation history, or project state.

## Privacy boundary

Repository access does not provide access to another person's ChatGPT,
YouTube, Twitch, Medal, Windows account, media, cookies, credentials, employee
conversations, or local projects. Do not commit files from either private data
location.
