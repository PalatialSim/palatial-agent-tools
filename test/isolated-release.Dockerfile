FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG PALATIAL_PACKAGE_URL=https://github.com/PalatialSim/palatial-agent-tools/releases/download/v0.1.1/palatial-agent-tools-0.1.1.tgz
ARG PALATIAL_PACKAGE_SHA256=b5aba37e8beef840274907eaf5443980665b660e0f990dd7d7c97d9b79f18406
RUN node --input-type=module -e 'import {writeFile} from "node:fs/promises"; import {createHash} from "node:crypto"; const r=await fetch(process.env.PALATIAL_PACKAGE_URL); if(!r.ok) throw Error("Package download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha256").update(b).digest("hex")!==process.env.PALATIAL_PACKAGE_SHA256) throw Error("Package checksum mismatch"); await writeFile("/tmp/palatial-release.tgz",b);' \
    && npm install --ignore-scripts --omit=dev /tmp/palatial-release.tgz \
    && rm /tmp/palatial-release.tgz
COPY test/isolated-release-smoke.mjs /app/isolated-release-smoke.mjs
USER node
CMD ["node", "/app/isolated-release-smoke.mjs"]
