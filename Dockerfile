# Zero-runtime-dependency Node.js service. The slim image keeps the attack
# surface small; only application source and the test/verify tooling ship.
FROM node:22-alpine

WORKDIR /app

# No npm install step is required (there are no runtime dependencies), but
# package.json is copied so `npm run` scripts work inside the image.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# The compose `verify` service waits for this healthcheck to pass before
# running smoke tests against the API.
HEALTHCHECK --interval=3s --timeout=2s --start-period=2s --retries=15 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
