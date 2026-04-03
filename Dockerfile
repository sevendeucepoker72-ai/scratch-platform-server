FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/prod.db"

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/index.ts"]
