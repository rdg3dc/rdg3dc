# Use Node with Chromium support for Puppeteer
FROM node:20-slim

# Install dependencies for Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app code
COPY . .

# Create data directory for session storage
RUN mkdir -p /app/.wwebjs_auth && chmod 777 /app/.wwebjs_auth

EXPOSE 3001

CMD ["node", "index.js"]
