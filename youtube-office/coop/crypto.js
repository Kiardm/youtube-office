'use strict'

const crypto = require('crypto')

const WORDS = ['amber','atlas','beacon','birch','canyon','cedar','cobalt','comet','coral','ember','falcon','fjord','forest','harbor','hazel','indigo','juniper','lagoon','maple','meadow','meteor','onyx','orchid','pebble','pine','quartz','raven','river','sable','solar','spruce','stone','tiger','violet','willow','zephyr']

function base64url(buffer) { return Buffer.from(buffer).toString('base64url') }
function fromBase64url(value) { return Buffer.from(String(value), 'base64url') }
function randomRoomCode() { return Array.from({ length: 6 }, () => WORDS[crypto.randomInt(WORDS.length)]).join('-') }
function roomKey(code, salt) { return crypto.scryptSync(String(code), salt, 32) }
function verificationPhrase(key) { return crypto.createHash('sha256').update(key).digest('hex').match(/.{1,4}/g).slice(0, 3).join('-') }
function createIdentity(label = 'Participant') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { id: `device-${crypto.randomUUID()}`, label, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), createdAt: new Date().toISOString() }
}
function sign(identity, body) { return base64url(crypto.sign(null, Buffer.from(body), identity.privateKey)) }
function verify(publicKey, body, signature) { return crypto.verify(null, Buffer.from(body), publicKey, fromBase64url(signature)) }
function encrypt(key, value, associated = '') {
  const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(associated)); const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()])
  return { nonce: base64url(nonce), ciphertext: base64url(encrypted), tag: base64url(cipher.getAuthTag()) }
}
function decrypt(key, envelope, associated = '') {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromBase64url(envelope.nonce)); decipher.setAAD(Buffer.from(associated)); decipher.setAuthTag(fromBase64url(envelope.tag))
  return JSON.parse(Buffer.concat([decipher.update(fromBase64url(envelope.ciphertext)), decipher.final()]).toString('utf8'))
}

module.exports = { createIdentity, decrypt, encrypt, randomRoomCode, roomKey, sign, verificationPhrase, verify }
