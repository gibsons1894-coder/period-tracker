// VAPID 키 생성 스크립트
// 실행: node generate-keys.mjs

const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

function toUrlB64(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

console.log('\n=== VAPID Keys ===\n');
console.log('VAPID_PUBLIC_KEY (app.js에 붙여넣기):');
console.log(toUrlB64(pubRaw));
console.log('\nVAPID_PRIVATE_KEY_JWK (wrangler secret set 사용):');
console.log(JSON.stringify(privJwk));
console.log('\n==================\n');
