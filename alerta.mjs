import { connectPairing } from './remote.mjs';

const $ = (id) => document.getElementById(id);
let connection, timeout, audio, tone, wakeLock;
let latestAlarm = false;
let silenced = false;
let soundEnabled = false;
let leaving = false;
let testTone;

function playTone() {
  const oscillator = audio.createOscillator();
  oscillator.frequency.value = 740;
  const volume = audio.createGain();
  volume.gain.value = 0.16;
  oscillator.connect(volume).connect(audio.destination);
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect();
    volume.disconnect();
  }, { once: true });
  oscillator.start();
  return oscillator;
}

function refreshSound() {
  if ((!latestAlarm || silenced || document.hidden || !soundEnabled || audio?.state !== 'running') && tone) {
    tone.stop();
    tone.disconnect();
    tone = null;
  }
  if (latestAlarm && !silenced && !document.hidden && soundEnabled && !tone && audio.state === 'running') {
    testTone?.stop();
    tone = playTone();
  }
  const ready = audio?.state === 'running' && soundEnabled;
  $('enable').disabled = ready || !secret;
  $('test-sound').disabled = !secret || Boolean(tone);
  $('silence').disabled = !latestAlarm || silenced;
  $('alarm-status').textContent = latestAlarm
    ? silenced ? 'Alarme silenciado.' : tone ? 'Alarme remoto ativo.' : 'Alarme remoto ativo. Ative o som.'
    : ready ? 'Som ativado.' : '';
}

async function keepScreenOn() {
  if (document.hidden || (wakeLock && !wakeLock.released)) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (document.hidden || (wakeLock && !wakeLock.released)) await lock.release();
    else wakeLock = lock;
  } catch {
    // O ajuste de tela do aparelho continua disponível.
  }
}

async function enableSound() {
  try {
    if (!audio) {
      audio = new AudioContext();
      audio.addEventListener('statechange', refreshSound);
    }
    await audio.resume();
    soundEnabled = audio.state === 'running';
    refreshSound();
    void keepScreenOn();
    return soundEnabled;
  } catch {
    $('sound-test-status').textContent = 'Som indisponível. Tente ativar novamente.';
    return false;
  }
}

$('enable').addEventListener('click', async () => {
  $('sound-test-status').textContent = '';
  await enableSound();
});
$('test-sound').addEventListener('click', async () => {
  if (!(await enableSound()) || tone) return;
  testTone?.stop();
  const beep = playTone();
  testTone = beep;
  beep.stop(audio.currentTime + 0.8);
  beep.addEventListener('ended', () => { if (testTone === beep) testTone = null; }, { once: true });
  $('sound-test-status').textContent = 'Se não ouviu o toque, aumente o volume de mídia do Android.';
});
$('silence').addEventListener('click', () => {
  silenced = true;
  refreshSound();
});

function render(level, alarm, status) {
  $('level').value = level === null ? '—' : level + '%';
  $('meter').value = level ?? 0;
  $('connection').textContent = status;
  latestAlarm = alarm;
  if (!alarm && level !== null) silenced = false;
  refreshSound();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) testTone?.stop();
  refreshSound();
  if (!document.hidden && soundEnabled) void keepScreenOn();
});
window.addEventListener('pagehide', () => {
  leaving = true;
  testTone?.stop();
  clearTimeout(timeout);
  connection?.close();
  render(null, false, 'Painel encerrado.');
});
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
window.addEventListener('hashchange', () => {
  if (/^[a-f0-9]{64}$/.test(location.hash.slice(1))) location.reload();
});

function waitForSensor() {
  clearTimeout(timeout);
  timeout = setTimeout(() => render(null, false,
    'Sem sinal recente do sensor. Confira se a câmera está aberta e se este link é o salvo no sensor.'), 6000);
}

const receiverKey = 'monitor-visual:receiver:v1:' + new URL('./', location.href).pathname;
const incomingSecret = location.hash.slice(1);
let secret = /^[a-f0-9]{64}$/.test(incomingSecret) ? incomingSecret : '';
try {
  if (secret) {
    localStorage.setItem(receiverKey, secret);
    history.replaceState(null, '', new URL('./alerta.html', location.href));
  } else if (!incomingSecret) {
    secret = localStorage.getItem(receiverKey) ?? '';
  }
} catch {
  // O link completo continua funcionando quando o navegador não permite salvar o pareamento.
}

if (/^[a-f0-9]{64}$/.test(secret)) {
  $('connection').textContent = 'Conectando…';
  $('enable').disabled = $('test-sound').disabled = false;
  try {
    connection = await connectPairing(secret, (online) => {
      if (!online) {
        clearTimeout(timeout);
        render(null, false, 'Conexão interrompida. Reconectando…');
      } else if ($('level').value === '—') {
        $('connection').textContent = 'Conectado. Aguardando o sensor…';
        waitForSensor();
      }
    }, (reading) => {
      clearTimeout(timeout);
      render(reading.level, reading.alarm, reading.level === null ? 'Sensor conectado. Aguardando calibração ou leitura válida.' : 'Recebendo leitura do sensor.');
      waitForSensor();
    }, () => {
      clearTimeout(timeout);
      render(null, false, 'Chegou um sinal fora do horário esperado. Ative data e hora automáticas nos dois celulares.');
    });
    if (leaving) connection.close();
  } catch {
    render(null, false, 'Não foi possível conectar. Confira a internet e recarregue o painel.');
  }
}
