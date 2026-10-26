import path from 'node:path';

export const agentFileMaxBytes = 1024 ** 3;
export const agentVideoMaxBytes = 300 * 1024 ** 2;
export const agentVideoLimitMessage = 'Videos must be at most 300 MiB (314572800 bytes), the current Mad Max processing limit. Use a smaller video.';

export function isAgentVideo(file) {
  return ['.mp4', '.mov'].includes(path.extname(file.originalName || file.name || '').toLowerCase()) ||
    file.kind === 'video' || ['video/mp4', 'video/quicktime'].includes((file.mimeType || '').toLowerCase());
}

/** Match the owning video processing limit before any byte transfer or receipt creation. */
export function assertAgentFileSize(file) {
  if (isAgentVideo(file) && file.sizeBytes > agentVideoMaxBytes)
    throw Object.assign(new Error(agentVideoLimitMessage), { code: 'AGENT_VIDEO_TOO_LARGE' });
  if (file.sizeBytes > agentFileMaxBytes)
    throw Object.assign(new Error('Refusing to read a file above the byte limit (1 GiB, 1073741824 bytes).'), { code: 'EFBIG' });
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1)
    throw new Error('Agent source must be a nonempty file.');
}
