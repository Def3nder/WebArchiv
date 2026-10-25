/* WebArchiv — serverweite Qwen-Stimmenverwaltung für Administratoren. */
(() => {
  const dialog = document.getElementById('tts-settings-dialog');
  const closeButton = document.getElementById('tts-settings-close');
  const status = document.getElementById('tts-settings-status');
  const select = document.getElementById('tts-settings-voice');
  const meta = document.getElementById('tts-settings-meta');
  const saveButton = document.getElementById('tts-settings-save');
  const refreshButton = document.getElementById('tts-settings-refresh');
  const previewButton = document.getElementById('tts-settings-preview');
  const renameButton = document.getElementById('tts-settings-rename');
  const trashButton = document.getElementById('tts-settings-trash');
  const previewAudio = document.getElementById('tts-settings-preview-audio');
  const nameInput = document.getElementById('tts-settings-name');
  const recordButton = document.getElementById('tts-settings-record');
  const stopButton = document.getElementById('tts-settings-stop');
  const fileInput = document.getElementById('tts-settings-file');
  const duration = document.getElementById('tts-settings-duration');
  const recordingAudio = document.getElementById('tts-settings-recording-audio');
  const createButton = document.getElementById('tts-settings-create');
  const discardButton = document.getElementById('tts-settings-discard');
  const cancelJobButton = document.getElementById('tts-settings-cancel-job');

  let data = null;
  let recording = null;
  let recordingUrl = null;
  let previewObjectUrl = null;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recordingStarted = 0;
  let recordingTimer = null;
  let discardOnStop = false;
  let pollGeneration = 0;
  let previewJobId = null;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  async function request(url, options = {}) {
    const response = await apiFetch(url, options);
    let body = {};
    if (response.status !== 204) {
      try { body = await response.json(); } catch { /* Fehler unten vereinheitlichen. */ }
    }
    if (!response.ok) {
      const error = new Error(body.error || `Anfrage fehlgeschlagen (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function selectedVoice() {
    return data?.voices?.find(voice => voice.id === select.value) || null;
  }

  function syncVoiceMenu() {
    if (typeof syncFilterAriaMenu !== 'function') return;
    syncFilterAriaMenu(select);
    const root = typeof filterAriaRoot === 'function' ? filterAriaRoot(select) : null;
    const trigger = root?.querySelector('.filter-menu-trigger');
    if (trigger) trigger.disabled = select.options.length === 0;
  }

  function closeVoiceMenu() {
    if (typeof filterAriaRoot !== 'function' || typeof closeFilterAriaMenu !== 'function') return;
    closeFilterAriaMenu(filterAriaRoot(select));
  }

  function renderVoiceMeta() {
    const voice = selectedVoice();
    if (!voice) {
      meta.textContent = data?.qwenVoiceId && !data.selectedAvailable
        ? `Die gespeicherte Stimme „${data.qwenVoiceId}“ fehlt auf dem TTS-Server.`
        : 'Noch keine Stimme ausgewählt.';
      return;
    }
    const created = voice.createdAt ? new Date(voice.createdAt).toLocaleString('de-DE') : 'unbekannt';
    const preview = voice.previewAvailable
      ? `Stimmprobe auf dem WebArchiv gespeichert: ${new Date(voice.previewCreatedAt).toLocaleString('de-DE')}`
      : 'Noch keine aktuelle Stimmprobe auf dem WebArchiv gespeichert';
    meta.textContent = `Modell: ${voice.model} · Datei auf dem TTS-Server · Stand: ${created} · ${preview}`;
  }

  function renderStoredPreview() {
    const voice = selectedVoice();
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
    previewAudio.pause();
    if (voice?.previewAvailable && voice.previewUrl) {
      previewAudio.src = voice.previewUrl;
      previewAudio.hidden = false;
      previewButton.textContent = 'Stimmprobe neu erzeugen';
    } else {
      previewAudio.removeAttribute('src');
      previewAudio.hidden = true;
      previewButton.textContent = 'Stimmprobe erzeugen';
    }
  }

  function updateButtons() {
    const hasVoice = !!selectedVoice();
    saveButton.disabled = !hasVoice;
    previewButton.disabled = !hasVoice;
    renameButton.disabled = !hasVoice;
    trashButton.disabled = !hasVoice || select.value === data?.qwenVoiceId;
    trashButton.title = trashButton.disabled && hasVoice ? 'Die aktive Stimme kann nicht verschoben werden.' : '';
    createButton.disabled = !recording || !nameInput.value.trim() || !!cancelJobButton.dataset.running;
    discardButton.disabled = !recording;
  }

  async function loadSettings(preselect) {
    message('Stimmen werden vom TTS-Server geladen …');
    try {
      data = await request('/api/tts/settings');
      select.replaceChildren();
      for (const voice of data.voices) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.name;
        select.append(option);
      }
      const wanted = preselect || data.qwenVoiceId;
      if (wanted && data.voices.some(voice => voice.id === wanted)) select.value = wanted;
      else if (data.voices.length) select.value = data.voices[0].id;
      message(data.busy ? 'Der TTS-Server ist gerade mit einem Auftrag beschäftigt.'
        : `${data.voices.length} Stimme${data.voices.length === 1 ? '' : 'n'} verfügbar.`);
      renderVoiceMeta();
      renderStoredPreview();
    } catch (error) {
      data = { voices: [] };
      select.replaceChildren();
      message(error.message, true);
    }
    syncVoiceMenu();
    updateButtons();
  }

  function revokeRecording() {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = null;
    recording = null;
    recordingAudio.removeAttribute('src');
    recordingAudio.hidden = true;
    fileInput.value = '';
    duration.textContent = '';
    updateButtons();
  }

  function stopTracks() {
    clearInterval(recordingTimer);
    recordingTimer = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }

  function stopRecording(discard = false) {
    discardOnStop = discard;
    if (recorder?.state === 'recording') recorder.stop();
    else stopTracks();
    recordButton.disabled = false;
    stopButton.disabled = true;
  }

  function useRecording(blob, label) {
    revokeRecording();
    recording = blob;
    recordingUrl = URL.createObjectURL(blob);
    recordingAudio.src = recordingUrl;
    recordingAudio.hidden = false;
    duration.textContent = `${label} · ${(blob.size / 1024).toFixed(0)} KB`;
    updateButtons();
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return message('Dieser Browser unterstützt keine Mikrofonaufnahme. Bitte eine Audiodatei auswählen.', true);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find(type => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      discardOnStop = false;
      recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        const elapsed = Math.max(0, (Date.now() - recordingStarted) / 1000);
        stopTracks();
        if (!discardOnStop && chunks.length) useRecording(new Blob(chunks, { type: recorder.mimeType || chunks[0].type }), `${elapsed.toFixed(1)} s`);
        chunks = [];
        recorder = null;
      }, { once: true });
      recorder.start(250);
      recordingStarted = Date.now();
      recordButton.disabled = true;
      stopButton.disabled = false;
      recordingTimer = setInterval(() => {
        duration.textContent = `Aufnahme: ${((Date.now() - recordingStarted) / 1000).toFixed(1)} s`;
        if (Date.now() - recordingStarted >= 60000) stopRecording();
      }, 200);
      message('Aufnahme läuft …');
    } catch (error) {
      stopTracks();
      message(error.name === 'NotAllowedError' ? 'Der Mikrofonzugriff wurde nicht erlaubt.' : `Aufnahme nicht möglich: ${error.message}`, true);
    }
  }

  function blobBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Aufnahme konnte nicht gelesen werden.'));
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
      reader.readAsDataURL(blob);
    });
  }

  async function pollVoiceJob(jobId, generation) {
    if (generation !== pollGeneration) return;
    try {
      const job = await request(`/api/tts/voices/jobs/${encodeURIComponent(jobId)}`);
      if (generation !== pollGeneration) return;
      const stages = { queued: 'Auftrag wartet …', converting: 'Aufnahme wird aufbereitet …', extracting: '1.7B-Stimme wird erzeugt …' };
      message(stages[job.stage] || `Stimmerzeugung: ${job.status}`);
      if (job.status === 'running') return setTimeout(() => pollVoiceJob(jobId, generation), 1000);
      cancelJobButton.hidden = true;
      delete cancelJobButton.dataset.running;
      sessionStorage.removeItem('wa-tts-voice-job');
      if (job.status === 'succeeded') {
        message(`Stimme „${job.voice.name}“ wurde im voices-Ordner des TTS-Servers gespeichert.`);
        revokeRecording();
        nameInput.value = '';
        await loadSettings(job.voice.id);
      } else message(job.error || `Stimmerzeugung ${job.status}.`, true);
      updateButtons();
    } catch (error) {
      message(error.message, true);
      if (error.status === 404) {
        cancelJobButton.hidden = true;
        delete cancelJobButton.dataset.running;
        sessionStorage.removeItem('wa-tts-voice-job');
        updateButtons();
        return;
      }
      setTimeout(() => pollVoiceJob(jobId, generation), 2000);
    }
  }

  async function createVoice() {
    if (!recording || !nameInput.value.trim()) return;
    createButton.disabled = true;
    message('Aufnahme wird übertragen …');
    try {
      const audioBase64 = await blobBase64(recording);
      const job = await request('/api/tts/voices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value.trim(), mimeType: recording.type || 'application/octet-stream', audioBase64 }),
      });
      sessionStorage.setItem('wa-tts-voice-job', job.id);
      cancelJobButton.hidden = false;
      cancelJobButton.dataset.running = 'true';
      const generation = ++pollGeneration;
      pollVoiceJob(job.id, generation);
    } catch (error) {
      message(error.message, true);
      updateButtons();
    }
  }

  async function saveSelection() {
    const voice = selectedVoice();
    if (!voice) return;
    try {
      data = await request('/api/tts/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId: voice.id }),
      });
      message(`„${voice.name}“ wird ab jetzt für alle neuen Qwen-TTS-Aufträge verwendet.`);
      renderVoiceMeta();
      updateButtons();
    } catch (error) { message(error.message, true); }
  }

  async function preview() {
    const voice = selectedVoice();
    if (!voice) return;
    previewButton.disabled = true;
    message(`Stimmprobe für „${voice.name}“ wird erzeugt …`);
    try {
      const started = await request('/api/tts/voices-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId: voice.id }),
      });
      const jobId = started.id;
      previewJobId = jobId;
      for (;;) {
        const state = await request(`/api/tts/voices-preview/${encodeURIComponent(jobId)}`);
        if (state.status === 'succeeded') break;
        if (state.status !== 'running') throw new Error(`Stimmprobe ${state.status}.`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const response = await apiFetch(`/api/tts/voices-preview/${encodeURIComponent(jobId)}/audio`);
      if (!response.ok) throw new Error('Stimmprobe konnte nicht geladen werden.');
      const audio = await response.blob();
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = URL.createObjectURL(audio);
      previewAudio.src = previewObjectUrl;
      previewAudio.hidden = false;
      await request(`/api/tts/voices-preview/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
      if (previewJobId === jobId) previewJobId = null;
      voice.previewAvailable = true;
      voice.previewCreatedAt = new Date().toISOString();
      previewButton.textContent = 'Stimmprobe neu erzeugen';
      renderVoiceMeta();
      message(`Stimmprobe für „${voice.name}“ wurde auf dem WebArchiv-Server gespeichert.`);
      previewAudio.play().catch(() => {});
    } catch (error) {
      message(error.message, true);
      if (previewJobId) request(`/api/tts/voices-preview/${encodeURIComponent(previewJobId)}`, { method: 'DELETE' }).catch(() => {});
      previewJobId = null;
    } finally { previewButton.disabled = false; }
  }

  async function renameVoice() {
    const voice = selectedVoice();
    if (!voice) return;
    const name = window.prompt('Neuer Name der Stimme (ohne -1.7B.pt):', voice.name);
    if (!name || name.trim() === voice.name) return;
    try {
      const renamed = await request(`/api/tts/voices/${encodeURIComponent(voice.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      });
      await loadSettings(renamed.id);
      message(`Stimme wurde in „${renamed.name}“ umbenannt.`);
    } catch (error) { message(error.message, true); }
  }

  async function trashVoice() {
    const voice = selectedVoice();
    if (!voice || !window.confirm(`„${voice.name}“ in den Papierkorb des TTS-Servers verschieben?`)) return;
    try {
      await request(`/api/tts/voices/${encodeURIComponent(voice.id)}`, { method: 'DELETE' });
      await loadSettings();
      message(`„${voice.name}“ wurde nach voices/trash verschoben.`);
    } catch (error) { message(error.message, true); }
  }

  function close() {
    ++pollGeneration;
    closeVoiceMenu();
    stopRecording(true);
    revokeRecording();
    if (previewJobId) request(`/api/tts/voices-preview/${encodeURIComponent(previewJobId)}`, { method: 'DELETE' }).catch(() => {});
    previewJobId = null;
    if (dialog.open) dialog.close();
  }

  window.openTtsSettingsDialog = async function openTtsSettingsDialog() {
    if (!dialog.open) dialog.showModal();
    dialog.focus({ preventScroll: true });
    await loadSettings();
    const pending = sessionStorage.getItem('wa-tts-voice-job');
    if (pending) {
      cancelJobButton.hidden = false;
      cancelJobButton.dataset.running = 'true';
      pollVoiceJob(pending, ++pollGeneration);
    }
  };

  select.addEventListener('change', () => { renderVoiceMeta(); renderStoredPreview(); updateButtons(); });
  nameInput.addEventListener('input', updateButtons);
  saveButton.addEventListener('click', saveSelection);
  refreshButton.addEventListener('click', () => loadSettings(select.value));
  previewButton.addEventListener('click', preview);
  renameButton.addEventListener('click', renameVoice);
  trashButton.addEventListener('click', trashVoice);
  recordButton.addEventListener('click', startRecording);
  stopButton.addEventListener('click', () => stopRecording());
  discardButton.addEventListener('click', revokeRecording);
  createButton.addEventListener('click', createVoice);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return message('Die Audiodatei ist größer als 10 MB.', true);
    useRecording(file, file.name);
    message('Audiodatei ist bereit.');
  });
  cancelJobButton.addEventListener('click', async () => {
    const id = sessionStorage.getItem('wa-tts-voice-job');
    if (!id) return;
    try { await request(`/api/tts/voices/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (error) { message(error.message, true); }
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  dialog.addEventListener('close', () => document.getElementById('reindex-btn')?.focus());
  updateButtons();
})();
