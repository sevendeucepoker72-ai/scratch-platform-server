FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Generate Prisma client using explicit path
RUN ./node_modules/.bin/prisma generate

RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/prod.db"

EXPOSE ${PORT:-3001}

CMD ["sh", "-c", "./node_modules/.bin/prisma db push --skip-generate && node --import tsx src/index.ts"]
