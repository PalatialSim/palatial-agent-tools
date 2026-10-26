import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTurnSchema, PalatialClient, mcpAgentTurnSchema } from '../src/client.js';
import { assertAgentFileSize, agentVideoMaxBytes, agentFileMaxBytes } from '../src/agent-file-limits.js';

const file = { originalName: 'clip.mp4', sha256: 'a'.repeat(64), sizeBytes: agentVideoMaxBytes };
test('digest manifests enforce the same exact video boundary by name, kind and media type', () => {
  assert.equal(agentTurnSchema.parse({ message:'Use this clip.',files:[file] }).files[0].sizeBytes,314572800);
  for (const descriptor of [file,{...file,originalName:'CLIP.MOV'},{...file,originalName:'opaque.bin',kind:'video'},{...file,originalName:'opaque.bin',mimeType:'video/quicktime'}]) {
    assert.throws(()=>agentTurnSchema.parse({message:'Use it.',files:[{...descriptor,sizeBytes:agentVideoMaxBytes+1}]}),/300 MiB.*Mad Max/);
  }
  assert.equal(agentTurnSchema.parse({message:'Use CAD.',files:[{...file,originalName:'part.step',sizeBytes:agentFileMaxBytes}]}).files[0].sizeBytes,agentFileMaxBytes);
});

test('direct JSON submission refuses oversized video manifests without any HTTP request', () => {
  let called = false;
  const client = new PalatialClient({apiKey:'fixture',fetchImpl:()=>{called=true;throw new Error('Must not connect.');}});
  assert.throws(()=>client.startAgentTurn({message:'Use this clip.',files:[{...file,sizeBytes:agentVideoMaxBytes+1}]}),/300 MiB.*Mad Max/);
  assert.equal(called,false);
});

test('video boundary diagnostics remain explicit while generic files keep their byte budget',()=>{
  assert.doesNotThrow(()=>assertAgentFileSize(file));
  assert.throws(()=>assertAgentFileSize({...file,sizeBytes:agentVideoMaxBytes+1}),error=>error.code==='AGENT_VIDEO_TOO_LARGE' && error.message.includes('314572800 bytes'));
  assert.doesNotThrow(()=>assertAgentFileSize({originalName:'notes.txt',sizeBytes:agentFileMaxBytes}));
  assert.throws(()=>assertAgentFileSize({originalName:'notes.txt',sizeBytes:agentFileMaxBytes+1}),error=>error.code==='EFBIG');
  assert.match(mcpAgentTurnSchema.shape.files.unwrap().description,/300 MiB.*314572800 bytes.*100 MiB/);
});
