# Curation bot (long-polling Telegram). Runs the TypeScript entry directly
# via tsx, so it needs the full dependency set (tsx is a devDependency) and
# the vendored fli-js tarball present in the build context before `npm ci`.
FROM node:22-slim

WORKDIR /app

# Dependency layer first for caching. The `file:vendor/...` dependency means
# the tarball must exist when npm ci resolves the lockfile.
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --include=dev

# App sources.
COPY tsconfig.json ./
COPY src/ ./src/

ENV NODE_ENV=production

# Long-polling worker; binds a health port only if PORT is set (see bot.ts).
CMD ["npm", "run", "bot"]
