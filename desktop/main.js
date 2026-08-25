const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SERVICE_URL = 'http://127.0.0.1:8001';
const SETUP_STEPS = ['runtime', 'package', 'models', 'engine'];

let mainWindow;
let setupPromise;
let serviceProcess;
let recentLog = [];

function appPaths() {
  const support = app.getPath('userData');
  const runtime = path.join(support, 'runtime');
  return {
    support,
    runtime,
    venv: path.join(runtime, 'venv'),
    state: path.join(runtime, 'state.json'),
    logs: path.join(support, 'logs'),
    serviceLog: path.join(support, 'logs', 'service.log'),
    data: path.join(support, 'data'),
    backend: app.isPackaged
      ? path.join(process.resourcesPath, 'omni-speak-backend', 'server.py')
      : path.join(__dirname, 'backend', 'server.py'),
    source: app.isPackaged
      ? path.join(process.resourcesPath, 'omnivoice-source')
      : path.resolve(__dirname, '..'),
  };
}

function executable(venv, command) {
  return path.join(venv, 'bin', command);
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushLog(line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  recentLog.push(clean);
  recentLog = recentLog.slice(-120);
  emit('runtime-log', clean);
}

function emitSetup(step, progress, message, detail = '') {
  emit('setup-progress', { step, progress, message, detail, steps: SETUP_STEPS });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(appPaths().state, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  const paths = appPaths();
  fs.mkdirSync(paths.runtime, { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify({ ...readState(), ...next }, null, 2));
}

function probeService(timeout = 2200) {
  return new Promise((resolve) => {
    const request = http.get(`${SERVICE_URL}/api/health`, { timeout }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 260000) body += chunk;
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(response.statusCode === 200 && health.app === 'Omni Speak' && health.ready === true);
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    pushLog(`$ ${path.basename(command)} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const consume = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-12000);
      text.split(/[\r\n]+/).forEach(pushLog);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else reject(new Error(`${path.basename(command)} exited with code ${code}\n${tail}`));
    });
  });
}

function commandPath(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function pythonVersion(candidate) {
  if (!candidate) return null;
  const result = spawnSync(candidate, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  return major === 3 && minor >= 10 && minor <= 13 ? { path: candidate, version } : null;
}

async function findPython() {
  const candidates = [
    process.env.OMNI_SPEAK_PYTHON,
    '/Users/alexcrearive/.local/bin/python3.12',
    '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.12',
    commandPath('python3.12'),
    commandPath('python3.11'),
    commandPath('python3.10'),
    commandPath('python3'),
  ];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const match = pythonVersion(candidate);
    if (match) return match;
  }

  const uv = findUv();
  if (uv) {
    emitSetup('runtime', 8, 'Đang tải Python 3.12', 'Sử dụng uv runtime manager');
    await runProcess(uv, ['python', 'install', '3.12']);
    const found = spawnSync(uv, ['python', 'find', '3.12'], { encoding: 'utf8' });
    const match = pythonVersion(found.stdout.trim());
    if (match) return match;
  }
  throw new Error('Cần Python 3.10-3.13. Hãy cài Python 3.12 rồi chạy Magic Setup lại.');
}

function findUv() {
  const candidates = [
    process.env.OMNI_SPEAK_UV,
    '/Users/alexcrearive/.local/bin/uv',
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    commandPath('uv'),
  ];
  return [...new Set(candidates.filter(Boolean))].find((candidate) => fs.existsSync(candidate)) || null;
}

async function installRuntime(python) {
  const paths = appPaths();
  const venvPython = executable(paths.venv, 'python');
  const uv = findUv();
  const coreDependencies = [
    'torch==2.8.0',
    'torchaudio==2.8.0',
    'transformers==5.3.0',
    'numpy==2.4.3',
    'fastapi',
    'uvicorn',
    'websockets',
    'python-multipart',
  ];
  fs.mkdirSync(paths.runtime, { recursive: true });

  if (!fs.existsSync(venvPython)) {
    emitSetup('runtime', 14, 'Đang tạo runtime riêng', `Python ${python.version}`);
    if (uv) await runProcess(uv, ['venv', '--python', python.path, paths.venv]);
    else await runProcess(python.path, ['-m', 'venv', paths.venv]);
  }

  emitSetup('package', 28, 'Đang cài OmniVoice', 'PyTorch, FastAPI và audio runtime');
  if (uv) {
    await runProcess(uv, [
      'pip',
      'install',
      '--python',
      venvPython,
      ...coreDependencies,
      paths.source,
    ]);
  } else {
    await runProcess(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    await runProcess(venvPython, [
      '-m',
      'pip',
      'install',
      ...coreDependencies,
      paths.source,
    ]);
  }
  return venvPython;
}

async function downloadModels(venvPython) {
  emitSetup('models', 52, 'Đang tải model giọng nói', 'OmniVoice và Whisper ASR');
  const script = [
    'from huggingface_hub import snapshot_download',
    'print("MODEL OmniVoice")',
    'snapshot_download("k2-fsa/OmniVoice")',
    'print("MODEL Whisper")',
    'snapshot_download("openai/whisper-large-v3-turbo")',
    'print("MODEL READY")',
  ].join('\n');
  await runProcess(venvPython, ['-c', script]);
}

async function startService() {
  if (await probeService()) return true;
  const paths = appPaths();
  const python = executable(paths.venv, 'python');
  if (!fs.existsSync(python) || !fs.existsSync(paths.backend)) return false;

  const previousPid = Number(readState().servicePid);
  if (previousPid > 1) {
    const command = spawnSync('/bin/ps', ['-p', String(previousPid), '-o', 'command='], { encoding: 'utf8' }).stdout;
    if (command.includes('omnivoice-demo') || command.includes('omni-speak-backend')) {
      try {
        process.kill(previousPid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 900));
      } catch {}
    }
  }

  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.data, { recursive: true });
  const logFd = fs.openSync(paths.serviceLog, 'a');
  serviceProcess = spawn(python, [
    paths.backend,
    '--data-dir',
    paths.data,
    '--host',
    '127.0.0.1',
    '--port',
    '8001',
  ], {
    cwd: paths.runtime,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  serviceProcess.unref();
  writeState({ servicePid: serviceProcess.pid, lastStartedAt: new Date().toISOString() });
  return true;
}

async function waitForService(maxWaitMs = 300000) {
  const startedAt = Date.now();
  let lastSize = 0;
  while (Date.now() - startedAt < maxWaitMs) {
    if (await probeService()) return true;
    const logPath = appPaths().serviceLog;
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      if (content.length > lastSize) {
        content.slice(lastSize).split(/[\r\n]+/).forEach(pushLog);
        lastSize = content.length;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Engine không sẵn sàng sau 5 phút. Xem log: ${appPaths().serviceLog}`);
}

async function runSetup() {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      emitSetup('runtime', 3, 'Đang kiểm tra máy', 'Tìm Python và Apple GPU');
      const python = await findPython();
      const venvPython = await installRuntime(python);
      await downloadModels(venvPython);
      emitSetup('engine', 78, 'Đang khởi động engine', 'Nạp model vào Apple MPS');
      await startService();
      await waitForService();
      writeState({ installed: true, python: python.path, installedAt: new Date().toISOString() });
      emitSetup('engine', 100, 'Omni Speak đã sẵn sàng', 'Engine đang chạy cục bộ');
      return { ok: true, url: SERVICE_URL };
    } catch (error) {
      pushLog(error.stack || error.message);
      emit('setup-error', { message: error.message, logPath: appPaths().serviceLog });
      return { ok: false, error: error.message };
    } finally {
      setupPromise = null;
    }
  })();
  return setupPromise;
}

async function currentStatus() {
  const paths = appPaths();
  const online = await probeService();
  const installed = fs.existsSync(executable(paths.venv, 'python')) && fs.existsSync(paths.backend);
  return {
    online,
    installed,
    state: readState(),
    serviceUrl: SERVICE_URL,
    dataPath: paths.data,
    logPath: paths.serviceLog,
    recentLog,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'Omni Speak',
    backgroundColor: '#171916',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('status:get', currentStatus);
ipcMain.handle('setup:run', runSetup);
ipcMain.handle('service:start', async () => {
  emitSetup('engine', 84, 'Đang khởi động engine', 'Nạp model cục bộ');
  const started = await startService();
  if (!started) return { ok: false, error: 'Runtime chưa được cài đặt.' };
  try {
    await waitForService();
    return { ok: true, url: SERVICE_URL };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('external:open', (_event, url) => {
  if (url.startsWith(SERVICE_URL)) shell.openExternal(url);
});
ipcMain.handle('log:show', () => shell.showItemInFolder(appPaths().serviceLog));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
