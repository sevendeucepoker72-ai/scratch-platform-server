FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Create data directory for SQLite
RUN mkdir -p /data

# Build TypeScript (skip for now — using tsx in production for simplicity)
# RUN npm run build

ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/prod.db"
ENV PORT=3001

EXPOSE 3001

# Push schema and start
CMD npx prisma db push --skip-generate && npx tsx src/seed-admin.ts; npx tsx src/index.ts
