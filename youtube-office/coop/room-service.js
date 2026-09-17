'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { createIdentity, decrypt, encrypt, randomRoomCode, roomKey, sign, verificationPhrase, verify } = require('./crypto')

const PROTOCOL_VERSION = '4.0.0'
const PROJECT_SCHEMA = 1

class RoomService {
  constructor(dataDir, options = {}) {
    this.file = path.join(dataDir, 'coop-private.json')
    this.identity = this.loadIdentity(options.label)
    this.rooms = new Map()
    this.seenNonces = new Set()
  }
  loadIdentity(label) {
    try { const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (parsed.privateKey && parsed.publicKey) return parsed } catch {}
    const identity = createIdentity(label || 'Local participant'); fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 }); return identity
  }
  createRoom(input = {}) {
    const code = randomRoomCode(); const salt = crypto.randomBytes(16); const key = roomKey(code, salt); const id = `room-${crypto.randomUUID()}`
    const participant = { id: this.identity.id, label: input.label || this.identity.label, publicKey: this.identity.publicKey }
    const room = { id, code, salt: salt.toString('base64url'), key, phrase: verificationPhrase(key), host: this.identity.id, participant, participantDirectory: { [participant.id]: participant }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (input.ttlMs || 86_400_000)).toISOString(), protocolVersion: PROTOCOL_VERSION, appVersion: input.appVersion || '4.0.0', promptBundle: input.promptBundle, projectSchema: PROJECT_SCHEMA, revokedDevices: [] }
    this.rooms.set(id, room); return this.publicRoom(room)
  }
  joinRoom(invite, local = {}) {
    if (!invite || invite.protocolVersion !== PROTOCOL_VERSION || invite.projectSchema !== PROJECT_SCHEMA) throw new Error('Incompatible co-op protocol or project schema')
    if (Date.parse(invite.expiresAt) < Date.now()) throw new Error('Co-op room has expired')
    const key = roomKey(String(invite.code), Buffer.from(String(invite.salt), 'base64url'))
    if (verificationPhrase(key) !== invite.phrase) throw new Error('Room verification phrase does not match')
    const participant = { id: this.identity.id, label: local.label || this.identity.label, publicKey: this.identity.publicKey }
    const participantDirectory = Object.fromEntries((invite.participants || []).map((entry) => [entry.id, entry])); participantDirectory[participant.id] = participant
    const room = { ...invite, key, code: invite.code, participant, participantDirectory, joinedAt: new Date().toISOString(), revokedDevices: [] }
    this.rooms.set(room.id, room); return this.publicRoom(room)
  }
  publicRoom(room) { const { key: _key, participantDirectory: _directory, ...safe } = room; return { ...safe, participants: Object.values(room.participantDirectory || { [room.participant.id]: room.participant }), sixWorkers: true } }
  makeEnvelope(roomId, type, payload) {
    const room = this.rooms.get(roomId); if (!room) throw new Error('Room not found')
    const nonce = crypto.randomUUID(); const issuedAt = new Date().toISOString(); const associated = `${room.id}|${this.identity.id}|${nonce}|${type}`
    const encrypted = encrypt(room.key, payload, associated); const unsigned = { version: PROTOCOL_VERSION, roomId: room.id, senderId: this.identity.id, senderPublicKey: this.identity.publicKey, senderLabel: room.participant?.label || this.identity.label, nonce, issuedAt, expiresAt: new Date(Date.now() + 300_000).toISOString(), type, encrypted }
    const serialized = JSON.stringify(unsigned); return { ...unsigned, signature: sign(this.identity, serialized) }
  }
  openEnvelope(roomId, envelope, senderPublicKey = envelope.senderPublicKey) {
    const room = this.rooms.get(roomId); if (!room) throw new Error('Room not found')
    if (envelope.version !== PROTOCOL_VERSION || envelope.roomId !== room.id) throw new Error('Incompatible room envelope')
    if (Date.parse(envelope.expiresAt) < Date.now()) throw new Error('Expired room envelope')
    if (this.seenNonces.has(envelope.nonce)) throw new Error('Replayed room envelope')
    const { signature, ...unsigned } = envelope; if (!verify(senderPublicKey, JSON.stringify(unsigned), signature)) throw new Error('Invalid room signature')
    const associated = `${room.id}|${envelope.senderId}|${envelope.nonce}|${envelope.type}`; const payload = decrypt(room.key, envelope.encrypted, associated)
    room.participantDirectory[envelope.senderId] = { id: envelope.senderId, label: String(envelope.senderLabel || 'Participant').slice(0, 80), publicKey: senderPublicKey }
    this.seenNonces.add(envelope.nonce); if (this.seenNonces.size > 5000) this.seenNonces = new Set([...this.seenNonces].slice(-2500)); return payload
  }
  removeParticipant(roomId, participantId) {
    const room = this.rooms.get(roomId); if (!room) throw new Error('Room not found')
    if (participantId === room.host) throw new Error('The host must close the room rather than remove itself')
    delete room.participantDirectory[participantId]; room.revokedDevices = [...new Set([...(room.revokedDevices || []), participantId])]
    const code = randomRoomCode(); const salt = crypto.randomBytes(16); const key = roomKey(code, salt)
    Object.assign(room, { code, salt: salt.toString('base64url'), key, phrase: verificationPhrase(key), rotatedAt: new Date().toISOString() })
    return this.publicRoom(room)
  }
}

module.exports = { PROJECT_SCHEMA, PROTOCOL_VERSION, RoomService }
