'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

function safeName(value, fallback = 'finished-product') {
  const clean = String(value || '').normalize('NFKD').replace(/[^a-zA-Z0-9._ -]+/g, '').replace(/\s+/g, ' ').trim()
  return (clean || fallback).slice(0, 120)
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

function ffprobe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate', '-of', 'json', file], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ available: false, error: String(error.message || error) })
      try { resolve({ available: true, ...JSON.parse(stdout) }) } catch (parseError) { resolve({ available: false, error: String(parseError.message || parseError) }) }
    })
  })
}

function readManifest(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object') throw new Error('Deliverable manifest must be a JSON object.')
  return value
}

function resolveCandidate(runDir, manifest) {
  const requested = String(manifest.candidatePath || manifest.path || '').trim()
  if (!requested) throw new Error('Deliverable manifest does not identify candidatePath.')
  const candidate = path.resolve(runDir, requested)
  if (!inside(runDir, candidate)) throw new Error('Deliverable candidate must remain inside the project run directory.')
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`Deliverable candidate does not exist: ${candidate}`)
  return candidate
}

async function inspectDeliverable({ runDir, manifestFile }) {
  const manifest = readManifest(manifestFile)
  const candidatePath = resolveCandidate(runDir, manifest)
  const thumbnailPath = manifest.thumbnailPath ? path.resolve(runDir, String(manifest.thumbnailPath)) : null
  if (thumbnailPath && !inside(runDir, thumbnailPath)) throw new Error('Deliverable thumbnail must remain inside the project run directory.')
  const stat = fs.statSync(candidatePath)
  const artifactType = String(manifest.artifactType || (path.extname(candidatePath).toLowerCase() === '.mp4' ? 'video' : 'file')).toLowerCase()
  const media = artifactType === 'video' ? await ffprobe(candidatePath) : null
  if (artifactType === 'video' && media?.available) {
    const video = (media.streams || []).find((stream) => stream.codec_type === 'video')
    const audio = (media.streams || []).filter((stream) => stream.codec_type === 'audio')
    if (!video) throw new Error('The selected video deliverable has no video stream.')
    if (!audio.length) throw new Error('The selected video deliverable has no audio stream.')
  }
  return {
    schemaVersion: 1,
    candidatePath,
    artifactType,
    fileName: safeName(manifest.fileName || path.basename(candidatePath)),
    bytes: stat.size,
    sha256: await sha256(candidatePath),
    media,
    title: String(manifest.title || '').trim(),
    description: String(manifest.description || '').trim(),
    tags: Array.isArray(manifest.tags) ? manifest.tags.map(String).slice(0, 30) : [],
    categoryId: String(manifest.categoryId || '20'),
    madeForKids: manifest.madeForKids === true,
    thumbnailPath,
    revisionFamilyId: safeName(manifest.revisionFamilyId || manifest.projectId || path.basename(runDir)),
    inspectedAt: new Date().toISOString(),
  }
}

async function promoteDeliverable({ finishedRoot, projectId, projectTitle, runDir, manifestFile }) {
  const inspected = await inspectDeliverable({ runDir, manifestFile })
  const projectDirectory = path.resolve(finishedRoot, safeName(projectTitle || projectId))
  if (!inside(finishedRoot, projectDirectory)) throw new Error('Finished-product path escaped the configured delivery root.')
  fs.mkdirSync(projectDirectory, { recursive: true })
  const archive = path.join(runDir, 'previous-deliverables')
  fs.mkdirSync(archive, { recursive: true })
  for (const entry of fs.readdirSync(projectDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const source = path.join(projectDirectory, entry.name)
    const destination = path.join(archive, `${Date.now()}-${safeName(entry.name)}`)
    fs.renameSync(source, destination)
  }
  const destination = path.join(projectDirectory, safeName(inspected.fileName, `finished${path.extname(inspected.candidatePath)}`))
  const temporary = `${destination}.partial-${process.pid}`
  await fs.promises.copyFile(inspected.candidatePath, temporary)
  const destinationHash = await sha256(temporary)
  if (destinationHash !== inspected.sha256) { fs.rmSync(temporary, { force: true }); throw new Error('Finished-product hash verification failed.') }
  fs.renameSync(temporary, destination)
  return { ...inspected, projectId, projectTitle, manifestFile: path.resolve(manifestFile), finalPath: destination, deliveredAt: new Date().toISOString(), status: 'delivered' }
}

function discoverLegacyCandidate(runDir) {
  const files = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.mp4', '.mov', '.mkv', '.webm'].includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ path: path.join(runDir, entry.name), bytes: fs.statSync(path.join(runDir, entry.name)).size }))
    .sort((a, b) => b.bytes - a.bytes)
  return files[0]?.path || null
}

module.exports = { discoverLegacyCandidate, ffprobe, inspectDeliverable, inside, promoteDeliverable, readManifest, safeName, sha256 }
