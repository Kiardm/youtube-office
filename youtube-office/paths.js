'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const APP_DIR_NAME = 'YouTube Office'
const roamingRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const localRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const configDir = path.join(roamingRoot, APP_DIR_NAME)
const configFile = path.join(configDir, 'config.json')

function readConfig() {
  try {
    // Windows PowerShell 5.1 writes UTF-8 JSON with a BOM by default.
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const config = readConfig()
const defaultContentRoot = path.join(os.homedir(), 'Documents', APP_DIR_NAME, 'content-workspace')
const defaultDataDir = path.join(localRoot, APP_DIR_NAME, 'data')

const contentRoot = path.resolve(
  process.env.YOUTUBE_OFFICE_CONTENT_ROOT
  || process.env.CONTENT_OPS_ROOT
  || config.contentRoot
  || defaultContentRoot,
)
const dataDir = path.resolve(
  process.env.YOUTUBE_OFFICE_DATA_DIR
  || config.dataDir
  || defaultDataDir,
)

module.exports = {
  APP_DIR_NAME,
  config,
  configDir,
  configFile,
  contentRoot,
  dataDir,
  defaultContentRoot,
  defaultDataDir,
}
