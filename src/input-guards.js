import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

// UNC (\\server\share or //server/share) and device paths (\\?\ , \\.\) are
// rejected as strings so Windows never opens them.
export function assertLocalPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('Path must be a local filesystem path.');
  if (filename.replaceAll('/', '\\').startsWith('\\\\')) throw new Error('Refusing a UNC or device path.');
}

const blockedHosts = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
  'host.docker.internal',
  'gateway.docker.internal'
]);

function bareIp(hostname) {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(host) !== 0;
}

function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || blockedHosts.has(host)) return true;
  return host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain');
}

export function assertPublicHttpsUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Source URL must use HTTPS without credentials or a fragment.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Source URL must use HTTPS without credentials or a fragment.');
  if (bareIp(url.hostname)) throw new Error('Source URL must use a public hostname, not an IP address.');
  if (blockedHostname(url.hostname)) throw new Error('Source URL must not target a loopback, link-local, or metadata host.');
  return value;
}

export function redactUrlSecrets(text) {
  return String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, token => {
    try {
      const url = new URL(token);
      if (!url.username && !url.password && !url.hash) return token;
      url.username = '';
      url.password = '';
      url.hash = '';
      return url.toString();
    } catch {
      return token.replace(/\/\/[^/?#\s]*@/, '//').replace(/#[^\s]*/, '');
    }
  });
}

export async function openRegularFile(filename) {
  const link = await lstat(filename);
  if (link.isSymbolicLink()) throw Object.assign(new Error('Refusing to read a symbolic link.'), { code: 'ELOOP' });
  if (!link.isFile()) throw Object.assign(new Error('Refusing to read a path that is not a regular file.'), { code: 'ENOTFILE' });
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | noFollow); }
  catch (error) {
    if (error.code === 'ELOOP') throw Object.assign(new Error('Refusing to read a symbolic link.'), { code: 'ELOOP' });
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== link.size) throw Object.assign(new Error('A file changed before it could be read.'), { code: 'EBUSY' });
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readExact(handle, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('A file changed before it could be read.');
  return buffer;
}

export async function digestHandle(handle, size) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(size, 1024 * 1024) || 0);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead !== length) throw new Error('A file changed before it could be read.');
    hash.update(length === chunk.length ? chunk : chunk.subarray(0, length));
    offset += length;
  }
  return hash.digest('hex');
}

export async function readCappedRegularFile(filename, maxBytes, messages = {}) {
  let info;
  try { info = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) throw Object.assign(new Error(messages.link || 'Refusing to read a symbolic link.'), { code: 'ELOOP' });
  if (!info.isFile()) throw Object.assign(new Error(messages.link || 'Refusing to read a path that is not a regular file.'), { code: 'ENOTFILE' });
  if (info.size > maxBytes) throw Object.assign(new Error(messages.size || 'Refusing to read a file above the byte limit.'), { code: 'EFBIG' });
  const opened = await openRegularFile(filename);
  try {
    if (!opened.info.isFile() || opened.info.size > maxBytes) throw Object.assign(new Error(messages.size || 'Refusing to read a file above the byte limit.'), { code: 'EFBIG' });
    return await readExact(opened.handle, opened.info.size);
  } finally { await opened.handle.close(); }
}

export async function digestRegularFile(filename, maxBytes) {
  const link = await lstat(filename);
  if (link.isSymbolicLink()) throw Object.assign(new Error('Refusing to read a symbolic link.'), { code: 'ELOOP' });
  if (!link.isFile()) throw Object.assign(new Error('Refusing to read a path that is not a regular file.'), { code: 'ENOTFILE' });
  if (link.size > maxBytes) throw Object.assign(new Error('Refusing to read a file above the byte limit.'), { code: 'EFBIG' });
  const opened = await openRegularFile(filename);
  try {
    if (!opened.info.isFile() || opened.info.size !== link.size || opened.info.size > maxBytes) throw Object.assign(new Error('A file changed before it could be read.'), { code: 'EBUSY' });
    return { size: opened.info.size, sha256: await digestHandle(opened.handle, opened.info.size) };
  } finally { await opened.handle.close(); }
}

// macOS uses directory symlinks for /tmp, /var and /etc. Those are outside the
// caller's control; every other symlink in the output path is rejected.
const systemSymlinks = new Set(['/tmp', '/var', '/etc']);

function isSystemDirectorySymlink(resolvedPath) {
  const normalized = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  return systemSymlinks.has(normalized);
}

async function assertNoUntrustedSymlink(requested) {
  let cursor = path.parse(requested).root;
  const parts = requested.slice(cursor.length).split(/[\\/]/).filter(Boolean);
  let sawDirectory = false;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) {
      if (!isSystemDirectorySymlink(path.resolve(cursor))) throw new Error('Refusing a symlinked output directory.');
      sawDirectory = true;
      continue;
    }
    if (!info.isDirectory()) throw new Error('Output path must be a directory.');
    sawDirectory = true;
  }
  if (parts.length && !sawDirectory) throw new Error('Output path must be a directory.');
}

export async function resolveOutputDirectory(outputDir) {
  assertLocalPath(outputDir);
  const requested = path.resolve(outputDir);
  assertLocalPath(requested);
  await assertNoUntrustedSymlink(requested);
  return requested;
}

export async function assertResolvedDirectory(directory) {
  const requested = path.resolve(directory);
  await assertNoUntrustedSymlink(requested);
  const info = await lstat(requested);
  if (info.isSymbolicLink()) {
    if (!isSystemDirectorySymlink(requested)) throw new Error('Refusing a symlinked output directory.');
    const followed = await stat(requested);
    if (!followed.isDirectory()) throw new Error('Output path must be a directory.');
    return;
  }
  if (!info.isDirectory()) throw new Error('Output path must be a directory.');
}
