# Test in a fresh isolated environment

## 1. Offline runtime test of the published release

From a checkout of this repository, with Docker running:

```sh
docker build --file test/isolated-release.Dockerfile --tag palatial-agent-isolation:0.1.0 .
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=128m palatial-agent-isolation:0.1.0
```

The build downloads the **published release tarball**, verifies its fixed SHA-256, and installs it into a new Node.js 22 Linux image. It does not copy the application's source, host credentials, client configuration, or `node_modules` into the image.

The running container has no external network, host directory mounts, or real API key. A temporary local certificate enables verified HTTPS fixture endpoints on loopback. This is not a live Palatial service test.

The test exercises the installed CLI and actual stdio MCP protocol:

- Tool discovery and missing-credential handling in a clean user profile.
- Read-only authentication checks against the fixture API.
- Text, image, multiview, and CAD submission with real multipart HTTP transfers.
- Asynchronous status changes and local submission receipts.
- Download redirects to a different origin without forwarding the API key.
- ZIP bytes, SHA-256 receipts, and reuse without a second export call.
- Reconnecting to an existing asset after the MCP process restarts.
- Ambiguous create failure without an automatic retry, and cancellation.

Success ends with JSON containing `"overall": "passed"`, `"real_palatial_api_calls": 0`, and `"paid_generations": 0`. The container is removed automatically. The image remains available for another run.

## 2. Real terminal compatibility

Use a fresh VM, container, or OS user profile with Node.js 22+, and install Codex CLI and/or Claude Code through the client's official instructions. Install the release, then run:

```sh
palatial-agent setup --client both --dry-run
palatial-agent setup --client both
```

Start a fresh session in each installed client. Ask it to list the five Palatial tools. With no key, `palatial_doctor` must report missing credentials and make no generation request. This verifies discovery without a paid Palatial job; running the coding agent itself may use your agent subscription/API allowance.

The release smoke separately verified real Claude Code registration/connection and Codex configuration parsing. It did not run a model-driven generation conversation in either terminal.

## 3. Live Palatial canary

Use a dedicated test workspace and its API key. Confirm that generation and export spend is authorized before this stage. Prefer a Palatial-provided staging environment when available; this repository does not invent a staging URL or provide free test credits.

1. Install the exact release in the fresh environment.
2. Run `palatial-agent login` and `palatial-agent doctor`.
3. Request one simple text asset for a named simulator. Save its request receipt and asset ID.
4. Poll that ID until READY or a terminal failure. Stop on failure; inspect it before retrying.
5. Download once, retain the ZIP and SHA-256 receipt, and inspect the archive contents.
6. Open it in the requested simulator and perform the intended checks: load, materials, scale, collisions, and any required joints or interaction.
7. Report generation, artifact integrity, visual review, and native simulator acceptance separately. Revoke the temporary key afterward.

Repeat with a reference image and CAD only after the first canary passes. The fixture test cannot establish production API compatibility, asset quality, native simulator behavior, or real-world transfer.
