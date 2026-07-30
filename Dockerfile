FROM node:22-slim

RUN npm install -g pnpm@11.17.0

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

# VITE_API_BASE comes from apps/web/.env.production (=/trpc): the API serves the built
# web app on its own origin, so the browser talks to a relative path and no cross-site
# cookie configuration is needed.
RUN pnpm --filter @phoneup/web build

EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @phoneup/db migrate && pnpm --filter @phoneup/api start"]
