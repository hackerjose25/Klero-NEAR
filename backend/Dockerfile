FROM node:22-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@9.15.0

COPY . .

RUN pnpm install --frozen-lockfile

CMD ["pnpm", "dev:providers:near"]
