FROM node:22-slim

RUN npm install -g pnpm@11.17.0

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
ARG VITE_API_BASE=/trpc
RUN pnpm --filter @phoneup/web build

EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @phoneup/db migrate && pnpm --filter @phoneup/api start"]
