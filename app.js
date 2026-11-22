import { AlarmTimer, estimateLevel } from './level.mjs';
import { connectPairing, newPairing } from './remote.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video');
const preview = $('preview');
const limit = $('limit');
const sensitivity = $('sensitivity');
const camera = $('camera');
const alarm = new AlarmTimer();
const canvas = document.createElement('canvas');
canvas.width = 48;
canvas.height = 120;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const storageKey = 'monitor-visual:settings:v1:' + new URL('./', document.baseURI).pathname;
let stream, region, reference, drag, wakeLock, audio, tone, testTimeout, sampler, installPrompt;
let cameraRequest = 0;
let opening = false;
let recent = [];
let lastVideoTime = null;
let pairing, heartbeat;
let pairingGeneration = 0;
let remoteLevel = null;
let remoteAlarm = false;

try {
  const settings = JSON.parse(localStorage.getItem(storageKey)) ?? {};
  for (const input of [limit, sensitivity]) {
    const value = settings[input.id];
    if (Number.isInteger(value) && value >= +input.min && value <= +input.max) input.value = value;
  }
} catch {
  // O monitoramento continua disponível com os valores padrão.
}

function updateSettings() {
  $('limit-value').value = limit.value + '%';
  $('sensitivity-value').value = sensitivity.value;
}
updateSettings();
for (const input of [limit, sensitivity]) {
  input.addEventListener('input', () => {
    updateSettings();
    if (input === sensitivity) recent = [];
    resetAlarm();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ limit: +limit.value, sensitivity: +sensitivity.value }));
    } catch {
      // As configurações valem para esta sessão.
    }
  });
}

function status(id, message) {
  if ($(id).textContent !== message) $(id).textContent = message;
}

async function unlockAudio() {
  try {
    audio ??= new AudioContext();
    await audio.resume();
    return audio.state === 'running';
  } catch {
    return false;
  }
}

function stopSound() {
  clearTimeout(testTimeout);
  testTimeout = undefined;
  if (tone) {
    tone.stop();
    tone.disconnect();
    tone = null;
  }
  $('silence').disabled = true;
}

function sound() {
  if (audio?.state !== 'running') return false;
  stopSound();
  tone = audio.createOscillator();
  tone.frequency.value = 740;
  const volume = audio.createGain();
  volume.gain.value = 0.16;
  tone.connect(volume).connect(audio.destination);
  tone.addEventListener('ended', () => volume.disconnect(), { once: true });
  tone.start();
  $('silence').disabled = false;
  return true;
}

$('test').addEventListener('click', async () => {
  const ready = await unlockAudio();
  if (!ready) {
    status('alarm-status', 'Som indisponível neste navegador.');
    return;
  }
  if (alarm.since !== null && performance.now() - alarm.since >= 30000 && !alarm.silenced) {
    sound();
    return;
  }
  if (sound()) {
    status('alarm-status', 'Teste sonoro de 2 segundos.');
    testTimeout = setTimeout(() => {
      testTimeout = undefined;
      stopSound();
      status('alarm-status', 'Alarme local após 30 s acima do limite.');
    }, 2000);
  }
});

$('silence').addEventListener('click', () => {
  if (alarm.since !== null && performance.now() - alarm.since >= 30000) alarm.silenced = true;
  stopSound();
  status('alarm-status', 'Som silenciado.');
});

function resetAlarm() {
  alarm.reset();
  remoteAlarm = false;
  stopSound();
  status('alarm-status', 'Alarme local após 30 s acima do limite.');
}

function showLevel(level) {
  remoteLevel = level;
  $('level').value = level === null ? '—' : level + '%';
  $('meter').value = level ?? 0;
  $('line').hidden = level === null || level === 0 || level === 100;
  if (level !== null) $('line').style.top = (100 - level) + '%';
}

function clearReading() {
  reference = null;
  lastVideoTime = null;
  recent = [];
  showLevel(null);
  resetAlarm();
}

async function keepScreenOn() {
  if (!stream || document.hidden || (wakeLock && !wakeLock.released)) return;
  const currentStream = stream;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (stream !== currentStream || document.hidden || (wakeLock && !wakeLock.released)) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    status('wake-status', '');
    lock.addEventListener('release', () => {
      if (wakeLock === lock && stream && !document.hidden) {
        status('wake-status', 'A tela pode apagar. Ajuste o tempo de bloqueio do Android.');
      }
    });
  } catch {
    if (stream === currentStream) status('wake-status', 'A tela pode apagar. Ajuste o tempo de bloqueio do Android.');
  }
}

function stopCamera(message = 'Monitoramento encerrado. Abra a câmera para reiniciar.') {
  cameraRequest++;
  opening = false;
  clearInterval(sampler);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  if (wakeLock) void wakeLock.release().catch(() => {});
  wakeLock = null;
  preview.style.removeProperty('--ratio');
  $('placeholder').hidden = false;
  camera.textContent = 'Abrir câmera';
  drag = region = null;
  drawRegion();
  clearReading();
  status('wake-status', '');
  status('camera-status', message);
}

camera.addEventListener('click', async () => {
  if (stream || opening) {
    stopCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status('camera-status', 'A câmera precisa de HTTPS ou localhost e de um navegador compatível.');
    return;
  }
  void unlockAudio();
  opening = true;
  const request = ++cameraRequest;
  camera.textContent = 'Cancelar';
  status('camera-status', 'Aguardando permissão da câmera…');
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    if (request !== cameraRequest) {
      nextStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = nextStream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (stream === nextStream) stopCamera('A câmera foi interrompida. Abra-a novamente.');
    }, { once: true });
    video.srcObject = stream;
    await video.play();
    if (request !== cameraRequest) return;
    opening = false;
    $('placeholder').hidden = true;
    camera.textContent = 'Encerrar monitoramento';
    status('camera-status', 'Selecione uma faixa vertical no centro do vidro, evitando a moldura e os reflexos das bordas.');
    sampler = setInterval(sample, 250);
    void keepScreenOn();
  } catch (error) {
    if (request !== cameraRequest) return;
    stopCamera(error.name === 'NotAllowedError'
      ? 'Autorize a câmera nas permissões deste site e tente novamente.'
      : 'Não foi possível abrir a câmera. Confira se ela está disponível e tente novamente.');
  }
});

video.addEventListener('resize', () => {
  if (!video.videoWidth || !video.videoHeight) return;
  const ratio = video.videoWidth + ' / ' + video.videoHeight;
  if (preview.style.getPropertyValue('--ratio').trim() !== ratio && (reference || region || drag)) {
    region = drag = null;
    drawRegion();
    clearReading();
    status('camera-status', 'O formato do vídeo mudou. Selecione a área e calibre de novo.');
  }
  preview.style.setProperty('--ratio', ratio);
});

function point(event) {
  const bounds = preview.getBoundingClientRect();
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height) };
}

function drawRegion(box = region) {
  $('area').hidden = !box;
  $('calibrate').disabled = !region || Boolean(drag);
  if (!box) return;
  Object.assign($('area').style, {
    left: box.x * 100 + '%', top: box.y * 100 + '%',
    width: box.w * 100 + '%', height: box.h * 100 + '%'
  });
}

function rectangle(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

preview.addEventListener('pointerdown', (event) => {
  if (!stream || opening || !video.videoWidth || drag || event.button !== 0) return;
  drag = { id: event.pointerId, start: point(event) };
  preview.setPointerCapture(event.pointerId);
  resetAlarm();
  $('line').hidden = true;
  drawRegion(rectangle(drag.start, drag.start));
});
preview.addEventListener('pointermove', (event) => {
  if (drag?.id === event.pointerId) drawRegion(rectangle(drag.start, point(event)));
});
preview.addEventListener('pointerup', (event) => {
  if (drag?.id !== event.pointerId) return;
  const box = rectangle(drag.start, point(event));
  drag = null;
  const bounds = preview.getBoundingClientRect();
  if (box.w * bounds.width >= 20 && box.h * bounds.height >= 30) {
    region = box;
    clearReading();
    status('camera-status', 'Com a câmera fixa e o visor vazio, toque em Calibrar visor vazio.');
  }
  drawRegion();
});
for (const type of ['pointercancel', 'lostpointercapture']) {
  preview.addEventListener(type, (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    drawRegion();
  });
}

function frame() {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const { x, y, w, h } = region;
  ctx.drawImage(video, x * video.videoWidth, y * video.videoHeight,
    w * video.videoWidth, h * video.videoHeight, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

$('calibrate').addEventListener('click', () => {
  const baseline = frame();
  if (!baseline) {
    status('camera-status', 'Aguarde a imagem da câmera e tente calibrar novamente.');
    return;
  }
  clearReading();
  reference = baseline.data;
  status('camera-status', 'Calibrado. Mantenha a câmera fixa e acompanhe o nível na faixa selecionada.');
});

function sample() {
  if (document.hidden || !reference || drag) return;
  const image = video.currentTime === lastVideoTime ? null : frame();
  lastVideoTime = video.currentTime;
  const measured = image ? estimateLevel(reference, image, +sensitivity.value) : null;
  if (measured === null) recent = [];
  else {
    recent.push(measured);
    if (recent.length > 5) recent.shift();
  }
  const filtered = recent.toSorted((a, b) => a - b)[Math.floor(recent.length / 2)] ?? null;
  showLevel(filtered);
  const elapsed = alarm.update(filtered === null || measured <= +limit.value ? null : filtered,
    +limit.value, performance.now());
  remoteAlarm = elapsed === 30000;
  if (remoteAlarm) {
    if (alarm.silenced) status('alarm-status', 'Alarme silenciado até o nível baixar.');
    else {
      if (!tone || testTimeout !== undefined) sound();
      status('alarm-status', tone ? 'Alarme ativo.' : 'Nível acima do limite. Toque em Testar alarme para habilitar o som.');
    }
  } else if (testTimeout === undefined) {
    stopSound();
    status('alarm-status', filtered === null ? 'Leitura instável. Confira o enquadramento e a iluminação.'
      : alarm.since !== null ? 'Acima do limite há ' + Math.floor(elapsed / 1000) + ' de 30 s.'
        : 'Alarme local após 30 s acima do limite.');
  }
}

document.addEventListener('visibilitychange', () => {
  recent = [];
  showLevel(null);
  resetAlarm();
  if (!document.hidden) void keepScreenOn();
});
function stopPairing() {
  pairingGeneration++;
  clearInterval(heartbeat);
  pairing?.close();
  pairing = null;
  $('pair').textContent = 'Gerar link de alerta';
  $('pair-link').value = '';
  $('pair-link').hidden = $('copy-pair').hidden = true;
  status('pair-status', 'Compartilhamento encerrado.');
}

async function sendReading() {
  try {
    await pairing?.send(drag || document.hidden ? null : remoteLevel, remoteAlarm && !drag && !document.hidden);
  } catch {
    status('pair-status', 'Falha no envio da leitura. O alarme local continua funcionando.');
  }
}

$('pair').addEventListener('click', async () => {
  if (!$('pair-link').hidden) {
    stopPairing();
    return;
  }
  const generation = ++pairingGeneration;
  $('pair').disabled = true;
  status('pair-status', 'Conectando ao canal de alerta…');
  try {
    const secret = newPairing();
    const connection = await connectPairing(secret, (online) => {
      if (generation !== pairingGeneration) return;
      status('pair-status', online ? 'Canal de alerta conectado.' : 'Canal indisponível. Reconectando…');
    });
    if (generation !== pairingGeneration) {
      connection.close();
      return;
    }
    pairing = connection;
    heartbeat = setInterval(sendReading, 1500);
    const link = new URL('./alerta.html', location.href);
    link.hash = secret;
    $('pair-link').value = link.href;
    $('pair-link').hidden = $('copy-pair').hidden = false;
    $('pair').textContent = 'Encerrar compartilhamento';
  } catch {
    status('pair-status', 'Não foi possível iniciar o canal. Confira a internet e tente de novo.');
  } finally {
    $('pair').disabled = false;
  }
});

$('copy-pair').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pair-link').value);
    status('pair-status', 'Link copiado. Envie em privado ao segundo celular.');
  } catch {
    $('pair-link').select();
    status('pair-status', 'Selecione e copie o endereço exibido.');
  }
});

window.addEventListener('pagehide', () => {
  stopPairing();
  stopCamera();
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  const prompt = installPrompt;
  installPrompt = null;
  $('install').hidden = true;
  await prompt?.prompt();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install').hidden = true;
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      function reportUpdate() {
        if (registration.waiting && navigator.serviceWorker.controller) {
          offlineStatus.textContent = 'Atualização pronta. Feche todas as abas do app e reabra para usar a nova versão.';
        }
      }

      reportUpdate();
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', reportUpdate);
      });
    })
    .catch(() => {
      offlineStatus.textContent = 'Modo offline indisponível. Use o aplicativo com conexão.';
    });
}
