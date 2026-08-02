# One shared image for every Tally service (api, worker, provider-sim,
# receiver, dashboard, migrate) — compose picks the command. Multi-stage so the
# npm ci layer is cached independently of source edits.
#
# The apps run through tsx (no build step anywhere in this repo), so the
# runtime image carries source + node_modules. tsx is a root devDependency:
# do NOT set NODE_ENV=production before npm ci.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/provider-sim/package.json apps/provider-sim/
COPY apps/receiver/package.json apps/receiver/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN npm ci

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The dashboard is the one app with a build step (Vite → static bundle in
# apps/dashboard/dist). Everything else runs from source via tsx; the dashboard
# server (tsx) then serves this prebuilt dist. devDeps (vite) are present because
# npm ci ran before NODE_ENV was set to production.
RUN npm run build -w apps/dashboard
# Default command is a lie detector: compose must always override it.
CMD ["node", "-e", "console.error('set a command in docker-compose.yml'); process.exit(1)"]
