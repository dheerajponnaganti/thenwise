# The team server with the Hub, for one team. Build from the repo root after `npm run build`, with the Hub's build in
# docker/hub (see docker/README.md): docker compose -f docker/compose.yaml up -d
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY dist ./dist
COPY docker/hub /console
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8788
# TLS ends at the proxy in front (Caddy in compose.yaml), so cookies are marked Secure.
CMD ["node", "dist/cli.js", "team", "serve", "--host", "0.0.0.0", "--port", "8788", "--dir", "/data", "--console", "/console", "--tls-behind-proxy"]
