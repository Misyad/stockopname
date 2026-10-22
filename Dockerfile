FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache postgresql17-client rclone
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile \
  && pnpm store prune

COPY --chown=node:node src ./src
COPY --chown=node:node scripts/backup.js scripts/health-check.js scripts/restore.js ./scripts/
COPY --chown=node:node db/migrations ./db/migrations

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)throw Error(r.status)})"]

CMD ["node", "src/server.js"]
