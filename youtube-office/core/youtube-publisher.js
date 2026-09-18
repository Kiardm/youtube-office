'use strict'

const crypto = require('crypto')
const fs = require('fs')

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3'
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

function base64url(buffer) { return Buffer.from(buffer).toString('base64url') }
function pkce() { const verifier = base64url(crypto.randomBytes(64)); return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier).digest()) } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function responseError(response) {
  let detail = ''
  try { detail = JSON.stringify(await response.json()) } catch { try { detail = await response.text() } catch {} }
  return new Error(`YouTube API ${response.status}: ${detail || response.statusText}`)
}

class YouTubePublisher {
  constructor({ clientId, redirectUri, secretStore, credentialName = 'youtube-oauth' }) {
    this.clientId = clientId
    this.redirectUri = redirectUri
    this.secretStore = secretStore
    this.credentialName = credentialName
  }

  createAuthorization() {
    if (!this.clientId) throw new Error('A Google OAuth desktop client ID is required.')
    const proof = pkce(); const state = base64url(crypto.randomBytes(32))
    const url = new URL(AUTH_ENDPOINT)
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: proof.challenge, code_challenge_method: 'S256' }).toString()
    return { url: url.toString(), state, verifier: proof.verifier, createdAt: new Date().toISOString() }
  }

  async exchangeCode(code, verifier) {
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: this.redirectUri }) })
    if (!response.ok) throw await responseError(response)
    const token = await response.json()
    if (!token.refresh_token) throw new Error('Google did not return a refresh token. Revoke the prior app grant and connect again.')
    await this.secretStore.set(this.credentialName, { refreshToken: token.refresh_token, scope: token.scope || SCOPE, connectedAt: new Date().toISOString() })
    return token
  }

  async accessToken() {
    const saved = await this.secretStore.get(this.credentialName)
    if (!saved?.refreshToken) throw new Error('YouTube is not connected on this computer.')
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }) })
    if (!response.ok) throw await responseError(response)
    const token = await response.json()
    return token.access_token
  }

  async api(pathname, { method = 'GET', body, headers = {}, accessToken } = {}) {
    const token = accessToken || await this.accessToken()
    const response = await fetch(`${API}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
    if (!response.ok) throw await responseError(response)
    return response.status === 204 ? null : response.json()
  }

  async channel() {
    const data = await this.api('/channels?part=id,snippet&mine=true')
    const channel = data.items?.[0]
    if (!channel) throw new Error('The connected Google account has no available YouTube channel.')
    return { id: channel.id, title: channel.snippet?.title || channel.id }
  }

  async initializeUpload({ accessToken, bytes, metadata }) {
    const response = await fetch(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(bytes), 'X-Upload-Content-Type': 'video/*' },
      body: JSON.stringify({ snippet: { title: metadata.title, description: metadata.description || '', tags: metadata.tags || [], categoryId: metadata.categoryId || '20' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: metadata.madeForKids === true } }),
    })
    if (!response.ok) throw await responseError(response)
    const location = response.headers.get('location')
    if (!location) throw new Error('YouTube did not return a resumable upload URL.')
    return location
  }

  async uploadFile({ file, metadata, onProgress, resumeUrl = null }) {
    const accessToken = await this.accessToken(); const stat = fs.statSync(file)
    const uploadUrl = resumeUrl || await this.initializeUpload({ accessToken, bytes: stat.size, metadata })
    const handle = await fs.promises.open(file, 'r'); const chunkBytes = 32 * 1024 * 1024
    let offset = 0; let result = null
    try {
      while (offset < stat.size) {
        const length = Math.min(chunkBytes, stat.size - offset); const chunk = Buffer.allocUnsafe(length)
        const read = await handle.read(chunk, 0, length, offset)
        if (!read.bytesRead) throw new Error('Unexpected end of video while uploading.')
        let response
        for (let attempt = 0; attempt < 5; attempt += 1) {
          response = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Length': String(read.bytesRead), 'Content-Range': `bytes ${offset}-${offset + read.bytesRead - 1}/${stat.size}`, 'Content-Type': 'video/*' }, body: chunk.subarray(0, read.bytesRead) })
          if (response.status === 308 || response.ok) break
          if (![429, 500, 502, 503, 504].includes(response.status)) throw await responseError(response)
          await sleep(1000 * (2 ** attempt))
        }
        if (!response || (!response.ok && response.status !== 308)) throw await responseError(response)
        offset += read.bytesRead
        onProgress?.({ uploadedBytes: offset, totalBytes: stat.size, percent: Math.round(offset / stat.size * 100), resumeUrl: uploadUrl })
        if (response.ok && response.status !== 308) result = await response.json()
      }
    } finally { await handle.close() }
    if (!result?.id) throw new Error('YouTube upload finished without returning a video ID.')
    return { videoId: result.id, uploadUrl }
  }

  async setThumbnail(videoId, file) {
    const token = await this.accessToken(); const bytes = await fs.promises.readFile(file)
    const type = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    const response = await fetch(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'Content-Length': String(bytes.length) }, body: bytes })
    if (!response.ok) throw await responseError(response)
    return response.json()
  }

  async video(videoId) {
    const data = await this.api(`/videos?part=id,snippet,status,processingDetails,contentDetails&id=${encodeURIComponent(videoId)}`)
    return data.items?.[0] || null
  }

  async waitForProcessing(videoId, { timeoutMs = 6 * 60 * 60 * 1000, pollMs = 15000, onPoll } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const video = await this.video(videoId)
      if (!video) throw new Error('Uploaded YouTube video is no longer available.')
      const status = video.processingDetails?.processingStatus || 'processing'
      onPoll?.({ status, video })
      if (status === 'succeeded') return video
      if (status === 'failed' || status === 'terminated') throw new Error(`YouTube processing ${status}.`)
      await sleep(pollMs)
    }
    throw new Error('YouTube processing did not finish before the verification timeout.')
  }

  async setVisibility(videoId, privacyStatus) {
    return this.api('/videos?part=status', { method: 'PUT', body: { id: videoId, status: { privacyStatus } } })
  }
}

module.exports = { SCOPE, YouTubePublisher }
