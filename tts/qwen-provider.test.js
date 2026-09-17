import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { synthesizeQwen } from './qwen-provider.js';
import { loadConfig, convert, runTool } from './markdown_tts.js';
import { requestQwen } from './qwen-http.js';
import settings from './provider-config.cjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig();
config.tts.provider = 'qwen';
config.qwen = { base_url: 'http://qwen.invalid:8765', token_environment_variable: 'QWEN_OFFLINE_TEST_TOKEN' };
process.env.QWEN_OFFLINE_TEST_TOKEN = 'only-for-offline-tests';

async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(root, '.test-qwen-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function server({ audio = 'MP3', status = 'succeeded', health = 'webarchiv-qwen-v4', startError, audioLength, contentType = 'audio/mpeg', onStatus, seed = 123 } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    assert.ok(url.startsWith('http://qwen.invalid:8765/v1/'));
    assert.equal(options.redirect, 'error');
    calls.push([url, options.method || 'GET']);
    const id = url.split('/')[5];
    if (url.endsWith('/health')) return Response.json({ protocol: health, full_markdown: true, audio_format: 'mp3', max_markdown_bytes: 1_000_000 });
    if (options.method === 'PUT') {
      assert.deepEqual(Object.keys(JSON.parse(options.body)), ['markdown']);
      if (startError) throw new Error('Startantwort verloren');
      return Response.json({ id });
    }
    if (options.method === 'DELETE') {
      assert.equal(options.signal.aborted, false);
      return Response.json({ id, status: 'cancelled' });
    }
    if (url.endsWith('/audio')) return new Response(audio, { headers: {
      'content-type': contentType, 'content-length': String(audioLength ?? Buffer.byteLength(audio)) } });
    onStatus?.();
    return Response.json({ id, status: Array.isArray(status) ? status.shift() || 'succeeded' : status,
      seed: typeof seed === 'function' ? seed() : seed });
  };
  return { calls, fetch };
}

test('Qwen-Vertrag: eine Synthese, MP3-Download, Aufräumen; kein OpenAI', () => temporary(async dir => {
  const mock = server();
  const out = path.join(dir, 'out.mp3');
  await synthesizeQwen('Hallo', out, config, undefined, undefined, mock.fetch);
  assert.equal(await fs.readFile(out, 'utf8'), 'MP3');
  assert.deepEqual(mock.calls.map(x => x[1]), ['GET', 'PUT', 'GET', 'GET', 'DELETE']);
}));

test('Vollständiges Markdown in einem Request; identisches Polling bleibt still', () => temporary(async dir => {
  const markdown = '\ufeff# Titel\r\nDatum: 2026-09-17\r\n\r\n**Text** [Link](https://example.org)\r\n'.repeat(120);
  const mock = server({ status: ['running', 'running', 'succeeded'] });
  const bodies = [], events = [];
  const fetch = (url, options) => {
    if (options.method === 'PUT') bodies.push(JSON.parse(options.body));
    return mock.fetch(url, options);
  };
  await synthesizeQwen(markdown, path.join(dir, 'out.mp3'), config, undefined, (...event) => events.push(event), fetch);
  assert.deepEqual(bodies, [{ markdown }]);
  assert.deepEqual(events, []);
}));

test('Qwen: inkompatibler Dienst startet nichts; Fehler/Verlust werden nicht wiederholt', () => temporary(async dir => {
  for (const options of [{ health: 'webarchiv-qwen-v3' }, { status: 'failed' }, { startError: true }, { audioLength: 20 }, { contentType: 'audio/wav' }]) {
    const mock = server(options);
    await assert.rejects(synthesizeQwen('Test', path.join(dir, String(mock.calls.length) + Math.random()), config, undefined, undefined, mock.fetch));
    assert.ok(mock.calls.filter(x => x[1] === 'PUT').length <= 1);
    if (options.health) assert.equal(mock.calls.length, 1);
    else assert.equal(mock.calls.at(-1)[1], 'DELETE');
  }
}));

test('Qwen-Abbruch verwendet unabhängiges Signal für Remote-DELETE', () => temporary(async dir => {
  const controller = new AbortController();
  const mock = server({ status: 'running', onStatus: () => controller.abort(new Error('Abbruch')) });
  await assert.rejects(synthesizeQwen('Test', path.join(dir, 'cancel.mp3'), config, controller.signal, undefined, mock.fetch));
  assert.equal(mock.calls.at(-1)[1], 'DELETE');
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('Qwen-Konfiguration lehnt fehlende Daten, Credentials und unbekannte Provider ab', () => {
  assert.throws(() => settings.providerSettings({ tts: { provider: 'other' } }));
  assert.throws(() => settings.providerSettings({ ...config, qwen: {} }, {}));
  assert.throws(() => settings.providerSettings({ ...config, qwen: { ...config.qwen, base_url: 'http://user:secret@host' } }));
});

test('Qwen kurz/lang: Original-Markdown einmal übertragen, fertige MP3 bytegleich veröffentlichen', () => temporary(async dir => {
  const fixture = path.join(dir, 'fixture.mp3');
  await runTool(config.audio.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.4', '-c:a', 'libmp3lame', '-b:a', '128k', fixture], undefined, 10);
  const audio = await fs.readFile(fixture);
  for (const markdown of ['# Hallo.', '\ufeff# Titel\r\nDatum: 2026-09-17\r\n**Hallo** [Link](https://example.org).\r\n'.repeat(150)]) {
    const input = path.join(dir, 'in.md'), output = path.join(dir, `out-${markdown.length}.mp3`);
    await fs.writeFile(input, markdown);
    const calls = [], events = [];
    const synth = async (text, file) => {
      calls.push(text);
      await assert.rejects(fs.stat(output), { code: 'ENOENT' });
      await fs.writeFile(file, audio);
    };
    const result = await convert(input, output, config, { synth, emit: type => events.push(type) });
    assert.deepEqual(calls, [markdown]);
    assert.equal(result.chunks, 1); // Ein Remote-Auftrag, keine lokale Aufteilung.
    assert.deepEqual(await fs.readFile(output), audio);
    assert.ok(!events.includes('calibration') && !events.includes('trim'));
    await assert.rejects(convert(input, output, config, { synth }), { code: 'OUTPUT_EXISTS' });
    assert.equal(calls.length, 1);
  }
  const bad = path.join(dir, 'bad.mp3');
  await assert.rejects(convert(path.join(dir, 'in.md'), bad, config, {
    synth: async (_text, file) => fs.writeFile(file, 'kein Audio') }));
  await assert.rejects(fs.stat(bad), { code: 'ENOENT' });
}));

test('Bestätigung: Ablehnen startet nichts; Zustimmung übermittelt Provider', async () => {
  const source = await fs.readFile(path.join(root, '../public/app.js'), 'utf8');
  const start = source.indexOf('async function runTts() {');
  const end = source.indexOf('\n}', start) + 2;
  for (const provider of ['qwen', 'openai']) for (const accepted of [false, true]) {
    const calls = [];
    const context = vm.createContext({ selectedTtsArticle: { id: 'a', title: 'Titel' },
      $overlay: { hidden: false }, currentUser: { role: 'admin' }, ttsStarting: false, ttsActive: false,
      updateTtsActions() {}, openTtsModal() {}, $ttsStatus: {}, $ttsActivity: {}, $ttsOverlay: { hidden: true },
      document: { getElementById: () => ({}) }, chooseTtsProvider: async (_article, providers) => {
        assert.equal(providers.length, 2);
        return accepted ? providers.find(p => p.provider === provider) : null;
      }, rememberTtsJob() {},
      apiFetch: async (url, options) => {
        calls.push([url, options]);
        return { ok: true, json: async () => url.endsWith('/provider')
          ? { providers: ['qwen', 'openai'].map(provider => ({ provider, available: true })) } : { jobId: 'job' } };
      } });
    await vm.runInContext(source.slice(start, end) + '\nrunTts()', context);
    assert.equal(calls.length, accepted ? 2 : 1);
    if (accepted) assert.equal(JSON.parse(calls[1][1].body).provider, provider);
    assert.equal(context.ttsStarting, false);
  }
});

test('Anbieterdialog: explizite Auswahl, Kostenhinweis, gesperrte Anbieter und Abbrechen', async () => {
  const source = await fs.readFile(path.join(root, '../public/app.js'), 'utf8');
  const start = source.indexOf('function chooseTtsProvider(');
  const end = source.indexOf('\n}', start) + 2;
  for (const available of [[true, true], [true, false], [false, true], [false, false]]) {
    for (const action of ['start', 'cancel', '']) {
      let close;
      const elements = {};
      const element = id => elements[id] ||= { children: [], value: '',
        replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
        focus() {}, showModal() {}, querySelector() { return element('cancel'); }, addEventListener(_event, callback) { close = callback; } };
      const providers = ['qwen', 'openai'].map((provider, i) => ({ provider, available: available[i],
        label: provider, status: 'Test', confirmation: provider === 'openai' ? 'kostenpflichtig' : 'lokal' }));
      let created = 0;
      const context = vm.createContext({ document: { getElementById: element, createElement: () => element(`created-${created++}`) }, providers });
      const result = vm.runInContext(source.slice(start, end) + '\nchooseTtsProvider({ title: "Artikel" }, providers)', context);
      const options = element('tts-provider-options'), button = element('tts-provider-start');
      const radios = options.children.map(label => label.children[0]);
      assert.equal(button.disabled, true);
      assert.equal(radios.length, 2);
      providers.forEach((p, i) => {
        assert.equal(radios[i].type, 'radio');
        assert.equal(radios[i].name, 'tts-provider');
        assert.equal(radios[i].disabled, !p.available);
      });
      const chosen = providers.findLast(p => p.available);
      const radio = radios.find(r => r.value === (chosen?.provider || 'openai'));
      radio.checked = true; radio.onchange();
      assert.equal(button.disabled, !chosen);
      if (chosen) assert.equal(element('tts-provider-description').textContent, chosen.confirmation);
      element('tts-provider-dialog').returnValue = action; close();
      assert.equal(await result, action === 'start' ? chosen || null : null);
    }
  }
});

test('Qwen-Abbruch hinterlässt keine MP3 oder Sperre', () => temporary(async dir => {
  const input = path.join(dir, 'input.md'), output = path.join(dir, 'output.mp3');
  await fs.writeFile(input, '# Original\n' + 'Text '.repeat(2000));
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(convert(input, output, config, {
    signal: controller.signal,
    synth: async (_text, file) => {
      calls++;
      await fs.writeFile(file, 'unvollständig');
      controller.abort(new Error('Testabbruch'));
      controller.signal.throwIfAborted();
    },
  }), /Testabbruch/);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(dir), ['input.md']);
}));

test('Status-Polling lässt unverändertes Log und manuelle Scrollposition stehen', async () => {
  const source = await fs.readFile(path.join(root, '../public/app.js'), 'utf8');
  const start = source.indexOf('async function watchTts(jobId) {');
  const end = source.indexOf('\n}', start) + 2;
  let polls = 0, writes = 0, value = 'Bestehende Zeile';
  const output = { scrollTop: 50, clientHeight: 100, scrollHeight: 500,
    get textContent() { return value; },
    set textContent(next) { writes++; value = next; this.scrollTop = 0; } };
  const context = vm.createContext({ ttsPollGeneration: 0, ttsActive: true,
    $ttsOverlay: { hidden: false }, $ttsOutput: output, $ttsStatus: {}, $ttsCancel: {}, $ttsActivity: {}, $ttsReindex: {},
    document: { getElementById: () => ({}) }, updateTtsActions() {}, setTimeout: callback => callback(),
    apiFetch: async () => ({ ok: true, status: 200, json: async () => {
      polls++;
      if (polls <= 2) assert.equal(writes, 0);
      return { title: 'Test', done: polls === 3, status: polls === 3 ? 'succeeded' : 'running',
        output: polls === 3 ? 'Bestehende Zeile\nNeue Zeile' : 'Bestehende Zeile' };
    } }),
  });
  await vm.runInContext(source.slice(start, end) + '\nwatchTts("test")', context);
  assert.equal(polls, 3);
  assert.equal(writes, 1);
  assert.equal(output.scrollTop, 50);
});

test('Echter HTTP-Dienst und Original-CLI-Vertrag: Markdown rein, fertige MP3 unverändert zurück', () => temporary(async dir => {
  const fixture = path.join(dir, 'fixture.mp3');
  await runTool(config.audio.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.4', '-c:a', 'libmp3lame', fixture], undefined, 10);
  const script = path.join(dir, 'fake.py');
  await fs.writeFile(script, `import argparse, shutil
from pathlib import Path
parser = argparse.ArgumentParser()
for name in ["config", "input", "output"]: parser.add_argument("--"+name, required=True)
args = parser.parse_args()
Path(args.config+".input").write_bytes(Path(args.input).read_bytes())
shutil.copyfile(args.config, args.output)
`);
  const token = 'offline-test-token-with-at-least-32-characters';
  const child = spawn('python', ['-B', path.join(root, 'qwen_http_service.py'), '--script', script, '--config', fixture, '--port', '0'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, QWEN_TTS_TOKEN: token } });
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Testzeitlimit')), 15000);
  try {
    const [line] = await once(lines, 'line', { signal: controller.signal });
    const { port } = JSON.parse(line);
    process.env.QWEN_E2E_TEST_TOKEN = token;
    const c = structuredClone(config);
    c.qwen = { base_url: `http://127.0.0.1:${port}`, token_environment_variable: 'QWEN_E2E_TEST_TOKEN' };
    const source = path.join(dir, 'input.md'), output = path.join(dir, 'result.mp3');
    const markdown = '\ufeff# Titel\r\n**Hallo Welt.** [Link](https://example.org)\r\n'.repeat(250);
    await fs.writeFile(source, markdown);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => { throw new Error('Kein Undici für Qwen'); };
      await convert(source, output, c, { signal: controller.signal });
    } finally { globalThis.fetch = originalFetch; }
    assert.deepEqual(await fs.readFile(fixture + '.input'), Buffer.from(markdown));
    assert.deepEqual(await fs.readFile(output), await fs.readFile(fixture));
    assert.equal(stderr, '');
  } finally {
    clearTimeout(timer); lines.close(); child.kill(); await closed;
    delete process.env.QWEN_E2E_TEST_TOKEN;
  }
}));

test('HTTP/1.0: große Antwort bei langsamem Leser und sofortigem Socket-Ende', async () => {
  const data = Buffer.alloc(4 * 1024 * 1024, 7);
  const server = net.createServer(socket => socket.once('data', () => {
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.0 200 OK\r\nContent-Length: ${data.length}\r\n\r\n`), data]));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await requestQwen(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(10000) });
    await new Promise(r => setTimeout(r, 50));
    let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; await new Promise(r => setTimeout(r, 1)); }
    assert.equal(bytes, data.length);
  } finally { await new Promise(r => server.close(r)); }
});

test('HTTP: abgeschnittener Stream und Abbruch werden zu behandelbaren Fehlern', async () => {
  for (const abort of [false, true]) {
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write('HTTP/1.0 200 OK\r\nContent-Length: 100000\r\n\r\nkurz');
        if (!abort) socket.end();
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const controller = new AbortController();
      const response = await requestQwen(`http://127.0.0.1:${server.address().port}`, { signal: controller.signal });
      if (abort) controller.abort();
      await assert.rejects(async () => { for await (const _chunk of response.body) {} });
    } finally { await new Promise(r => server.close(r)); }
  }
});
