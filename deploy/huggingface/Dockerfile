# Hugging Face Space for Errand. The Space holds only this file and README.md;
# the code is pulled from GitHub at build time and secrets come from the Space settings.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Changes whenever main moves, so a rebuild always picks up the latest commit.
ADD https://api.github.com/repos/degordonstech/errand/git/refs/heads/main /tmp/main.json

RUN git clone --depth 1 https://github.com/degordonstech/errand.git . \
 && npm ci --include=dev --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=7860 \
    FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 7860
USER node
CMD ["node", "dist/server.js"]
