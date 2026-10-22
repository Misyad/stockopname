FROM node:22-alpine
RUN apk add --no-cache postgresql17-client rclone \
  && install -d -o node -g node -m 700 /var/backups/stock-opname
ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile \
  && pnpm store prune

COPY --chown=node:node src ./src
COPY --chown=node:node db/migrations ./db/migrations
COPY --chown=node:node scripts/health-check.js scripts/backup.js scripts/restore.js scripts/retention.js ./scripts/

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)throw Error(r.status)})"]

CMD ["node", "src/server.js"]
