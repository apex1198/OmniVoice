import { createIcons, icons } from 'lucide';


const API = window.omniSpeak.apiBase;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  online: false,
  activeView: 'studio',
  projects: [],
  voices: [],
  jobs: [],
  currentProject: null,
  currentJob: null,
  speakerMap: {},
  saveTimer: null,
  jobSocket: null,
  logs: [],
  performanceMode: true,
  performanceRestore: { inference_steps: 32, pitch_semitones: 0, sound_effect: 'none', remove_silence: true },
};

const viewMeta = {
  studio: ['VOICE WORKSPACE', 'Studio'],
  voices: ['VOICE LIBRARY', 'Voices'],
  projects: ['WORKSPACE', 'Projects'],
  history: ['RENDER QUEUE', 'History'],
  runtime: ['LOCAL ENGINE', 'Runtime'],
};

function refreshIcons() {
  createIcons({ icons });
}

function show(element, visible) {
  if (element) element.classList.toggle('hidden', !visible);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.idleHtml ||= button.innerHTML;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  } else {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    if (button.dataset.idleHtml) button.innerHTML = button.dataset.idleHtml;
  }
}

function toast(message, tone = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  item.innerHTML = `<i data-lucide="${tone === 'error' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : 'circle-check'}"></i><span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(item);
  refreshIcons();
  requestAnimationFrame(() => item.classList.add('visible'));
  setTimeout(() => {
    item.classList.remove('visible');
    setTimeout(() => item.remove(), 180);
  }, 3200);
}

function updateScriptHighlights() {
  const editor = $('#script-editor');
  const highlights = $('#script-highlights');
  if (!editor || !highlights) return;
  highlights.innerHTML = `${escapeHtml(editor.value).replace(
    /@\[Speaker\s+([1-4])\]/gi,
    (_match, number) => `<mark class="speaker-token speaker-${number}">@[Speaker ${number}]</mark>`,
  )}\n`;
  highlights.scrollTop = editor.scrollTop;
  highlights.scrollLeft = editor.scrollLeft;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail || message;
    } catch {}
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function setOnline(online) {
  state.online = online;
  $('#status-dot').classList.toggle('online', online);
  $('#status-label').textContent = online ? 'Engine online' : 'Engine offline';
  $('#runtime-engine').textContent = online ? 'Online · Apple MPS' : 'Offline';
}

function setView(view) {
  state.activeView = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  const [eyebrow, title] = viewMeta[view];
  $('#view-eyebrow').textContent = eyebrow;
  $('#view-title').textContent = title;
  $$('.content-view').forEach((section) => show(section, section.id === `${view}-view`));
  show($('#setup-view'), false);
  show($('#project-picker-wrap'), view === 'studio');
  show($('#save-status'), view === 'studio');
  if (view === 'history') loadJobs();
  if (view === 'voices') loadVoices();
  if (view === 'projects') renderProjects();
  refreshIcons();
}

function showSetup() {
  $$('.content-view').forEach((section) => show(section, false));
  show($('#setup-view'), true);
  show($('#project-picker-wrap'), false);
  show($('#save-status'), false);
}

function updateSetupProgress({ step, progress, message, detail }) {
  show($('#progress-wrap'), true);
  $('#progress-bar').style.width = `${Math.max(2, progress)}%`;
  $('#progress-message').textContent = message;
  $('#progress-detail').textContent = detail;
  $('#setup-copy').textContent = 'Giữ cửa sổ này mở trong khi setup hoàn tất.';
  const order = ['python', 'runtime', 'package', 'models', 'engine'];
  const current = order.indexOf(step);
  $$('#setup-steps [data-step]').forEach((item) => {
    const index = order.indexOf(item.dataset.step);
    item.classList.toggle('active', index === current);
    item.classList.toggle('done', index < current || progress === 100);
  });
}

async function runSetup() {
  setButtonBusy($('#magic-setup'), true, 'Setting up…');
  show($('#error-message'), false);
  const result = await window.omniSpeak.runSetup();
  setButtonBusy($('#magic-setup'), false);
  if (!result.ok) {
    $('#error-message').textContent = result.error;
    show($('#error-message'), true);
    return;
  }
  setOnline(true);
  await loadWorkspace();
  setView('studio');
}

async function startEngine() {
  setButtonBusy($('#start-engine'), true, 'Starting…');
  const result = await window.omniSpeak.startService();
  setButtonBusy($('#start-engine'), false);
  if (!result.ok) {
    $('#error-message').textContent = result.error;
    show($('#error-message'), true);
    return;
  }
  setOnline(true);
  show($('#start-engine'), false);
  await loadWorkspace();
  setView('studio');
}

function projectSettings() {
  const performanceMode = $('#performance-mode').checked;
  const automaticPacing = $('#speaker-pause').value === 'auto';
  return {
    speaker_map: state.speakerMap,
    language: $('#language').value,
    speed: Number($('#speed').value),
    pitch_semitones: performanceMode ? 0 : Number($('#pitch').value),
    guidance_scale: Number($('#guidance').value),
    inference_steps: performanceMode ? 8 : Number($('#inference-steps').value),
    speaker_pause_ms: automaticPacing ? 'auto' : Number($('#speaker-pause').value),
    natural_pacing: automaticPacing,
    pronunciation_dictionary: parseDictionary($('#pronunciation-dictionary').value),
    sound_effect: performanceMode ? 'none' : $('#sound-effect').value,
    normalize_text: $('#normalize-text').checked,
    remove_silence: performanceMode ? false : $('#remove-silence').checked,
    performance_mode: performanceMode,
    performance_restore: state.performanceRestore,
  };
}

function applySettings(settings = {}) {
  state.speakerMap = { ...(settings.speaker_map || {}) };
  const performanceMode = settings.performance_mode !== false;
  state.performanceRestore = {
    inference_steps: settings.performance_restore?.inference_steps ?? settings.inference_steps ?? 32,
    pitch_semitones: settings.performance_restore?.pitch_semitones ?? settings.pitch_semitones ?? 0,
    sound_effect: settings.performance_restore?.sound_effect ?? settings.sound_effect ?? 'none',
    remove_silence: settings.performance_restore?.remove_silence ?? (settings.remove_silence !== false),
  };
  const pauseSetting = settings.natural_pacing == null
    ? 'auto'
    : (settings.natural_pacing ? 'auto' : (settings.speaker_pause_ms ?? 700));
  const values = {
    language: settings.language || 'auto', speed: settings.speed ?? 1,
    pitch: performanceMode ? 0 : (settings.pitch_semitones ?? 0), guidance: settings.guidance_scale ?? 2,
    'inference-steps': performanceMode ? 8 : (settings.inference_steps ?? 32),
    'speaker-pause': pauseSetting,
    'sound-effect': performanceMode ? 'none' : (settings.sound_effect || 'none'),
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = $(`#${id}`);
    if (!element) return;
    if (element.tagName === 'SELECT' && ![...element.options].some((option) => option.value === String(value))) {
      element.value = element.querySelector('option[selected]')?.value || element.options[0]?.value || '';
      return;
    }
    element.value = value;
  });
  $('#normalize-text').checked = Boolean(settings.normalize_text);
  $('#remove-silence').checked = performanceMode ? false : settings.remove_silence !== false;
  $('#pronunciation-dictionary').value = (settings.pronunciation_dictionary || []).map((entry) => `${entry.source} = ${entry.target}`).join('\n');
  setPerformanceMode(performanceMode, false);
}

function setPerformanceMode(enabled, capture = true) {
  if (enabled && capture) {
    state.performanceRestore = {
      inference_steps: Number($('#inference-steps').value) || 32,
      pitch_semitones: Number($('#pitch').value),
      sound_effect: $('#sound-effect').value,
      remove_silence: $('#remove-silence').checked,
    };
  }
  if (!enabled && capture) {
    $('#inference-steps').value = String(state.performanceRestore.inference_steps || 32);
    $('#pitch').value = String(state.performanceRestore.pitch_semitones ?? 0);
    $('#sound-effect').value = state.performanceRestore.sound_effect || 'none';
    $('#remove-silence').checked = state.performanceRestore.remove_silence !== false;
  }
  if (enabled) {
    $('#inference-steps').value = '8';
    $('#pitch').value = '0';
    $('#sound-effect').value = 'none';
    $('#remove-silence').checked = false;
  }
  state.performanceMode = enabled;
  $('#performance-mode').checked = enabled;
  ['inference-steps', 'pitch', 'sound-effect', 'remove-silence'].forEach((id) => { $(`#${id}`).disabled = enabled; });
  updateRangeLabels();
}

function parseDictionary(value) {
  return value.split('\n').map((line) => {
    const [source, ...target] = line.split('=');
    return { source: source?.trim(), target: target.join('=').trim() };
  }).filter((entry) => entry.source && entry.target);
}

function scheduleSave() {
  if (!state.currentProject) return;
  $('#save-status').textContent = 'Đang lưu…';
  $('#save-status').dataset.state = 'saving';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentProject, 700);
}

async function saveCurrentProject() {
  if (!state.currentProject) return;
  try {
    const project = await api('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.currentProject.id, name: state.currentProject.name, script: $('#script-editor').value, settings: projectSettings() }),
    });
    state.currentProject = project;
    $('#save-status').textContent = 'Đã lưu';
    $('#save-status').dataset.state = 'saved';
  } catch (error) {
    $('#save-status').textContent = 'Lỗi lưu';
    $('#save-status').dataset.state = 'error';
  }
}

async function loadWorkspace() {
  const [projects, voices, jobs] = await Promise.all([api('/api/projects'), api('/api/voices'), api('/api/jobs')]);
  state.projects = projects;
  state.voices = voices;
  state.jobs = jobs;
  state.currentProject = projects.find((project) => project.id === state.currentProject?.id) || projects[0];
  renderProjectPicker();
  loadProjectIntoStudio(state.currentProject);
  renderVoices();
  renderProjects();
  renderJobs();
  updateQueueCount();
}

function renderProjectPicker() {
  $('#project-picker').innerHTML = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
  if (state.currentProject) $('#project-picker').value = state.currentProject.id;
}

function loadProjectIntoStudio(project) {
  if (!project) return;
  state.currentProject = project;
  $('#project-picker').value = project.id;
  $('#script-editor').value = project.script || '';
  updateScriptHighlights();
  applySettings(project.settings || {});
  renderSpeakerList();
  updateCharCount();
  const latest = state.jobs.find((job) => job.project_id === project.id && job.status === 'completed');
  if (latest) selectOutput(latest.id);
  else resetPlayer();
}

async function loadVoices() {
  $('#refresh-voices').classList.add('is-spinning');
  try {
    state.voices = await api('/api/voices');
    renderVoices();
    renderSpeakerList();
  } finally {
    $('#refresh-voices').classList.remove('is-spinning');
  }
}

function renderSpeakerList() {
  const options = state.voices.map((voice) => `<option value="${voice.id}">${escapeHtml(voice.name)}</option>`).join('');
  $('#speaker-list').innerHTML = [1, 2, 3, 4].map((number) => {
    const speaker = `Speaker ${number}`;
    const selected = state.speakerMap[speaker] || state.voices[(number - 1) % Math.max(1, state.voices.length)]?.id || '';
    state.speakerMap[speaker] = selected;
    return `<div class="speaker-row"><span class="speaker-avatar s${number}">S${number}</span><label><b>${speaker}</b><select data-speaker-select="${speaker}">${options}</select></label><button class="tag-copy" data-insert-speaker="${speaker}" title="Chèn prefix"><i data-lucide="text-cursor-input"></i></button></div>`;
  }).join('');
  $$('[data-speaker-select]').forEach((select) => {
    select.value = state.speakerMap[select.dataset.speakerSelect] || '';
    select.addEventListener('change', () => { state.speakerMap[select.dataset.speakerSelect] = select.value; scheduleSave(); });
  });
  $$('[data-insert-speaker]').forEach((button) => button.addEventListener('click', () => assignSpeaker(Number(button.dataset.insertSpeaker.slice(-1)))));
  refreshIcons();
}

function voiceKindLabel(kind) {
  return kind === 'clone' ? 'Cloned' : kind === 'design' ? 'Designed' : 'Preset';
}

function renderVoices() {
  $('#voice-count').textContent = `${state.voices.length} voices`;
  $('#voice-grid').innerHTML = state.voices.map((voice, index) => `<article class="voice-item"><div class="voice-avatar s${(index % 4) + 1}"><i data-lucide="audio-waveform"></i></div><div class="voice-info"><strong>${escapeHtml(voice.name)}</strong><span>${voiceKindLabel(voice.kind)}${voice.transcript ? ` · ${escapeHtml(voice.transcript.slice(0, 42))}` : ''}</span></div><div class="voice-actions">${voice.source_audio_path ? `<button class="icon-button" data-preview-voice="${voice.id}" title="Nghe preview"><i data-lucide="play"></i></button>` : ''}${voice.metadata?.builtin ? '' : `<button class="icon-button danger" data-delete-voice="${voice.id}" title="Xoá voice"><i data-lucide="trash-2"></i></button>`}</div></article>`).join('');
  $$('[data-preview-voice]').forEach((button) => button.addEventListener('click', () => {
    const player = new Audio(`${API}/api/voices/${button.dataset.previewVoice}/audio`);
    player.play();
  }));
  $$('[data-delete-voice]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Xoá voice này khỏi thư viện?')) return;
    await api(`/api/voices/${button.dataset.deleteVoice}`, { method: 'DELETE' });
    await loadVoices();
  }));
  refreshIcons();
}

function renderProjects() {
  $('#project-list').innerHTML = state.projects.map((project) => {
    const count = state.jobs.filter((job) => job.project_id === project.id).length;
    return `<button class="project-item" data-project-id="${project.id}"><span class="project-icon"><i data-lucide="file-audio"></i></span><span><strong>${escapeHtml(project.name)}</strong><small>${count} renders · Updated ${new Date(project.updated_at).toLocaleDateString()}</small></span><i data-lucide="chevron-right"></i></button>`;
  }).join('');
  $$('[data-project-id]').forEach((button) => button.addEventListener('click', () => {
    loadProjectIntoStudio(state.projects.find((project) => project.id === button.dataset.projectId));
    setView('studio');
  }));
  refreshIcons();
}

async function loadJobs() {
  state.jobs = await api('/api/jobs');
  renderJobs();
  updateQueueCount();
}

function statusBadge(status) {
  return `<span class="status-badge ${status}">${status.replace('_', ' ')}</span>`;
}

function renderJobs() {
  $('#history-table').innerHTML = state.jobs.length ? state.jobs.map((job) => `<div class="history-row"><button class="history-main" data-open-job="${job.id}"><span>${statusBadge(job.status)}</span><strong>${escapeHtml(job.text.slice(0, 90))}</strong><small>${new Date(job.created_at).toLocaleString()} · ${Math.round(job.progress)}%</small></button><div class="history-actions">${['pending', 'running'].includes(job.status) ? `<button data-cancel-history="${job.id}" title="Huỷ"><i data-lucide="square"></i></button>` : ''}${['failed', 'cancelled'].includes(job.status) ? `<button data-retry-job="${job.id}" title="Thử lại"><i data-lucide="rotate-ccw"></i></button>` : ''}${job.status === 'completed' ? `<a href="${API}/api/jobs/${job.id}/audio" download title="Tải WAV"><i data-lucide="download"></i></a>` : ''}</div></div>`).join('') : '<div class="empty-state">Chưa có render.</div>';
  $('#recent-jobs').innerHTML = state.jobs.filter((job) => job.status === 'completed').slice(0, 3).map((job) => `<button data-recent-job="${job.id}"><span>${escapeHtml(job.text.slice(0, 44))}</span><small>${formatDuration(job.duration_ms)}</small></button>`).join('') || '<span class="muted">No output yet</span>';
  $$('[data-open-job], [data-recent-job]').forEach((button) => button.addEventListener('click', () => { selectOutput(button.dataset.openJob || button.dataset.recentJob); setView('studio'); }));
  $$('[data-cancel-history]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/jobs/${button.dataset.cancelHistory}/cancel`, { method: 'POST' }); await loadJobs(); }));
  $$('[data-retry-job]').forEach((button) => button.addEventListener('click', async () => { const job = await api(`/api/jobs/${button.dataset.retryJob}/retry`, { method: 'POST' }); watchJob(job.id); setView('studio'); }));
  refreshIcons();
}

function updateQueueCount() {
  const count = state.jobs.filter((job) => ['pending', 'running'].includes(job.status)).length;
  $('#queue-count').textContent = count;
  $('#queue-count').classList.toggle('active', count > 0);
}

function formatDuration(ms) {
  if (!ms) return '—';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderCurrentJob(job) {
  state.currentJob = job;
  const active = ['pending', 'running', 'cancel_requested'].includes(job.status);
  show($('#job-progress'), active);
  show($('#cancel-job'), active);
  $('#job-status').textContent = job.status === 'pending' ? 'Queued' : job.status === 'running' ? 'Generating' : job.status;
  $('#job-percent').textContent = `${Math.round(job.progress)}%`;
  $('#job-progress-bar').style.width = `${job.progress}%`;
  $('#queue-label').textContent = active ? job.status : job.status === 'failed' ? 'Failed' : 'Idle';
  $('#queue-label').className = job.status === 'failed' ? 'error' : active ? 'working' : '';
  setButtonBusy($('#generate-button'), active, job.status === 'pending' ? 'Queued…' : 'Generating…');
  if (job.status === 'completed') renderPlayer(job);
  if (job.status === 'failed') {
    show($('#job-progress'), true);
    $('#job-status').textContent = job.error || 'Generation failed';
  }
}

function renderPlayer(job) {
  show($('#player-empty'), false);
  show($('#player-panel'), true);
  const audioUrl = `${API}/api/jobs/${job.id}/audio?t=${Date.now()}`;
  $('#audio-player').src = audioUrl;
  $('#download-wav').href = `${API}/api/jobs/${job.id}/audio?format=wav`;
  $('#download-flac').href = `${API}/api/jobs/${job.id}/audio?format=flac`;
  $('#output-duration').textContent = formatDuration(job.duration_ms);
  $('#output-segments').textContent = job.segments?.length || '—';
  $('#timeline-items').innerHTML = (job.segments || []).map((segment) => `<button data-seek-ms="${segment.start_ms || 0}"><span class="speaker-color s${segment.speaker.slice(-1)}"></span><span><b>${escapeHtml(segment.speaker)}</b><small>${escapeHtml(segment.text.slice(0, 58))}</small></span><time>${formatDuration(segment.start_ms)}–${formatDuration(segment.end_ms)}</time></button>`).join('');
  $$('[data-seek-ms]').forEach((button) => button.addEventListener('click', () => { $('#audio-player').currentTime = Number(button.dataset.seekMs) / 1000; $('#audio-player').play(); }));
}

function resetPlayer() {
  show($('#player-empty'), true);
  show($('#player-panel'), false);
  $('#timeline-items').innerHTML = '';
}

async function selectOutput(jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  renderCurrentJob(job);
}

function watchJob(jobId) {
  state.jobSocket?.close();
  const socket = new WebSocket(`ws://127.0.0.1:8001/api/jobs/${jobId}/events`);
  state.jobSocket = socket;
  socket.onmessage = async (event) => {
    const job = JSON.parse(event.data);
    renderCurrentJob(job);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) await loadJobs();
  };
  socket.onerror = () => setTimeout(() => pollJob(jobId), 1000);
}

async function pollJob(jobId) {
  try {
    const job = await api(`/api/jobs/${jobId}`);
    renderCurrentJob(job);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) setTimeout(() => pollJob(jobId), 1000);
    else await loadJobs();
  } catch {}
}

async function createSpeechJob() {
  const text = $('#script-editor').value.trim();
  if (!text) return flashError('Nhập nội dung trước khi generate.');
  await saveCurrentProject();
  setButtonBusy($('#generate-button'), true, 'Queueing…');
  try {
    const job = await api('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: state.currentProject.id, text, speaker_map: state.speakerMap, config: projectSettings() }),
    });
    state.jobs.unshift(job);
    renderCurrentJob(job);
    updateQueueCount();
    watchJob(job.id);
  } catch (error) {
    setButtonBusy($('#generate-button'), false);
    flashError(error.message);
  }
}

function flashError(message) {
  $('#queue-label').textContent = message;
  $('#queue-label').classList.add('error');
  toast(message, 'error');
  setTimeout(() => { $('#queue-label').classList.remove('error'); $('#queue-label').textContent = 'Idle'; }, 4000);
}

function insertText(text) {
  const editor = $('#script-editor');
  const start = editor.selectionStart;
  const spacer = start > 0 && !editor.value.slice(0, start).endsWith('\n') ? '\n\n' : '';
  editor.setRangeText(`${spacer}${text}`, start, editor.selectionEnd, 'end');
  editor.focus();
  updateCharCount();
  updateScriptHighlights();
  scheduleSave();
}

function speakerAtPosition(text, position) {
  const pattern = /@\[Speaker\s+([1-4])\]/gi;
  let speaker = 1;
  for (const match of text.slice(0, position).matchAll(pattern)) speaker = Number(match[1]);
  return speaker;
}

function assignSpeaker(number) {
  const editor = $('#script-editor');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  if (start === end) {
    insertText(`@[Speaker ${number}] `);
    return;
  }

  const source = editor.value;
  const selected = source.slice(start, end).replace(/@\[Speaker\s+[1-4]\]\s*/gi, '');
  const restoreSpeaker = speakerAtPosition(source, end);
  const suffix = source.slice(end);
  const restore = suffix && !/^\s*@\[Speaker\s+[1-4]\]/i.test(suffix)
    ? ` @[Speaker ${restoreSpeaker}] `
    : '';
  const replacement = `@[Speaker ${number}] ${selected.trim()}${restore}`;
  editor.setRangeText(replacement, start, end, 'select');
  editor.focus();
  updateCharCount();
  updateScriptHighlights();
  scheduleSave();
  toast(`Đã gán Speaker ${number}.`);
}

function updateCharCount() {
  $('#char-count').textContent = `${$('#script-editor').value.length.toLocaleString()} ký tự`;
}

function updateRangeLabels() {
  $('#speed-value').textContent = `${Number($('#speed').value).toFixed(2)}×`;
  $('#pitch-value').textContent = `${Number($('#pitch').value)} st`;
  $('#guidance-value').textContent = Number($('#guidance').value).toFixed(1);
  $('#quality-label').textContent = state.performanceMode ? 'M1 Fast' : ($('#inference-steps').selectedOptions[0]?.text.split(' · ')[0] || 'Balanced');
}

async function analyzeCloneAudio() {
  const file = $('#clone-audio').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  $('#audio-analysis').className = 'audio-analysis is-loading';
  $('#audio-analysis').innerHTML = '<span class="button-spinner"></span><span>Đang phân tích audio…</span>';
  try {
    const analysis = await api('/api/voices/analyze', { method: 'POST', body: form });
    $('#audio-analysis').className = `audio-analysis ${analysis.warnings.length ? 'warning' : 'success'}`;
    $('#audio-analysis').innerHTML = `<b>${analysis.duration_seconds}s · ${analysis.warnings.length ? 'Needs attention' : 'Reference ready'}</b><span>SNR ${analysis.snr_db} dB · silence ${Math.round(analysis.silence_ratio * 100)}%</span>${analysis.warnings.map((warning) => `<em>${escapeHtml(warning)}</em>`).join('')}`;
  } catch (error) {
    $('#audio-analysis').className = 'audio-analysis error';
    $('#audio-analysis').textContent = error.message;
  }
}

async function submitClone(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submitButton = event.submitter || formElement.querySelector('[type="submit"]');
  setButtonBusy(submitButton, true, 'Creating clone…');
  const form = new FormData(formElement);
  $('#voice-form-status').className = 'form-status loading';
  $('#voice-form-status').textContent = 'Đang tạo clone prompt…';
  try {
    await api('/api/voices/clone', { method: 'POST', body: form });
    formElement.reset();
    $('#audio-analysis').className = 'audio-analysis';
    $('#audio-analysis').textContent = 'Chọn WAV, MP3 hoặc M4A';
    $('#voice-form-status').className = 'form-status success';
    $('#voice-form-status').textContent = 'Voice clone đã lưu.';
    toast('Voice clone đã sẵn sàng với Fidelity v2.');
    await loadVoices();
  } catch (error) { $('#voice-form-status').className = 'form-status error'; $('#voice-form-status').textContent = error.message; toast(error.message, 'error'); }
  finally { setButtonBusy(submitButton, false); }
}

async function submitDesign(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submitButton = event.submitter || formElement.querySelector('[type="submit"]');
  setButtonBusy(submitButton, true, 'Designing voice…');
  const values = Object.fromEntries(new FormData(formElement));
  const description = [values.gender, values.age, values.pitch, values.accent, values.style].filter(Boolean).join(', ');
  const payload = { name: values.name, description, preview_text: values.preview_text, performance_mode: state.performanceMode };
  $('#voice-form-status').className = 'form-status loading';
  $('#voice-form-status').textContent = 'Đang design và lưu voice…';
  try {
    await api('/api/voices/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    formElement.reset();
    $('#voice-form-status').className = 'form-status success';
    $('#voice-form-status').textContent = 'Designed voice đã lưu.';
    toast('Designed voice đã lưu.');
    await loadVoices();
  } catch (error) { $('#voice-form-status').className = 'form-status error'; $('#voice-form-status').textContent = error.message; toast(error.message, 'error'); }
  finally { setButtonBusy(submitButton, false); }
}

function bindEvents() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => state.online ? setView(item.dataset.view) : showSetup()));
  $('#magic-setup').addEventListener('click', runSetup);
  $('#start-engine').addEventListener('click', startEngine);
  $('#show-log').addEventListener('click', () => window.omniSpeak.showLog());
  $('#refresh-voices').addEventListener('click', loadVoices);
  $('#refresh-history').addEventListener('click', loadJobs);
  $('#open-history').addEventListener('click', () => setView('history'));
  $('#generate-button').addEventListener('click', createSpeechJob);
  $('#cancel-job').addEventListener('click', async () => { if (state.currentJob) await api(`/api/jobs/${state.currentJob.id}/cancel`, { method: 'POST' }); });
  $('#project-picker').addEventListener('change', () => loadProjectIntoStudio(state.projects.find((project) => project.id === $('#project-picker').value)));
  $('#script-editor').addEventListener('input', () => { updateCharCount(); updateScriptHighlights(); scheduleSave(); });
  $('#script-editor').addEventListener('scroll', updateScriptHighlights);
  $('#script-editor').addEventListener('keydown', (event) => {
    if (event.metaKey && !event.altKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      assignSpeaker(Number(event.key));
    }
  });
  $$('[data-speaker-tag]').forEach((button) => button.addEventListener('click', () => assignSpeaker(Number(button.dataset.speakerTag.slice(-1)))));
  $$('[data-sound-tag]').forEach((button) => button.addEventListener('click', () => insertText(button.dataset.soundTag)));
  ['language', 'speed', 'pitch', 'guidance', 'inference-steps', 'speaker-pause', 'sound-effect', 'normalize-text', 'remove-silence', 'pronunciation-dictionary'].forEach((id) => $(`#${id}`).addEventListener('input', () => { updateRangeLabels(); scheduleSave(); }));
  $('#performance-mode').addEventListener('change', () => { setPerformanceMode($('#performance-mode').checked); scheduleSave(); });
  $('#clone-audio').addEventListener('change', analyzeCloneAudio);
  $('#clone-form').addEventListener('submit', submitClone);
  $('#design-form').addEventListener('submit', submitDesign);
  $$('[data-voice-mode]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-voice-mode]').forEach((item) => item.classList.toggle('active', item === button));
    show($('#clone-form'), button.dataset.voiceMode === 'clone');
    show($('#design-form'), button.dataset.voiceMode === 'design');
  }));
  $('#new-project').addEventListener('click', async () => {
    const name = prompt('Tên project mới:', `Project ${state.projects.length + 1}`);
    if (!name) return;
    const project = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    state.projects.unshift(project);
    renderProjectPicker(); renderProjects(); loadProjectIntoStudio(project); setView('studio');
  });
}

window.omniSpeak.onSetupProgress(updateSetupProgress);
window.omniSpeak.onSetupError(({ message }) => { $('#error-message').textContent = message; show($('#error-message'), true); });
window.omniSpeak.onRuntimeLog((line) => {
  state.logs.push(line); state.logs = state.logs.slice(-100);
  $('#runtime-log').textContent = state.logs.join('\n'); $('#runtime-log').scrollTop = $('#runtime-log').scrollHeight;
});

async function initialize() {
  refreshIcons();
  bindEvents();
  updateScriptHighlights();
  const status = await window.omniSpeak.getStatus();
  state.logs = status.recentLog || [];
  $('#runtime-log').textContent = state.logs.join('\n') || 'Chưa có log.';
  setOnline(status.online);
  if (status.online) {
    await loadWorkspace();
    setView('studio');
  } else if (status.installed) {
    showSetup();
    updateSetupProgress({ step: 'engine', progress: 82, message: 'Đang khởi động engine', detail: 'Nạp model vào Apple MPS' });
    await startEngine();
  } else {
    showSetup();
  }
}

initialize();
