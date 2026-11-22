const broker = 'wss://broker.emqx.io:8084/mqtt';
const maxAge = 8000;
let library;

function mqttLibrary() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mqtt@5.14.1/dist/mqtt.min.js';
    script.integrity = 'sha384-Fn2zaZeH/P7E88cwiBDKmBmrB35pj8a5baa5IzXAvBvF8pTFOJD3aHe3V8BtMsr6';
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve(window.mqtt);
    script.onerror = () => {
      library = undefined;
      script.remove();
      reject(new Error('Biblioteca de conexão indisponível'));
    };
    document.head.append(script);
  });
  return library;
}

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function newPairing() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function connectPairing(secret, onStatus, onReading) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Pareamento inválido');
  const bytes = Uint8Array.from(secret.match(/../g), (hex) => Number.parseInt(hex, 16));
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const topic = 'monitor-visual/v1/' + toHex(new Uint8Array(digest));
  const mqtt = await mqttLibrary();
  const client = mqtt.connect(broker, { connectTimeout: 8000, reconnectPeriod: 2000 });
  let latest = 0;
  let closed = false;
  client.on('connect', () => {
    if (!onReading) {
      onStatus(true);
      return;
    }
    client.subscribe(topic, (error, grants) => onStatus(!error && grants?.[0]?.qos === 0));
  });
  client.on('close', () => { if (!closed) onStatus(false); });
  client.on('error', () => { if (!closed) onStatus(false); });
  if (onReading) client.on('message', async (_topic, message) => {
    if (message.length < 29 || message.length > 256) return;
    try {
      const payload = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: message.subarray(0, 12) }, key, message.subarray(12));
      const reading = JSON.parse(new TextDecoder().decode(payload));
      if (closed || !Number.isSafeInteger(reading.at) || reading.at <= latest
        || Math.abs(Date.now() - reading.at) > maxAge
        || (reading.level !== null && (!Number.isInteger(reading.level) || reading.level < 0 || reading.level > 100))
        || typeof reading.alarm !== 'boolean' || (reading.alarm && reading.level === null)) return;
      latest = reading.at;
      onReading(reading);
    } catch {
      // Ignora mensagens que não pertencem ao pareamento.
    }
  });
  return {
    async send(level, alarm) {
      if (!client.connected || closed) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const payload = new TextEncoder().encode(JSON.stringify({ level, alarm, at: Date.now() }));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
      if (!client.connected || closed) return;
      const message = new Uint8Array(iv.length + encrypted.length);
      message.set(iv);
      message.set(encrypted, iv.length);
      client.publish(topic, message, { retain: false, qos: 0 });
    },
    close() {
      closed = true;
      client.end(true);
    }
  };
}
