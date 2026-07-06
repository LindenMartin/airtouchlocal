# Deploying AirTouch Local

## Docker on your home network

Copy `.env.example` to `.env`, set the controller credentials and choose a
long, unique `APP_PASSWORD`.

```powershell
docker compose up -d --build
```

The container listens on port 4173 and stores controller snapshots in the
`airtouch-data` volume. On its first successful controller read it creates an
immutable “Original state” snapshot for that home. It must be able to reach the
controller IP on your LAN.

## Phone access

Open `http://<docker-host-ip>:4173` while connected to the same trusted home
network. Keep `APP_USERNAME` and `APP_PASSWORD` enabled if other devices can
reach that network.

## Cloudflare Tunnel with Google sign-in

Do not publish port 4173 directly to the internet. Create a Cloudflare Tunnel
whose private origin is `http://airtouch-local:4173` (or the Docker host IP),
then protect the hostname with a Cloudflare Access application:

1. Add Google as an identity provider in Cloudflare Zero Trust.
2. Create a self-hosted Access application for the AirTouch hostname.
3. Add an Allow policy containing only the required Google accounts.
4. Keep the built-in AirTouch password enabled as defence in depth.
5. Restrict the origin firewall so only the LAN and the tunnel connector can
   reach port 4173.

Cloudflare Access performs the Google OAuth flow before requests reach this
application. This avoids storing Google client secrets or user sessions in the
small controller service.

## Security boundaries

- Controller credentials stay server-side and are never returned to browsers.
- The unauthenticated `/health` endpoint returns only `{"ok":true}`.
- Raw status packets are never replayed as commands.
- Backup restore writes only independently verified fields and creates a
  pre-restore snapshot automatically.
- Clock writes remain disabled until their protocol command is verified.
