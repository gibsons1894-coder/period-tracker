'use strict';
// Web Push (RFC 8291) + VAPID (RFC 8292) — Cloudflare Workers native crypto

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a instanceof Uint8Array ? a : new Uint8Array(a), offset);
    offset += a.length;
  }
  return out;
}

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToUrlB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// HKDF-SHA-256: Extract(salt, ikm) → Expand(prk, info, length)
async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey = await crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const infoBytes = info instanceof Uint8Array ? info : new TextEncoder().encode(info);
  const t = new Uint8Array(
    await crypto.subtle.sign('HMAC', prkKey, concat(infoBytes, new Uint8Array([1])))
  );
  return t.slice(0, length);
}

// Encrypt payload per RFC 8291 (aes128gcm)
async function encryptPayload(plaintext, subscription) {
  const receiverPub = urlB64ToBytes(subscription.keys.p256dh);
  const authSecret  = urlB64ToBytes(subscription.keys.auth);

  // Sender ECDH key pair
  const senderKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const senderPub = new Uint8Array(await crypto.subtle.exportKey('raw', senderKP.publicKey));

  // ECDH shared secret
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, senderKP.privateKey, 256)
  );

  // IKM (RFC 8291 §3.3)
  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), receiverPub, senderPub);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // Salt, CEK, Nonce
  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0',     12);

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const msg = concat(new TextEncoder().encode(plaintext), new Uint8Array([2])); // 0x02 = last-record delimiter
  const ct  = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, msg)
  );

  // aes128gcm header: salt(16) | rs(4 BE) | idlen(1) | sender_pub(65)
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // record size
  header[20] = 65;
  header.set(senderPub, 21);

  return concat(header, ct);
}

// VAPID JWT (RFC 8292) — ES256, IEEE P1363 signature
async function vapidAuthHeader(audience, subject, pubKeyB64, privKeyJwk) {
  const privKey = await crypto.subtle.importKey(
    'jwk', JSON.parse(privKeyJwk),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header  = bytesToUrlB64(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToUrlB64(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 43200,
    sub: subject,
  })));

  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      new TextEncoder().encode(`${header}.${payload}`)
    )
  );

  return `vapid t=${header}.${payload}.${bytesToUrlB64(sig)},k=${pubKeyB64}`;
}

// Main: send a Web Push notification
export async function sendPush(subscription, jsonPayload, env) {
  const origin = new URL(subscription.endpoint).origin;

  const [body, auth] = await Promise.all([
    encryptPayload(jsonPayload, subscription),
    vapidAuthHeader(origin, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY_JWK),
  ]);

  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    auth,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body,
  });
}
