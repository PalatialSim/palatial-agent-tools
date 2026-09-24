# Palatial Isaac handoff

When the user wants a Palatial asset in Isaac Sim or the Palatial Isaac plugin, do not download the export ZIP.

1. Create with `engine` including `isaac_sim` (the default).
2. Keep the returned `asset_id`. Poll `palatial_get_asset`; never create a replacement to check progress.
3. Call `palatial_write_isaac_handoff` with that ID. Default file: `~/.palatial/palatial-handoff.json` (Windows `%USERPROFILE%\.palatial\palatial-handoff.json`). Do not write to the process working directory.
4. Tell the user to import that file, the `asset_id`, or `dashboard_url` in the plugin **Import existing asset** control.
5. `import_ready` is true only at `READY`. If it is false, poll and rewrite the handoff. Do not spend an export credit from this client.

The Isaac plugin spends the export credit during its own download-and-import path. A MCP download plus a plugin import bills export twice.
