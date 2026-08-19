FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip --version >/dev/null 2>&1 || true

# Install yt-dlp from the official Python package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-pip \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p /app/storage
EXPOSE 3000
CMD ["npm", "start"]
