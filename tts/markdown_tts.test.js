import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { loadConfig, speechBlocks, chunkText, sseEvents, synthesize, decodeWav, wavHeader, trimPrefill, convert, parseArgs, runTool } from './markdown_tts.js';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { startTts } = require('./spawn_tts.cjs');
const cfg = await loadConfig();
const emit = () => {};
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(ROOT, '.test-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function pcm(seconds, sample = 9000, rate = 24000) {
  const b = Buffer.alloc(seconds * rate * 2); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(sample, i); return b;
}
const reference = { channels: 1, width: 2, rate: 24000, data: Buffer.concat([pcm(0.8), pcm(0.2, 0)]) };
const audio = { ...reference, data: Buffer.concat([reference.data, pcm(1)]) };
const encode = w => Buffer.concat([wavHeader(w, w.data.length), w.data]);
async function* bytewise(text) { for (const b of Buffer.from(text)) yield Buffer.from([b]); }

test('CLI requires output and rejects unknown/duplicate options', () => {
  assert.throws(() => parseArgs(['in.md']), /Aufruf/);
  assert.throws(() => parseArgs(['in.md', '--output', 'x.mp3', '--output', 'y.mp3']), /doppelt/);
  assert.throws(() => parseArgs(['--wrong']), /Unbekannt/);
  assert.equal(parseArgs(['in file.md', '--output', 'out file.mp3']).output, 'out file.mp3');
});
test('semantic Markdown: metadata, nesting, tables, code, footnotes', () => {
  const md = '---\ntitle: hidden\n---\n# Titel\n\nQuelle: weg\nDatum: 2026-01-01\nEin **Text** mit [Link](https://x.de) und `Code`.\n\n3. Drei\n4. Vier\n   - Unterpunkt\n\n> Zitat\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nGeheim\n```\n\nEnde[^1].\n\n[^1]: Fußnote';
  assert.equal(speechBlocks(md, cfg).map(b => b[1]).join('\n\n'), 'Titel.\n\nEin Text mit Link und Code.\n\nDrittens, Drei\nViertens, Vier\nUnterpunkt\n\nZitat\n\nEnde.');
});
test('Unicode chunking preserves words and total request budget', () => {
  const text = 'Hallo 😀 Welt. '.repeat(1000);
  const chunks = chunkText([['paragraph', text.trim()]], cfg);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(chunks.every(s => Array.from(s + cfg.prefill.text + cfg.prefill.separator).length <= 3800));
  assert.throws(() => chunkText([['paragraph', 'x'.repeat(4000)]], cfg), /Wortgrenze/);
});
test('SSE handles UTF-8 splits, CRLF, comments, EOF and non-JSON DONE', async () => {
  const source = ': keepalive\r\ndata: {"type":"test","text":"Grüße 😀"}\r\n\r\ndata: [DONE]';
  const events = []; for await (const e of sseEvents(bytewise(source))) events.push(e);
  assert.deepEqual(events, [{ type: 'test', text: 'Grüße 😀' }]);
  await assert.rejects(async () => { for await (const e of sseEvents(bytewise('data: []\n\n'))) void e; }, /Ungültig/);
});
test('real synthesis parser requires audio.done; [DONE] alone never passes', async () => temporary(async dir => {
  const old = process.env[cfg.tts.api_key_environment_variable]; process.env[cfg.tts.api_key_environment_variable] = 'offline-test';
  try {
    const delta = 'data: '+JSON.stringify({ type: 'speech.audio.delta', audio: Buffer.from('audio').toString('base64') })+'\n\n';
    const mock = suffix => async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/speech');
      assert.equal(JSON.parse(options.body).response_format, 'mp3');
      return new Response(delta + suffix, { headers: { 'content-type': 'text/event-stream' } });
    };
    const out = path.join(dir, 'ok.mp3');
    await synthesize('Test', out, cfg, undefined, emit, mock('data: {"type":"speech.audio.done"}\n\ndata: [DONE]'));
    assert.equal(await fs.readFile(out, 'utf8'), 'audio');
    await assert.rejects(synthesize('Test', path.join(dir, 'bad.mp3'), cfg, undefined, emit, mock('data: [DONE]')), /unvollständig/);
  } finally { if (old === undefined) delete process.env[cfg.tts.api_key_environment_variable]; else process.env[cfg.tts.api_key_environment_variable] = old; }
}));
test('WAV: placeholder header, exact safe cut, truncated data and missing silence', () => {
  const bytes = encode(audio); bytes.writeUInt32LE(0xffffffff, 4); bytes.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(decodeWav(bytes).data, audio.data);
  const trimmed = trimPrefill(audio, 1, cfg);
  // Golden result checked against Python: floor((1 - .8) * 24000) is 4799,
  // so the analysis windows start one frame before an exact .2 seconds.
  assert.equal(trimmed.cutSeconds, 19199 / 24000); assert.deepEqual(trimmed.data, audio.data.subarray(38398));
  assert.throws(() => trimPrefill({ ...audio, data: pcm(2) }, 1, cfg), /Ruhephase/);
  assert.throws(() => decodeWav(encode(audio).subarray(0, 60)), /abgeschnitten/);
});
test('short route through 3800 characters; distinct output path, no calibration', async () => temporary(async dir => {
  for (const n of [10, 3800]) {
    const input = path.join(dir, `in-${n}.md`), output = path.join(dir, 'out with spaces', `${n}.mp3`);
    await fs.writeFile(input, 'x'.repeat(n)); let calls = 0;
    const synth = async (text, file) => { assert.equal(text, 'x'.repeat(n)); calls++; await fs.writeFile(file, 'ID3-test'); };
    const result = await convert(input, output, cfg, { synth });
    assert.equal(calls, 1); assert.equal(result.outputPath, output); assert.equal(result.chunks, 1);
    await assert.rejects(convert(input, output, cfg, { synth }), { code: 'OUTPUT_EXISTS' });
    assert.equal(calls, 1);
  }
}));
test('long route uses all prefills, real FFmpeg/probe, cache and invalidation', async () => temporary(async dir => {
  const c = structuredClone(cfg); c.runtime.cache_directory = path.join(dir, 'cache');
  const input = path.join(dir, 'in.md'); await fs.writeFile(input, 'Ein Satz. '.repeat(500));
  const calls = [], events = [];
  const synth = async (text, file) => { calls.push(text); await fs.writeFile(file, encode(text === c.prefill.text ? reference : audio)); };
  const out = path.join(dir, 'out.mp3');
  const result = await convert(input, out, c, { synth, emit: type => events.push(type) });
  assert.equal(result.chunks, 2); assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(s => s.startsWith(c.prefill.text + c.prefill.separator)));
  assert.ok((await fs.stat(out)).size > 100); assert.ok(events.includes('encoding'));
  calls.length = 0; await convert(input, path.join(dir, 'cached.mp3'), c, { synth }); assert.equal(calls.length, 2);
  c.tts.voice = 'nova'; calls.length = 0;
  await convert(input, path.join(dir, 'changed.mp3'), c, { synth }); assert.equal(calls.length, 3);
}));
test('empty input and occupied target rejected before synthesis', async () => temporary(async dir => {
  const input = path.join(dir, 'in.md'), out = path.join(dir, 'out.mp3');
  const synth = () => { throw Error('must not call'); };
  await fs.writeFile(input, '```\ncode\n```');
  await assert.rejects(convert(input, out, cfg, { synth }), { code: 'TEXT_ERROR' });
  await fs.writeFile(input, 'Hallo'); await fs.writeFile(out + '.tts-lock', 'test');
  await assert.rejects(convert(input, out, cfg, { synth }), { code: 'OUTPUT_BUSY' });
}));
test('concurrent same-target job and cancellation leave no partial MP3', async () => temporary(async dir => {
  const input = path.join(dir, 'in.md'), out = path.join(dir, 'out.mp3'); await fs.writeFile(input, 'Hallo');
  const controller = new AbortController(); let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const synth = async (_text, file, _cfg, signal) => {
    await fs.writeFile(file, 'partial'); ready();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const running = convert(input, out, cfg, { synth, signal: controller.signal });
  const rejected = assert.rejects(running, /cancel/);
  await started;
  await assert.rejects(convert(input, out, cfg, { synth }), { code: 'OUTPUT_BUSY' });
  controller.abort(new Error('cancel')); await rejected;
  assert.deepEqual(await fs.readdir(dir), ['in.md']);
}));
test('runTool timeout terminates child and missing executable reports error', async () => {
  await assert.rejects(runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, 0.1), { code: 'TIMEOUT' });
  await assert.rejects(runTool('nonexistent-tts-tool-1234', [], undefined, 1), { code: 'AUDIO_ERROR' });
});
test('spawn adapter splits lines, waits for close and supports IPC cancellation', async () => temporary(async dir => {
  const fixture = path.join(dir, 'worker.cjs');
  await fs.writeFile(fixture, `
    process.stderr.write('{"type":"start","message":"Grü');
    setTimeout(() => { process.stderr.write('ße"}\\n'); process.stdout.write(JSON.stringify({outputPath:process.argv[4],chunks:1})+'\\n'); if(process.connected) process.disconnect(); }, 20);
  `);
  const events = [], out = path.join(dir, 'out.mp3');
  const job = startTts({ scriptPath: fixture, inputPath: 'in.md', outputPath: out, onEvent: e => events.push(e) });
  assert.equal((await job.completion).outputPath, out); assert.equal(events[0].message, 'Grüße');
  await fs.writeFile(fixture, `process.on('message',m=>{if(m.type==='cancel'){process.exitCode=130;process.disconnect();}});`);
  const cancel = startTts({ scriptPath: fixture, inputPath: 'in.md', outputPath: out });
  const rejected = assert.rejects(cancel.completion, { cancelled: true }); cancel.cancel(); await rejected;
}));
test('actual CLI invalid arguments returns structured stderr and no stdout result', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'markdown_tts.js'), '--json-progress'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', s => { out += s; }); child.stderr.on('data', s => { err += s; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2); assert.equal(out, ''); assert.equal(JSON.parse(err).code, 'ARGUMENT_ERROR');
});
