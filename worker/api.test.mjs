// End-to-end check of passkey accounts and list sync, using a software passkey (P-256 key pair).
// Run against a local Worker:
//   npx wrangler d1 execute gamerank --local --file schema.sql && npx wrangler dev   (then, in another shell)
//   node api.test.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { isoCBOR, isoBase64URL } from '@simplewebauthn/server/helpers';

const BASE = process.env.API ?? 'http://localhost:8787', ORIGIN = 'http://localhost:8765', RP = 'localhost';
const sha = b => createHash('sha256').update(b).digest();
const b64 = b => isoBase64URL.fromBuffer(new Uint8Array(b));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

// The "device": a key pair and credential id, as a password manager would hold.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
  [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]));
const credId = randomBytes(16), id = b64(credId);
let counter = 0;
const authData = (flags, attested) => Buffer.concat([sha(RP), Buffer.from([flags]), u32(counter),
  ...(attested ? [Buffer.alloc(16), u16(credId.length), credId, Buffer.from(cose)] : [])]);
const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));

async function call(method, path, body, token) {
  const r = await fetch(BASE + path, { method, body: body && JSON.stringify(body), headers: {
    Origin: ORIGIN, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) } });
  return [r.status, await r.json()];
}

async function register() {
  const [, { challengeId, options }] = await call('POST', '/auth/register/options');
  assert.equal(options.rp.id, RP);
  const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(0x45, true)]]));
  return call('POST', '/auth/register/verify', { challengeId, response: { id, rawId: id, type: 'public-key',
    response: { clientDataJSON: b64(clientData('webauthn.create', options.challenge)), attestationObject: b64(attestationObject),
                transports: ['internal'] }, clientExtensionResults: {} } });
}

async function login() {
  const [, { challengeId, options }] = await call('POST', '/auth/login/options');
  counter++;
  const ad = authData(0x05, false), cd = clientData('webauthn.get', options.challenge);
  const assertion = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey)) } };
  return [challengeId, assertion, await call('POST', '/auth/login/verify', { challengeId, response: assertion })];
}

let [status, body] = await register();
assert.equal(status, 200, JSON.stringify(body));
const token1 = body.token;

// Signed in: list starts empty, saves and reads back.
assert.deepEqual(await call('GET', '/list', null, token1), [200, null]);
const list = { ranked: [1020, 1942], platforms: [6] };
assert.equal((await call('PUT', '/list', { data: list, updated: 123 }, token1))[0], 200);
assert.deepEqual(await call('GET', '/list', null, token1), [200, { data: list, updated: 123 }]);

// Sign in again with the same passkey: same account, same list.
const [challengeId, assertion, [s2, b2]] = await login();
assert.equal(s2, 200, JSON.stringify(b2));
assert.deepEqual((await call('GET', '/list', null, b2.token))[1].data, list);

// A replayed sign-in, a bad token and a wrong origin are all refused.
assert.equal((await call('POST', '/auth/login/verify', { challengeId, response: assertion }))[0], 400);
assert.equal((await call('GET', '/list', null, 'nope'))[0], 401);
assert.equal((await fetch(BASE + '/list', { headers: { Origin: 'https://evil.example' } })).status, 403);

// Sign out ends that session only; deleting the account removes everything.
assert.equal((await call('POST', '/auth/logout', null, token1))[0], 200);
assert.equal((await call('GET', '/list', null, token1))[0], 401);
assert.equal((await call('DELETE', '/account', null, b2.token))[0], 200);
assert.equal((await call('GET', '/list', null, b2.token))[0], 401);
assert.equal((await login())[2][0], 404);

console.log('ok: register, sign in, sync, replay, sign out, delete');
