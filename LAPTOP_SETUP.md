# Files and backups on your laptop

```
visitors -> website (Render / Railway / a VPS) -> Neon database (users, orders, file list)
                         |
                         +--(secure tunnel)--> your laptop: file server -> D:\LibData\files   (every uploaded file)
your laptop, every hour:  Neon database dump + a copy of every new file  ->  backups\
```
The website keeps its small database on Neon. Only the uploaded files live on your laptop.
**While the laptop is off or offline, the site still opens, but files cannot be opened and uploads fail** (a clear 503 message).

## 1. Prepare the laptop (PowerShell)
```powershell
# install Node 18+ and Docker Desktop first (Docker is only used to run pg_dump)
Expand-Archive "$HOME\Downloads\Lib-laptop-files.zip" C:\Lib
cd C:\Lib
npm install
copy laptop\laptop.env.example laptop\laptop.env
notepad laptop\laptop.env        # set LAPTOP_DATA (big drive) and BACKUP_DIR (another disk if you can)
```
Keep the laptop awake and plugged in:
```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
# also: Settings > System > Power > "When I close the lid" = Do nothing; turn on automatic sign-in so the tasks start after a restart
```

## 2. Start the file server and the hourly backups
```powershell
npm run laptop:schedule      # installs 3 Task Scheduler tasks and starts the file server now
curl.exe http://127.0.0.1:8787/health      # -> {"ok":true}
```
Tasks: `LibFileServer` (at sign-in, restarts itself if it crashes), `LibBackup-Hourly`, `LibBackup-Logon`. Remove: `node laptop\schedule.js --remove`.

## 3. Make the file server reachable by the website (pick one)
The server only listens on 127.0.0.1; a tunnel gives it a safe public https address. Every request still needs the token.

**A. Cloudflare Tunnel** (needs a domain added to a free Cloudflare account, e.g. files.yourdomain.com)
```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create libfiles
cloudflared tunnel route dns libfiles files.yourdomain.com
# create C:\Users\<you>\.cloudflared\config.yml :
#   tunnel: libfiles
#   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
#   ingress:
#     - hostname: files.yourdomain.com
#       service: http://127.0.0.1:8787
#     - service: http_status:404
cloudflared service install
```
**B. Tailscale Funnel** (no domain needed; stable address like https://mypc.tailxxxx.ts.net)
```powershell
winget install Tailscale.Tailscale     # sign in, enable HTTPS + Funnel for your tailnet in the admin console
tailscale funnel --bg 8787
```
Test from another network (e.g. phone data): `https://<your-address>/health` must show `{"ok":true}`.

## 4. Tell the website (Render / Railway / VPS: Environment variables)
```
FILE_STORE_URL   = https://files.yourdomain.com        (your tunnel address, no trailing slash)
FILE_STORE_TOKEN = <the same value as in laptop\laptop.env>
DATABASE_URL1    = <your Neon connection string, unchanged>
```
Deploy this project's code. From then on every NEW upload goes to the laptop. Old files keep working from Neon.

> GoDaddy: only a GoDaddy **VPS** (or any Linux server) can run this Node site. Normal GoDaddy shared hosting cannot.

## 5. Move the files that are already in Neon to the laptop
Only after step 4 is live and tested (upload a test file, open it):
```powershell
npm run laptop:migrate-files -- --dry     # counts only
npm run laptop:migrate-files              # moves them; safe to run again
```
Old copies stay in Neon until you delete them yourself (only after a good backup and a few days of checking).

## 6. Backups
`npm run laptop:backup` runs one now (the scheduler does it every hour). Each run:
- dumps the Neon database(s) to `backups\<date_time>\db1.dump` and checks the dump is readable (`manifest.json` has the row counts),
- copies every new uploaded file to `backups\files\` (deleted files are kept there on purpose),
- keeps all backups of the last 2 days, then one per day for 30 days.

Log: `backups\backup.log`. If a file is missing on the file server but exists in the backup copy, it is restored automatically when opened.

## 7. Restore
```powershell
# database: load the latest dump into a NEW empty Neon (or any Postgres) database, then point DATABASE_URL1 at it
npm run laptop:restore -- db latest --to "postgresql://user:pass@host/db?sslmode=require" --yes
# files: copy anything missing from the backup copy back into the files folder
npm run laptop:restore -- files --yes
```
New laptop: install Node/Docker, unzip, copy `laptop\laptop.env` back (a copy is in every backup's `config` folder), copy the files folder, `npm run laptop:schedule`.

## Honest limits
- Files and their backup on the **same drive** are lost together if that drive dies. Use a second disk for BACKUP_DIR, and now and then keep a Neon dump somewhere else too.
- The website's own "full backup" screen does not contain laptop files; the laptop backup does.
- Visitors download files through the website host, so the host's bandwidth allowance applies.
- Neon's free database is small; 1 million file records needs a paid Neon plan.
- Largest accepted file: 200 MB (`FILE_MAX_MB`). The Neon password was shared in chat: rotate it in Neon and update both places.
