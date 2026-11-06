FROM node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059

# Railway supplies the pinned GitHub revision as a build argument. Local/CI
# verification supplies its exact published HEAD. No credentials enter a build.
ARG RAILWAY_GIT_COMMIT_SHA
RUN command -v git && mkdir -p /app && chown node:node /app
WORKDIR /app
USER node
RUN printf '%s\n' "$RAILWAY_GIT_COMMIT_SHA" | grep -Eq '^[a-f0-9]{40}$' && \
    git init . && \
    git remote add origin https://github.com/farhan-shafee/institutional-trading-sdet-lab.git && \
    GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 fetch --depth=1 --no-tags origin "$RAILWAY_GIT_COMMIT_SHA" && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "$RAILWAY_GIT_COMMIT_SHA" && \
    npm ci --include=dev && npm run build && \
    test -z "$(git status --porcelain --untracked-files=all)"
ENV NODE_ENV=production
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
CMD ["node", "dist/app/server/index.js"]
