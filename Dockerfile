FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# The generated Prisma client is gitignored, so it must be built in the image.
# prisma.config.ts requires DATABASE_URL at config load time; the compose
# service environment overrides this default at runtime.
ENV DATABASE_URL="postgresql://bia:bia@postgres:5432/bia_dev"
RUN bunx prisma generate

EXPOSE 3000
CMD ["sh", "-c", "bunx prisma migrate deploy && bun prisma/seed.ts && bun src/app.ts"]