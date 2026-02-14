# Astrobot v2 Host Orchestrator
# Runs the main Node.js process that connects to Telegram and manages agent containers

FROM node:22-slim

# Install Docker CLI (needed to manage agent containers)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY container/ ./container/

RUN npm run build

# Remove devDependencies after build to slim down the image
RUN npm prune --omit=dev

# Create data directory
RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
