# Thenwise team server in Docker

One team, its Hub and automatic TLS, on a machine with a DNS name pointing at it and ports 80 and 443 open.

```sh
npm ci && npm run build                                  # in this repo: the plugin's dist/
(cd ../thenwise-hub && npm ci && npm run build)          # the Hub
rm -rf docker/hub && cp -R ../thenwise-hub/dist docker/hub
THENWISE_DOMAIN=team.example.com docker compose -f docker/compose.yaml up -d
```

The Hub is at `https://team.example.com/`. Invite the first person (the owner) and the rest:

```sh
docker compose -f docker/compose.yaml exec thenwise node dist/cli.js team invite alice --dir /data
```

Each person joins from their machine with `thenwise team join https://team.example.com <token>`, or opens the invite link in a browser.

Back up and restore:

```sh
docker compose -f docker/compose.yaml exec thenwise node dist/cli.js team backup /data/team-$(date +%F).db --dir /data
docker compose -f docker/compose.yaml cp thenwise:/data/team-2026-10-27.db .
# on the new machine, after `up -d`:
docker compose -f docker/compose.yaml cp team-2026-10-27.db thenwise:/data/restore.db
docker compose -f docker/compose.yaml stop thenwise
docker compose -f docker/compose.yaml run --rm thenwise node dist/cli.js team restore /data/restore.db --dir /data
docker compose -f docker/compose.yaml start thenwise
```

The data lives in the `thenwise-data` volume. A restore refuses a file from a newer Thenwise and refuses while a server runs on the folder.
