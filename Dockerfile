FROM node:22-alpine AS builder

# Set the working directory
WORKDIR /app

# Install dependencies
RUN npm install -g pnpm

# Copy package.json
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application code to the working directory
COPY . .

# Build the application
RUN pnpm run build

RUN pnpm prune --production

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json

# Start the bot
CMD ["node", "dist/index.js"]
