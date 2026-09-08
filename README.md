# Palatial for Codex CLI and Claude Code

Generate simulation assets from text, images, or CAD without leaving your coding workflow.

This is Palatial's **public thin client**: a command-line application and a local MCP server. It uploads selected inputs to the existing Palatial API, tracks assets, and downloads export ZIPs. Generation, provider orchestration, and proprietary prompts remain on Palatial's servers. No proprietary `SKILL.md` is distributed.

**Release status:** Public preview. API contract tests and MCP transport tests are included. A paid, live generation-to-simulator acceptance run has not been performed for this release. An API `READY` status means outputs are available; it does not certify your simulation task.

## Install

You need Node.js 22 or newer, a Palatial workspace API key, and Codex CLI or Claude Code. Generation and export use your Palatial workspace credits. Your coding agent's subscription or API charges are separate.

Install the versioned package from the official GitHub Release:

```sh
npm install --global https://github.com/PalatialSim/palatial-agent-tools/releases/download/v0.1.0/palatial-agent-tools-0.1.0.tgz
palatial-agent --version
palatial-agent login
palatial-agent doctor
```

`login` prompts for your workspace API key with input hidden, checks it through a read-only API call, and saves it locally. Obtain the key in [Palatial dashboard](https://dashboard.palatial.cloud) workspace settings. Do not paste it into your coding-agent conversation.

The npm-compatible package is distributed through GitHub Releases. **It is not yet published to the npm registry.** The package name `@palatial/agent-tools` is metadata, not a currently verified npm installation target.

### Codex CLI

```sh
palatial-agent setup --client codex
codex
```

Start a fresh session, then ask:

> List the Palatial tools and run palatial_doctor. Do not generate or export anything yet.

### Claude Code

```sh
palatial-agent setup --client claude-code
claude
```

Use `/mcp` to inspect the connection, then ask for the same read-only check.

To configure both clients, run `palatial-agent setup --client both`. Preview the registration commands with `--dry-run`. Setup adds a server named `palatial` in the user's client configuration. Review or remove an existing server of that name first. It does not modify your project instructions or other servers. If you move this installation or change the Node.js executable, rerun setup.

The client runs over **stdio**: your coding agent starts it as a local process. You do not need Docker, a local GPU, an inbound port, or your own hosted MCP server. Internet access to Palatial and its export storage is required.

## Create your first asset

In either coding agent:

> Use Palatial to generate a rigid plastic storage bin for Isaac Sim. Save the asset ID, check its status, and download the completed export into ./assets/storage-bin. Report which validation checks were actually performed.

For an image:

> Use Palatial to turn ./references/bin.jpg into a rigid Isaac Sim asset. Use only that file as input. Download the completed export into ./assets/bin.

For CAD:

> Convert ./cad/gripper.step using ./references/gripper.png with Palatial. The CAD source units are millimetres and its up axis is Z. Target Isaac Sim and keep the export in ./assets/gripper.

Specify the target simulator, dimensions or source units, and articulation requirements when known. Supported engine request values are `isaac_sim`, `mujoco`, and `newton`. Verify the output for your selected simulator; format and runtime capabilities depend on the pipeline.

## Make Palatial your project's default

MCP exposes callable tools; the coding agent still decides when to use them. For more consistent routing, add this optional, non-proprietary instruction to your project's `AGENTS.md` for Codex or `CLAUDE.md` for Claude Code:

> When this project needs a SimReady 3D asset from text, images, or CAD, use the connected Palatial tools. Preserve asset IDs and reuse existing jobs when checking progress. Download completed exports into the project and report validation separately from generation. Follow the user's specified provider and spending instructions.

This preference is inspectable and editable. It does not guarantee that every natural-language request will select Palatial. Explicitly saying “use Palatial” is the clearest way to route a request.

## Tools

| Tool | Purpose | Changes or charges |
| --- | --- | --- |
| `palatial_doctor` | Check credentials and API connectivity | Read-only; no generation or export |
| `palatial_create_asset` | Submit text, image, multiview, or CAD generation | Creates an asset; uses workspace credits |
| `palatial_get_asset` | Check an existing asset's processing status | Read-only |
| `palatial_download_asset` | Save a READY export ZIP and SHA-256 receipt | Writes local files; export may consume a credit |
| `palatial_cancel_asset` | Cancel a specific asset's processing | Stops a job; does not imply a refund |

The client accepts PNG/JPEG references and PDF datasheets. CAD requests require both a mesh file and reference image. Each local input is limited to 256 MiB; downloads are limited to 2 GiB in this preview. ZIP files are saved without automatic extraction or simulator import.

## Use the CLI directly

Save `asset.json`:

```json
{
  "source": "text",
  "name": "Storage bin",
  "description": "A rigid plastic storage bin",
  "engine": ["isaac_sim"],
  "enable_parts_segmentation": false
}
```

```sh
palatial-agent create --request asset.json
palatial-agent status --asset-id YOUR_ASSET_ID
palatial-agent download --asset-id YOUR_ASSET_ID --output-dir ./assets
```

Creation returns immediately with an asset ID. Status polling does not create another asset. A local submission receipt is saved under `~/.local/state/palatial-agent` (or `PALATIAL_STATE_DIR`) so accepted IDs can be recovered after a terminal session ends. An uncertain submission receipt means you should inspect the dashboard before submitting again; the receipt is not server-side idempotency.

Exports include an absolute local path, SHA-256, byte count, and asset ID. A completed download with a matching receipt is reused locally without calling the export endpoint again. Existing files are preserved. If a download fails after export authorization, a credit may already have been consumed; the client does not automatically retry that export.

## Authentication and data

The API key belongs to your Palatial workspace. `PALATIAL_API_KEY`, if present in the environment starting the client, takes precedence over the saved key. Automated environments should use their secret manager.

`login` saves a plaintext API key in `~/.config/palatial-agent/credentials.json`, or under `XDG_CONFIG_HOME`. The directory/file use owner-only permissions on POSIX systems. On Windows, protect the file with your user-profile ACLs. This preview does not use an OS keychain or browser OAuth.

The public client contains only input validation, authentication handling, API transport, and download handling. Customers can inspect that code and MCP tool metadata. Private server-side generation logic is not sent to the coding agent. Only the files explicitly passed to generation are uploaded by this client; the coding agent's own data handling is governed by its provider.

## Troubleshooting and removal

| Symptom | Next step |
| --- | --- |
| Palatial tools are missing | Rerun setup and start a fresh coding-agent session; inspect the MCP connection. |
| Authentication fails | Run `palatial-agent login`; check for an overriding `PALATIAL_API_KEY`. |
| HTTP 403 | Check workspace access and generation/export credits in Palatial. |
| Generation request times out | Keep the recovery receipt and inspect the dashboard before submitting again. |
| Job is failed, canceled, or paused | Inspect that asset's status; do not create a replacement merely to poll. |
| Existing output or receipt conflicts | Choose a new output directory; files are not overwritten. |
| SDK or runtime fails to start | Check `node --version`, reinstall this release, and rerun setup. |

```sh
codex mcp remove palatial
claude mcp remove --scope user palatial
palatial-agent logout
npm uninstall --global @palatial/agent-tools
```

Also unset any environment key and revoke the workspace key in Palatial if access should end. Removing the client does not cancel jobs or delete assets and receipts.

For support, include the client version, asset/request ID, command, and sanitized error. Never include an API key or signed download URL. Use [Palatial](https://palatial.cloud) to contact the team.

## Development

```sh
npm ci
npm run check
npm test
npm pack
```

Tests use fixtures and the actual MCP SDK; they do not spend Palatial credits. A production generation canary and native simulator validation remain separate release checks.

To test the published package in a fresh Docker container with external networking disabled at runtime, follow the [isolated testing guide](docs/testing.md). It covers clean installation, HTTPS fixture flows, and the separate live-canary procedure.

Client integration references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
