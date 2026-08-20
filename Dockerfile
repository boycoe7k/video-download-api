FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip --version >/dev/null 2>&1 || true

# Install deno (JS runtime required by YouTube extraction) and the yt-dlp
# nightly build, which carries the latest extractor fixes for YouTube,
# TikTok, Instagram, and Facebook.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-pip curl unzip \
  && curl -fsSL https://deno.land/install.sh | sh \
  && cp /root/.deno/bin/deno /usr/local/bin/ \
  && pip3 install --no-cache-dir --break-system-packages \
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.08.19.233000/yt-dlp.tar.gz" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p /app/storage
EXPOSE 3000
CMD ["npm", "start"]
