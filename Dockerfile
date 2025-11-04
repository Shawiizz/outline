ARG APP_PATH=/opt/outline
ARG BASE_IMAGE=outlinewiki/outline-base
FROM ${BASE_IMAGE} AS base

ARG APP_PATH
WORKDIR $APP_PATH

# ---
FROM node:22.21.0-slim AS runner

LABEL org.opencontainers.image.source="https://github.com/outline/outline"

ARG APP_PATH
WORKDIR $APP_PATH
ENV NODE_ENV=production

# Create a non-root user compatible with Debian and BusyBox based images
RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs nodejs && \
    mkdir -p /var/lib/outline && \
    chown -R nodejs:nodejs /var/lib/outline

COPY --from=base --chown=nodejs:nodejs $APP_PATH/build ./build
COPY --from=base $APP_PATH/server ./server
COPY --from=base $APP_PATH/public ./public
COPY --from=base $APP_PATH/.sequelizerc ./.sequelizerc
COPY --from=base $APP_PATH/node_modules ./node_modules
COPY --from=base $APP_PATH/package.json ./package.json

# Install wget to healthcheck the server and Chrome for PDF export
RUN  apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
RUN mkdir -p "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chown -R nodejs:nodejs "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chmod 1777 "$FILE_STORAGE_LOCAL_ROOT_DIR"

VOLUME /var/lib/outline/data

USER nodejs

HEALTHCHECK --interval=1m CMD wget -qO- "http://localhost:${PORT:-3000}/_health" | grep -q "OK" || exit 1

EXPOSE 3000
CMD ["yarn", "start"]
