FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json server.js index.html ./

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

USER node

CMD ["node", "server.js"]
