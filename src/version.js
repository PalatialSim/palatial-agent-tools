import { readFileSync } from 'node:fs';
// Package metadata is the sole release-version source for CLI and MCP.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
