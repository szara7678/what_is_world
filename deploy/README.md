# Deploy notes

These files are reference templates. Adjust paths and the user account before installing.

## systemd

Copy `wiw.service` to `/etc/systemd/system/wiw.service`, then:

```
# create log dir
sudo mkdir -p /var/log/wiw
sudo chown insu:insu /var/log/wiw

# create env file (referenced by EnvironmentFile=)
cd /home/insu/insu_server/apps/what_is_world
cp .env.example .env
# edit .env and set WIW_ADMIN_TOKEN to a real value

# enable
sudo systemctl daemon-reload
sudo systemctl enable --now wiw.service
sudo systemctl status wiw.service
```

The unit assumes:
- Ollama runs as another service (`ollama.service`) and is reachable at `localhost:11434`.
- `bge-m3` is already pulled (`ollama pull bge-m3`).
- The client has been built (`apps/client/dist` exists).
- The server has been built (`apps/server/dist/main.js` exists).

## Cloudflare Tunnel

Point an existing tunnel to `http://localhost:3011`. The Vite base path `/wiw/` already handles a hostname-served bundle, so `https://your-domain/wiw` works out of the box.

```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: your-domain.example
    path: /wiw/.*
    service: http://localhost:3011
  - hostname: your-domain.example
    path: /wiw
    service: http://localhost:3011
  # ... other routes
  - service: http_status:404
```

## Updating

```
cd /home/insu/insu_server/apps/what_is_world
git pull
npm install
npm run -w @wiw/shared build
npm run -w @wiw/world-core build
npm run -w @wiw/client build
npm run -w @wiw/server build
sudo systemctl restart wiw.service
```

## Backups

`apps/server/data/` is the save. Snapshot it before any risky migration.

```
tar -czf wiw-data-$(date +%F).tgz apps/server/data
```
