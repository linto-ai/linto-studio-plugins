'use strict'

const express = require('express')
const archiver = require('archiver')
const path = require('path')
const fs = require('fs')
const { logger } = require('live-srt-lib')

/**
 * Create manifest routes for Teams app package generation.
 * @param {Object} component - The WebServer component instance
 * @returns {express.Router}
 */
function createManifestRoutes(component) {
  const router = express.Router()

  // Get configuration from environment
  const appId = process.env.TEAMSAPPSERVICE_APP_ID || '00000000-0000-0000-0000-000000000000'
  const baseUrl = process.env.TEAMSAPPSERVICE_BASE_URL || 'https://emeeting.example.com'
  const domain = new URL(baseUrl).host

  /**
   * GET /manifest/package.zip
   * Generate and download the Teams app package with environment variables replaced.
   */
  router.get('/package.zip', (req, res) => {
    try {
      const manifestDir = path.join(__dirname, '../public/manifest')
      const manifestPath = path.join(manifestDir, 'manifest.json')

      // Read and process manifest
      let manifestContent = fs.readFileSync(manifestPath, 'utf8')
      manifestContent = manifestContent
        .replace(/\{\{APP_ID\}\}/g, appId)
        .replace(/\{\{BASE_URL\}\}/g, baseUrl)
        .replace(/\{\{DOMAIN\}\}/g, domain)

      // Set response headers
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename="teams-app.zip"')

      // Create archive
      const archive = archiver('zip', { zlib: { level: 9 } })

      archive.on('error', (err) => {
        logger.error('Archive error:', err)
        res.status(500).send('Error generating package')
      })

      // Pipe archive to response
      archive.pipe(res)

      // Add processed manifest
      archive.append(manifestContent, { name: 'manifest.json' })

      // Add icons
      const colorIconPath = path.join(manifestDir, 'color.png')
      const outlineIconPath = path.join(manifestDir, 'outline.png')

      if (fs.existsSync(colorIconPath)) {
        archive.file(colorIconPath, { name: 'color.png' })
      } else {
        logger.warn('color.png not found, using placeholder')
        archive.append(generatePlaceholderIcon(192, [91, 95, 199]), { name: 'color.png' })
      }

      if (fs.existsSync(outlineIconPath)) {
        archive.file(outlineIconPath, { name: 'outline.png' })
      } else {
        logger.warn('outline.png not found, using placeholder')
        archive.append(generatePlaceholderIcon(32, [91, 95, 199], true), { name: 'outline.png' })
      }

      // Finalize archive
      archive.finalize()

    } catch (err) {
      logger.error('Error generating manifest package:', err)
      res.status(500).json({ error: 'Failed to generate package' })
    }
  })

  /**
   * GET /manifest/info
   * Get current manifest configuration info.
   */
  router.get('/info', (req, res) => {
    res.json({
      appId,
      baseUrl,
      domain,
      downloadUrl: `${baseUrl}/manifest/package.zip`
    })
  })

  return router
}

/**
 * Generate a simple placeholder PNG icon.
 * Creates a solid color square with optional transparency for outline icon.
 * @param {number} size - Icon size in pixels
 * @param {number[]} rgb - RGB color values [r, g, b]
 * @param {boolean} outline - If true, creates outline style (transparent background)
 * @returns {Buffer} PNG image buffer
 */
function generatePlaceholderIcon(size, rgb, outline = false) {
  // PNG file structure
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  // IHDR chunk
  const ihdr = createIHDRChunk(size, size)

  // IDAT chunk (image data)
  const idat = createIDATChunk(size, rgb, outline)

  // IEND chunk
  const iend = createIENDChunk()

  return Buffer.concat([signature, ihdr, idat, iend])
}

function createIHDRChunk(width, height) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data.writeUInt8(8, 8)  // bit depth
  data.writeUInt8(6, 9)  // color type (RGBA)
  data.writeUInt8(0, 10) // compression
  data.writeUInt8(0, 11) // filter
  data.writeUInt8(0, 12) // interlace

  return createChunk('IHDR', data)
}

function createIDATChunk(size, rgb, outline) {
  const zlib = require('zlib')

  // Create raw pixel data (RGBA)
  const rowSize = 1 + size * 4 // filter byte + RGBA pixels
  const rawData = Buffer.alloc(rowSize * size)

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowSize
    rawData[rowOffset] = 0 // No filter

    for (let x = 0; x < size; x++) {
      const pixelOffset = rowOffset + 1 + x * 4

      if (outline) {
        // Create a simple "T" shape for outline
        const margin = Math.floor(size * 0.15)
        const thickness = Math.floor(size * 0.2)
        const centerX = Math.floor(size / 2)
        const centerY = Math.floor(size / 2)

        const inTopBar = y >= margin && y < margin + thickness && x >= margin && x < size - margin
        const inVertBar = x >= centerX - thickness / 2 && x < centerX + thickness / 2 && y >= margin && y < size - margin

        if (inTopBar || inVertBar) {
          rawData[pixelOffset] = rgb[0]
          rawData[pixelOffset + 1] = rgb[1]
          rawData[pixelOffset + 2] = rgb[2]
          rawData[pixelOffset + 3] = 255
        } else {
          rawData[pixelOffset] = 0
          rawData[pixelOffset + 1] = 0
          rawData[pixelOffset + 2] = 0
          rawData[pixelOffset + 3] = 0 // Transparent
        }
      } else {
        // Solid color with rounded corners for color icon
        const cornerRadius = Math.floor(size * 0.15)
        const inCorner = isInRoundedCorner(x, y, size, cornerRadius)

        if (inCorner) {
          rawData[pixelOffset] = 0
          rawData[pixelOffset + 1] = 0
          rawData[pixelOffset + 2] = 0
          rawData[pixelOffset + 3] = 0 // Transparent corner
        } else {
          rawData[pixelOffset] = rgb[0]
          rawData[pixelOffset + 1] = rgb[1]
          rawData[pixelOffset + 2] = rgb[2]
          rawData[pixelOffset + 3] = 255
        }
      }
    }
  }

  const compressed = zlib.deflateSync(rawData)
  return createChunk('IDAT', compressed)
}

function isInRoundedCorner(x, y, size, radius) {
  // Check each corner
  const corners = [
    { cx: radius, cy: radius },                    // top-left
    { cx: size - radius - 1, cy: radius },         // top-right
    { cx: radius, cy: size - radius - 1 },         // bottom-left
    { cx: size - radius - 1, cy: size - radius - 1 } // bottom-right
  ]

  for (const corner of corners) {
    const inCornerSquare = (
      (x < radius && y < radius) ||
      (x >= size - radius && y < radius) ||
      (x < radius && y >= size - radius) ||
      (x >= size - radius && y >= size - radius)
    )

    if (inCornerSquare) {
      const dx = x - corner.cx
      const dy = y - corner.cy
      if (dx * dx + dy * dy > radius * radius) {
        return true
      }
    }
  }

  return false
}

function createIENDChunk() {
  return createChunk('IEND', Buffer.alloc(0))
}

function createChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const typeBuffer = Buffer.from(type, 'ascii')
  const crcData = Buffer.concat([typeBuffer, data])
  const crc = crc32(crcData)

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc, 0)

  return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

// CRC32 implementation for PNG
function crc32(data) {
  let crc = 0xFFFFFFFF

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320
      } else {
        crc >>>= 1
      }
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0
}

module.exports = createManifestRoutes
