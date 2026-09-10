/** Optional CommonJS adapter for WebArchiv/server.js. No Express dependency. */
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

function startTts({ inputPath, outputPath, configPath, onEvent = () => {}, scriptPath = path.join(__dirname, 'markdown_tts.js') }) {
  const args = [scriptPath, path.resolve(inputPath), '--output', path.resolve(outputPath), '--json-progress'];
  if (configPath) args.push('--config', path.resolve(configPath));
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(scriptPath), shell: false, windowsHide: true,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let result, lastError, startError, timer, settled = false;
  const notify = event => { try { onEvent(event); } catch { /* UI/log callbacks must not orphan a paid worker. */ } };
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stdout.on('line', line => {
    try {
      const candidate = JSON.parse(line);
      if (result || typeof candidate.outputPath !== 'string' || !Number.isInteger(candidate.chunks)
          || candidate.chunks < 1 || path.resolve(candidate.outputPath) !== path.resolve(outputPath)) throw Error();
      result = candidate;
    } catch { lastError = 'Ungültige Ergebnisantwort des TTS-Prozesses.'; }
  });
  stderr.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (typeof event.type !== 'string' || typeof event.message !== 'string') throw Error();
      if (event.type === 'error') lastError = event.message;
      notify(event);
    } catch { notify({ type: 'log', message: line }); }
  });
  const completion = new Promise((resolve, reject) => {
    child.on('error', error => { startError = error; });
    child.on('close', (code, signal) => {
      settled = true; clearTimeout(timer); stdout.close(); stderr.close();
      if (!startError && code === 0 && result && !lastError) resolve(result);
      else reject(Object.assign(new Error(startError?.message || lastError || `TTS beendet: Exit ${code}, Signal ${signal || '-'}`),
        { exitCode: code, signal, cancelled: code === 130 }));
    });
  });
  return {
    child, completion,
    cancel() {
      if (settled || timer) return;
      // IPC enables cooperative cleanup on Windows as well as Linux.
      if (child.connected) child.send({ type: 'cancel' }, error => { if (error && !settled) child.kill(); });
      else child.kill();
      timer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 10000);
      timer.unref();
    },
  };
}
module.exports = { startTts };
