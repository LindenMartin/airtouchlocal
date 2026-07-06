# AirTouch Local

A modern, local-only control panel for the legacy Polyaire AirTouch/Zonemaster web controller.

## Run

Node.js 18 or newer is the only requirement.

```powershell
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The supplied controller settings are the defaults:

- Host: `10.0.0.200`
- Username: `admin`
- Password: `admin`

Override any setting for one session:

```powershell
$env:AIRCON_HOST="10.0.0.200"
$env:AIRCON_USER="admin"
$env:AIRCON_PASSWORD="your-password"
$env:PORT="4173"
npm start
```

The server listens on `127.0.0.1`, so the new UI is available only on this computer. To use it from phones or tablets on your LAN, explicitly set `$env:HOST="0.0.0.0"` and protect the host with an appropriate firewall or reverse proxy.

## What it supports

- Live temperature, AC status, controller time, timers, and zone names
- AC power control
- Individual zone control
- Per-group airflow opening from 10–100% in 10% steps, with controller readback verification
- Prominent safety-spill indication, including the automatic opening percentage and an enabled zone switch
- Automatic refresh every 30 seconds
- Serialized UART requests to prevent overlapping controller commands
- Temperature colour that moves from cold blue through comfortable tones to hot red
- A phone-responsive settings and diagnostics dialog
- Persistent controller snapshots with an immutable “Original state” golden backup
- Verified-field restore with an automatic pre-restore snapshot and readback verification
- A developer protocol map preserving known, partial, and unknown packet fields
- Optional built-in web password protection

The implementation speaks directly to the controller's `httpapi.json` UART bridge. It does not depend on the deprecated page.

## Confirmed airflow protocol

The 353-byte status response reports physical-zone balance at bytes 264–279 and
group opening at bytes 310–325. Values are percentages divided by ten, so `06`
means 60%.

Airflow changes use a 13-byte packet beginning `55 01 0C`. Each group occupies
one nibble in bytes 4–11: action `1` raises the opening by 10%, `2` lowers it by
10%, `8` turns it on, and `4` turns it off. The final byte is an additive
checksum modulo 256.

Unknown response fields are intentionally exposed but never written. Extend
`STATUS_FIELDS` in `protocol.js` as controlled before/after comparisons identify
them.

The raw 353-byte status response is preserved in backups for comparison, but is
not itself replayed as a command. Backups separately contain the verified
13-byte name command for every reported group.

## Configuration and containers

Controller and web settings are environment variables:

- `AIRCON_HOST`, `AIRCON_USER`, `AIRCON_PASSWORD`
- `HOST`, `PORT`, `BACKUP_DIR`
- `APP_USERNAME`, `APP_PASSWORD` for optional built-in web authentication

See [DEPLOYMENT.md](DEPLOYMENT.md) for Docker Compose, phone access, and a
Cloudflare Tunnel protected by Google sign-in through Cloudflare Access.

No household backup data is committed to the repository. On the first
successful controller read, AirTouch Local captures that installation's
immutable “Original state” backup inside `BACKUP_DIR`. Docker keeps it in the
persistent `/data` volume.

## Confirmed clock fields

Bytes 343–346 contain century, year, zero-based month, and zero-based day.
Bytes 347–348 contain 24-hour hour and minute. The physical-panel capture on
2026-07-06 confirmed `20 26 06 05 15 25` as `06/07/2026 21:37`.

Changing the panel clock changed only bytes 347, 348, and the additive checksum
at byte 353. No distinct clock-write command was visible on the web module's
receive side, so remote clock writes remain deliberately disabled.
