# YouTube Agent Office

This installation adapts the MIT-licensed Pixel Office project into an
on-demand YouTube production office. The three human workers remain visible
and idle until a task is explicitly sent from the current Codex conversation.

## Start the popup

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-youtube-office.ps1
```

## Bridge commands

```powershell
node .\youtube-office\office-cli.js status
node .\youtube-office\office-cli.js start --project demo-001 --title "Build a CS2 video"
node .\youtube-office\office-cli.js agent researcher --status researching --task "Reviewing clips"
node .\youtube-office\office-cli.js message --from editor --to manager --kind challenge --summary "The hook needs a stronger payoff."
node .\youtube-office\office-cli.js complete --summary "Final package passed inspection."
```

The bridge stores sanitized state and activity under `youtube-office/data/`.
It has no scheduler and never creates work on its own.

