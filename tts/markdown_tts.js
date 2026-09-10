#!/usr/bin/env node
/** Standalone Markdown -> MP3 worker. See INTEGRATION.md for spawn/popup wiring. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const length = text => Array.from(text).length;
const fail = (message, code = 'PROCESSING_ERROR') => Object.assign(new Error(message), { code });
const check = signal => signal?.throwIfAborted();
// Python round uses ties-to-even; retain its PCM cut boundaries.
const round = x => Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
const duration = wav => wav.data.length / (wav.channels * wav.width * wav.rate);

export async function loadConfig(filename = path.join(ROOT, 'config.json')) {
  const configPath = path.resolve(filename);
  let c;
  try {
    c = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    for (const section of ['parser', 'renderer', 'chunking', 'tts', 'prefill', 'audio', 'runtime']) {
      if (!c[section] || typeof c[section] !== 'object') throw Error(`Abschnitt ${section} fehlt.`);
    }
    for (const [section, keys] of Object.entries({
      chunking: ['max_characters', 'preferred_minimum_characters', 'minimum_split_ratio'],
      tts: ['speed', 'timeout_seconds'], audio: ['timeout_seconds', 'duration_tolerance_seconds'],
      prefill: ['analysis_window_milliseconds', 'minimum_quiet_milliseconds', 'minimum_remaining_seconds'],
      runtime: ['job_timeout_seconds'],
    })) for (const key of keys) {
      if (!Number.isFinite(c[section][key]) || c[section][key] <= 0) throw Error(`${section}.${key} muss positiv sein.`);
    }
    for (const [section, keys] of Object.entries({
      parser: ['front_matter_delimiter', 'url_pattern', 'date_line_pattern'],
      renderer: ['block_separator', 'list_item_separator', 'ordered_list_fallback'],
      tts: ['model', 'voice', 'instructions', 'api_key_environment_variable'],
      prefill: ['text', 'separator'], audio: ['ffmpeg', 'ffprobe', 'bitrate'], runtime: ['cache_directory'],
    })) for (const key of keys) {
      if (typeof c[section][key] !== 'string' || !c[section][key]) throw Error(`${section}.${key} fehlt.`);
    }
    for (const [section, key] of [['parser', 'source_prefixes'], ['renderer', 'ordered_list_markers'], ['chunking', 'boundary_groups']]) {
      if (!Array.isArray(c[section][key]) || !c[section][key].every(s => typeof s === 'string')) throw Error(`${section}.${key} ist ungültig.`);
    }
    for (const key of ['heading_suffix', 'list_marker_suffix']) {
      if (typeof c.renderer[key] !== 'string') throw Error(`renderer.${key} fehlt.`);
    }
    if (!Number.isInteger(c.chunking.max_characters) || c.chunking.minimum_split_ratio > 1
        || c.chunking.preferred_minimum_characters > c.chunking.max_characters
        || length(c.prefill.text + c.prefill.separator) >= c.chunking.max_characters) throw Error('Chunk-Limit ist ungültig.');
    if (!Number.isInteger(c.tts.max_retries) || c.tts.max_retries < 0 || c.tts.max_retries > 5) throw Error('max_retries muss zwischen 0 und 5 liegen.');
    for (const key of ['search_before_seconds', 'search_after_seconds', 'cut_safety_seconds']) {
      if (!Number.isFinite(c.prefill[key]) || c.prefill[key] < 0) throw Error(`prefill.${key} ist ungültig.`);
    }
    if (!Number.isFinite(c.prefill.quiet_threshold_dbfs) || c.prefill.quiet_threshold_dbfs >= 0) throw Error('Ruhepegel muss negativ sein.');
    if (typeof c.runtime.keep_failed_work !== 'boolean') throw Error('keep_failed_work muss boolesch sein.');
    new RegExp(c.parser.url_pattern, c.parser.url_flags);
    new RegExp(c.parser.date_line_pattern, 'u');
    c.runtime.cache_directory = path.resolve(path.dirname(configPath), c.runtime.cache_directory);
    return c;
  } catch (error) { throw fail(`Konfiguration: ${error.message}`, 'CONFIG_ERROR'); }
}

export function speechBlocks(markdown, c) {
  const p = c.parser, r = c.renderer;
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === p.front_matter_delimiter) {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === p.front_matter_delimiter);
    if (end > 0) lines.splice(0, end + 1);
  }
  const tokens = new MarkdownIt('commonmark', { html: true }).enable('table').use(footnote).parse(lines.join('\n'), {});
  const url = new RegExp(p.url_pattern, p.url_flags), date = new RegExp(p.date_line_pattern, 'u');
  function inline(children) {
    const kept = []; let line = [], previousBreak = '';
    for (const token of [...children, null]) {
      if (!token || ['softbreak', 'hardbreak'].includes(token.type)) {
        const text = line.join('');
        if (!p.source_prefixes.some(s => text.trimStart().startsWith(s)) && !date.test(text.trimStart())) {
          if (kept.length) kept.push(previousBreak);
          kept.push(text); previousBreak = token?.type === 'hardbreak' ? '\n' : ' ';
        }
        line = [];
      } else if (['text', 'code_inline'].includes(token.type)) line.push(token.content.replace(url, ''));
    }
    return kept.join('').trim();
  }
  let index = 0;
  function walk(stop) {
    const blocks = [];
    while (index < tokens.length) {
      const token = tokens[index++], kind = token.type;
      if (kind === stop) break;
      if (['paragraph_open', 'heading_open'].includes(kind)) {
        let text = inline(tokens[index].children || []); index += 2;
        const heading = kind === 'heading_open';
        if (text && heading && !text.endsWith(r.heading_suffix)) text += r.heading_suffix;
        if (text && (heading || /[\p{L}\p{N}]/u.test(text))) blocks.push([heading ? 'heading' : 'paragraph', text]);
      } else if (['bullet_list_open', 'ordered_list_open'].includes(kind)) {
        const ordered = kind === 'ordered_list_open', items = [];
        let number = Number(token.attrGet('start') || 1);
        while (tokens[index]?.type === 'list_item_open') {
          index++;
          const text = walk('list_item_close').map(b => b[1]).join(r.list_item_separator);
          if (text) {
            const marker = ordered ? (r.ordered_list_markers[number - 1] ?? r.ordered_list_fallback.replace('{number}', number)) : '';
            items.push((marker ? marker + r.list_marker_suffix : '') + text);
          }
          number++;
        }
        index++;
        if (items.length) blocks.push(['list', items.join(r.list_item_separator)]);
      } else if (kind === 'blockquote_open') {
        const children = walk('blockquote_close');
        if (children.length) blocks.push(['quote', children.map(b => b[1]).join(r.block_separator)]);
      } else if (['table_open', 'footnote_block_open'].includes(kind)) {
        const end = kind.replace('_open', '_close');
        while (index < tokens.length && tokens[index].type !== end) index++;
        index++;
      }
    }
    return blocks;
  }
  return walk();
}

export function chunkText(blocks, c) {
  const rule = c.chunking, sep = c.renderer.block_separator;
  const limit = rule.max_characters - length(c.prefill.text + c.prefill.separator);
  const chunks = []; let current = [];
  const flush = () => { if (current.length) chunks.push(current.map(b => b[1]).join(sep)); current = []; };
  const split = (chars, available) => {
    const minimum = Math.max(1, Math.floor(available * rule.minimum_split_ratio));
    for (const group of rule.boundary_groups) {
      for (let i = Math.min(available - 1, chars.length - 1); i >= minimum; i--) {
        if (group.includes(chars[i]) && (i + 1 === chars.length || /\s/u.test(chars[i + 1]))) return i + 1;
      }
    }
    for (let i = Math.min(available, chars.length - 1); i > 0; i--) if (/\s/u.test(chars[i])) return i;
    return 0;
  };
  for (const [kind, original] of blocks) {
    if (kind === 'heading') flush();
    let text = original;
    while (text) {
      const available = limit - length(current.map(b => b[1]).join(sep)) - (current.length ? length(sep) : 0);
      if (length(text) <= available) { current.push([kind, text]); break; }
      const headingNeedsContent = current.length === 1 && current[0][0] === 'heading';
      if (current.length && ((length(text) <= limit && !headingNeedsContent)
          || !(headingNeedsContent || available >= rule.preferred_minimum_characters))) { flush(); continue; }
      const chars = Array.from(text), cut = split(chars, available);
      if (!cut) {
        if (current.length) { flush(); continue; }
        throw fail('Text überschreitet das Limit ohne trennbare Wortgrenze.', 'TEXT_ERROR');
      }
      current.push([kind, chars.slice(0, cut).join('').trim()]); text = chars.slice(cut).join('').trim(); flush();
    }
  }
  flush(); return chunks;
}

/** Streaming SSE decoder: UTF-8, CRLF, split packets, EOF, and [DONE]. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [];
  function parse(line) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    if (line !== '' || !data.length) return;
    const payload = data.join('\n'); data = [];
    if (payload.trim() === '[DONE]') return;
    const event = JSON.parse(payload);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw fail('Ungültiges SSE-Ereignis.');
    return event;
  }
  async function* decoded() {
    for await (const bytes of body) yield decoder.decode(bytes, { stream: true });
    yield decoder.decode() + '\n\n';
  }
  for await (const part of decoded()) {
    buffer += part;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      const event = parse(line); if (event) yield event;
    }
  }
}

export async function synthesize(text, file, c, signal, emit = () => {}, fetchImpl = fetch) {
  if (!text.trim() || length(text) > c.chunking.max_characters) throw fail('Ungültige Request-Länge.');
  const key = process.env[c.tts.api_key_environment_variable]?.trim();
  if (!key) throw fail(`API-Key fehlt: ${c.tts.api_key_environment_variable}`, 'CONFIG_ERROR');
  const t = c.tts;
  for (let attempt = 0; ; attempt++) {
    check(signal);
    const timeout = AbortSignal.timeout(t.timeout_seconds * 1000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Retry explicit transient HTTP rejections only. Never silently repeat a
    // partially consumed stream (a second synthesis may incur additional cost).
    const response = await fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST', signal: requestSignal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: t.model, voice: t.voice, instructions: t.instructions.trim(), speed: t.speed,
        input: text, response_format: path.extname(file).slice(1), stream_format: 'sse' }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([408, 409, 429, 500, 502, 503, 504].includes(response.status) && attempt < t.max_retries) {
        emit('retry', `TTS-Dienst HTTP ${response.status}; erneuter Versuch ${attempt + 1}.`);
        await delay(Math.min(1000 * 2 ** attempt, 8000), undefined, { signal }); continue;
      }
      throw fail(`TTS-Dienst antwortet mit HTTP ${response.status}.`, 'API_ERROR');
    }
    if (!response.body) throw fail('TTS-Antwort enthält keinen Audiostream.', 'API_ERROR');
    const target = await fs.open(file, 'wx'); let done = false, bytes = 0;
    try {
      for await (const event of sseEvents(response.body)) {
        check(signal);
        if (event.type === 'speech.audio.delta') {
          const encoded = event.audio;
          if (typeof encoded !== 'string' || !encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail('Ungültige Base64-Audiodaten.');
          const audio = Buffer.from(encoded, 'base64');
          await target.writeFile(audio); bytes += audio.length;
        } else if (event.type === 'speech.audio.done') done = true;
        else if (event.type === 'error') throw fail('Fehler im TTS-Audiostream.', 'API_ERROR');
      }
      if (!done || !bytes) throw fail('TTS-Audiostream ist leer oder unvollständig.', 'API_ERROR');
    } finally { await target.close(); }
    return;
  }
}

export function decodeWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw fail('Ungültiger WAV-Header.');
  let format, data;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', pos, pos + 4), size = buffer.readUInt32LE(pos + 4), start = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || start + size > buffer.length) throw fail('Ungültiger WAV-fmt-Block.');
      let tag = buffer.readUInt16LE(start);
      if (tag === 0xfffe && size >= 40 && buffer.readUInt16LE(start + 16) >= 22
          && buffer.subarray(start + 24, start + 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex'))) tag = 1;
      const channels = buffer.readUInt16LE(start + 2), rate = buffer.readUInt32LE(start + 4), bits = buffer.readUInt16LE(start + 14);
      const width = bits / 8;
      if (tag !== 1 || ![1, 2, 3, 4].includes(width) || !channels || !rate
          || buffer.readUInt16LE(start + 12) !== channels * width) throw fail('Nicht unterstütztes PCM-Format.');
      format = { channels, width, rate };
    } else if (id === 'data') {
      // OpenAI streamed WAVs can declare an unknown/placeholder data length.
      if (start + size > buffer.length && ![0xffffffff, 0x7fffffff].includes(size)) throw fail('WAV-Nutzdaten sind abgeschnitten.');
      data = buffer.subarray(start, Math.min(start + size, buffer.length)); break;
    }
    pos = start + size + (size % 2);
  }
  if (!format || !data?.length || data.length % (format.channels * format.width)) throw fail('WAV enthält keine vollständigen PCM-Frames.');
  return { ...format, data };
}

export function wavHeader(wav, bytes) {
  if (bytes > 0xffffffff - 36) throw fail('WAV überschreitet das RIFF-Größenlimit.');
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(wav.channels, 22); b.writeUInt32LE(wav.rate, 24);
  b.writeUInt32LE(wav.rate * wav.channels * wav.width, 28); b.writeUInt16LE(wav.channels * wav.width, 32);
  b.writeUInt16LE(wav.width * 8, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}

export function trimPrefill(wav, expected, c) {
  const p = c.prefill, { channels, width, rate, data } = wav, frameBytes = channels * width;
  const start = Math.max(0, Math.floor((expected - p.search_before_seconds) * rate));
  const end = Math.min(data.length / frameBytes, Math.ceil((expected + p.search_after_seconds) * rate));
  const window = Math.max(1, round(p.analysis_window_milliseconds * rate / 1000));
  const minimum = Math.ceil(p.minimum_quiet_milliseconds * rate / 1000), regions = [];
  let active = null;
  for (let pos = start; pos < end; pos += window) {
    const stop = Math.min(pos + window, end); let sum = 0;
    for (let i = pos * frameBytes; i < stop * frameBytes; i += width) {
      const sample = width === 1 ? data[i] - 128 : data.readIntLE(i, width); sum += sample * sample;
    }
    const rms = Math.sqrt(sum / ((stop - pos) * channels));
    const db = rms ? 20 * Math.log10(rms / 2 ** (width * 8 - 1)) : -Infinity;
    if (db <= p.quiet_threshold_dbfs) { if (active === null) active = pos; }
    else if (active !== null) { if (pos - active >= minimum) regions.push([active, pos]); active = null; }
  }
  if (active !== null && end - active >= minimum) regions.push([active, end]);
  const safe = regions.filter(([a]) => a <= round(expected * rate));
  if (!safe.length) throw fail('Keine sichere Ruhephase an der Pre-Fill-Grenze gefunden.', 'TRIM_ERROR');
  const [a, b] = safe.at(-1), cut = Math.max(a, Math.floor((a + b) / 2) - round(p.cut_safety_seconds * rate));
  if (data.length / frameBytes - cut < Math.ceil(p.minimum_remaining_seconds * rate)) throw fail('Zu wenig Audio nach dem Schnitt.', 'TRIM_ERROR');
  return { ...wav, data: data.subarray(cut * frameBytes), cutSeconds: cut / rate };
}

/** Drain both pipes; wait for close even after abort, so FFmpeg is reaped. */
export function runTool(executable, args, signal, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    check(signal);
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', stopped = false, spawnError;
    const stop = () => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutSeconds * 1000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => { output = (output + s).slice(-65536); });
    child.stderr.on('data', s => { diagnostic = (diagnostic + s).slice(-4096); });
    child.on('error', e => { spawnError = e; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(signal.reason);
      else if (stopped) reject(fail(`${path.basename(executable)}: Zeitlimit überschritten.`, 'TIMEOUT'));
      else if (spawnError || code !== 0) reject(fail(`${path.basename(executable)} fehlgeschlagen: ${spawnError?.message || diagnostic.trim() || code}`, 'AUDIO_ERROR'));
      else resolve(output);
    });
    if (signal?.aborted) stop();
  });
}

async function calibration(c, work, signal, emit, synth) {
  const key = JSON.stringify({ schema: 1, tts: c.tts, prefill: c.prefill });
  const cache = path.join(c.runtime.cache_directory, createHash('sha256').update(key).digest('hex') + '.wav');
  try {
    const wav = decodeWav(await fs.readFile(cache)); emit('calibration', 'Pre-Fill-Kalibrierung wiederverwendet.'); return wav;
  } catch (error) { if (error.code !== 'ENOENT') emit('warning', 'Kalibrierungs-Cache nicht lesbar; wird neu erzeugt.'); }
  emit('calibration', 'Pre-Fill wird kalibriert.');
  const raw = path.join(work, 'calibration.wav'); await synth(c.prefill.text, raw, c, signal, emit);
  const wav = decodeWav(await fs.readFile(raw));
  await fs.mkdir(c.runtime.cache_directory, { recursive: true });
  const temp = path.join(c.runtime.cache_directory, randomUUID() + '.tmp');
  try {
    await fs.writeFile(temp, Buffer.concat([wavHeader(wav, wav.data.length), wav.data]), { flag: 'wx' });
    await fs.rename(temp, cache);
  } finally { await fs.rm(temp, { force: true }); }
  return wav;
}

export async function convert(input, output, c, { signal, emit = () => {}, synth = synthesize } = {}) {
  const source = path.resolve(input), target = path.resolve(output);
  if (path.extname(target).toLowerCase() !== '.mp3' || source === target) throw fail('Ausgabe muss eine andere Datei mit Endung .mp3 sein.', 'ARGUMENT_ERROR');
  check(signal);
  try { await fs.lstat(target); throw fail('Ausgabedatei existiert bereits.', 'OUTPUT_EXISTS'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(source));
  const blocks = speechBlocks(markdown, c), text = blocks.map(b => b[1]).join(c.renderer.block_separator);
  if (!text.trim()) throw fail('Das Dokument enthält keinen sprechbaren Text.', 'TEXT_ERROR');
  const long = length(text) > c.chunking.max_characters, chunks = long ? chunkText(blocks, c) : [text];
  if (synth === synthesize && !process.env[c.tts.api_key_environment_variable]?.trim()) throw fail(`API-Key fehlt: ${c.tts.api_key_environment_variable}`, 'CONFIG_ERROR');
  // Preflight tools and target lock before any paid request.
  if (long) for (const tool of ['ffmpeg', 'ffprobe']) await runTool(c.audio[tool], ['-version'], signal, 10);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const lockPath = target + '.tts-lock';
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw fail('Für diesen Ausgabepfad läuft bereits ein Auftrag (oder eine verwaiste .tts-lock-Datei liegt vor).', 'OUTPUT_BUSY'); throw error; }
  let work, published = false;
  try {
    try { await fs.lstat(target); throw fail('Ausgabedatei existiert bereits.', 'OUTPUT_EXISTS'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    work = await fs.mkdtemp(path.join(path.dirname(target), '.markdown-tts-'));
    const staged = path.join(work, 'output.mp3');
    emit('start', `${length(text)} Zeichen; ${chunks.length} Chunk(s), ${long ? 'mit' : 'ohne'} Pre-Fill.`, { total: chunks.length, characters: length(text) });
    if (!long) {
      emit('synthesis', 'Direkte MP3-Synthese ohne Pre-Fill.', { current: 1, total: 1 });
      await synth(text, staged, c, signal, emit);
    } else {
      const reference = await calibration(c, work, signal, emit, synth);
      const combined = path.join(work, 'combined.wav'), joined = await fs.open(combined, 'wx');
      let bytes = 0;
      try {
        await joined.writeFile(wavHeader(reference, 0));
        for (let i = 0; i < chunks.length; i++) {
          check(signal); emit('synthesis', `Chunk ${i + 1}/${chunks.length} mit Pre-Fill.`, { current: i + 1, total: chunks.length });
          const raw = path.join(work, `chunk-${i + 1}.wav`);
          await synth(c.prefill.text + c.prefill.separator + chunks[i], raw, c, signal, emit);
          const wav = decodeWav(await fs.readFile(raw));
          if (['channels', 'width', 'rate'].some(k => wav[k] !== reference[k])) throw fail('WAV-Parameter weichen von der Kalibrierung ab.');
          const trimmed = trimPrefill(wav, duration(reference), c);
          await joined.writeFile(trimmed.data); bytes += trimmed.data.length;
          emit('trim', `Pre-Fill aus Chunk ${i + 1} bei ${trimmed.cutSeconds.toFixed(3)} s entfernt.`, { current: i + 1, total: chunks.length });
        }
        await joined.write(wavHeader(reference, bytes), 0, 44, 0);
      } finally { await joined.close(); }
      emit('encoding', 'Chunks werden als MP3 kodiert und geprüft.');
      await runTool(c.audio.ffmpeg, ['-nostdin', '-v', 'error', '-n', '-i', combined, '-c:a', 'libmp3lame', '-b:a', c.audio.bitrate, staged], signal, c.audio.timeout_seconds);
      const info = JSON.parse(await runTool(c.audio.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', staged], signal, c.audio.timeout_seconds));
      const seconds = Number(info.format?.duration), expected = bytes / (reference.channels * reference.width * reference.rate);
      if (!info.streams?.some(s => s.codec_name === 'mp3') || !Number.isFinite(seconds)
          || Math.abs(seconds - expected) > c.audio.duration_tolerance_seconds) throw fail('MP3-Prüfung: Codec oder Dauer stimmen nicht.');
    }
    check(signal);
    if (!(await fs.stat(staged)).size) throw fail('MP3 ist leer.');
    await fs.link(staged, target); published = true; // atomic, same filesystem, never overwrite
    return { outputPath: target, chunks: chunks.length, characters: length(text) };
  } finally {
    if (work && (published || signal?.aborted || !c.runtime.keep_failed_work)) {
      await fs.rm(work, { recursive: true, force: true }).catch(() => emit('warning', `Arbeitsverzeichnis konnte nicht entfernt werden: ${work}`));
    } else if (work) emit('diagnostic', `Arbeitsdateien bleiben erhalten: ${work}`);
    await lock.close();
    await fs.rm(lockPath, { force: true }).catch(() => emit('warning', `Auftragssperre konnte nicht entfernt werden: ${lockPath}`));
  }
}

export function parseArgs(argv) {
  const options = { jsonProgress: false }; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a === '--json-progress') options.jsonProgress = true;
    else if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--output' || a === '--config') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw fail(`Wert für ${a} fehlt.`, 'ARGUMENT_ERROR');
      const key = a.slice(2); if (options[key]) throw fail(`${a} doppelt angegeben.`, 'ARGUMENT_ERROR');
      options[key] = argv[++i];
    } else if (a.startsWith('-')) throw fail(`Unbekannter Parameter: ${a}`, 'ARGUMENT_ERROR');
    else positional.push(a);
  }
  if (!options.help && (positional.length !== 1 || !options.output)) throw fail('Aufruf: node markdown_tts.js input.md --output output.mp3 [--json-progress] [--config config.json]', 'ARGUMENT_ERROR');
  return { ...options, input: positional[0] };
}

export async function main(argv) {
  const controller = new AbortController(); let json = argv.includes('--json-progress'), timer;
  const emit = (type, message, fields = {}) => {
    const event = { version: 1, time: new Date().toISOString(), type, message, ...fields };
    process.stderr.write(json ? JSON.stringify(event) + '\n' : `${event.time} [${type.toUpperCase()}] ${message}\n`);
  };
  const abort = () => controller.abort(fail('Auftrag abgebrochen.', 'CANCELLED'));
  const onMessage = message => { if (message?.type === 'cancel') abort(); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort); process.on('message', onMessage); process.on('disconnect', abort);
  try {
    const args = parseArgs(argv); json = args.jsonProgress;
    if (args.help) { process.stdout.write('node markdown_tts.js input.md --output output.mp3 [--config config.json] [--json-progress]\n'); return 0; }
    const c = await loadConfig(args.config);
    timer = setTimeout(() => controller.abort(fail('Gesamtzeitlimit überschritten.', 'TIMEOUT')), c.runtime.job_timeout_seconds * 1000);
    const result = await convert(args.input, args.output, c, { signal: controller.signal, emit });
    emit('complete', 'MP3-Datei erfolgreich erzeugt.');
    process.stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const actual = controller.signal.aborted ? controller.signal.reason : error;
    emit('error', actual.message, { code: actual.code || 'PROCESSING_ERROR' });
    return actual.code === 'CANCELLED' ? 130 : ['ARGUMENT_ERROR', 'CONFIG_ERROR'].includes(actual.code) ? 2 : 1;
  } finally {
    clearTimeout(timer); process.off('SIGINT', abort); process.off('SIGTERM', abort);
    process.off('message', onMessage); process.off('disconnect', abort);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
