FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# El cliente Prisma generado está en gitignore, así que debe construirse en la
# imagen. prisma.config.ts requiere DATABASE_URL al cargar la config; el servicio
# de compose sobreescribe este default en runtime.

ENV DATABASE_URL="postgresql://bia:bia@postgres:5432/bia_dev"
RUN bunx prisma generate

EXPOSE 3000
CMD ["sh", "-c", "bunx prisma migrate deploy && bun prisma/seed.ts && bun src/app.ts"]
