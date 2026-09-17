'use strict';
/* Shared multipart handling for both the guest upload and the admin one.
 * The uploader is rebuilt when the configured size limit changes. */

const multer = require('multer');
const config = require('./config');

let uploader = null;
let uploaderLimit = null;

function getUploader() {
  const limit = config.get('maxUploadMb');
  if (!uploader || uploaderLimit !== limit) {
    uploaderLimit = limit;
    uploader = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: limit * 1024 * 1024, files: 12 },
    });
  }
  return uploader;
}

/** Multipart filenames arrive as latin1-decoded bytes; re-interpret as UTF-8. */
function decodeName(name) {
  try {
    const fixed = Buffer.from(String(name || ''), 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') ? String(name) : fixed;
  } catch {
    return String(name || '');
  }
}

function boolish(v) {
  return v === true || v === 'true' || v === '1' || v === 'on';
}

function uploadError(err) {
  if (err.code === 'LIMIT_FILE_SIZE') return `File is larger than ${config.get('maxUploadMb')} MB`;
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return 'Up to 12 files can be uploaded at once';
  return err.message || 'Upload failed';
}

function optionsFrom(body = {}) {
  return {
    copies: body.copies,
    duplex: body.duplex === undefined ? undefined : boolish(body.duplex),
    paper: body.paper,
    scale: body.scale,
    range: body.range,
  };
}

module.exports = { getUploader, decodeName, boolish, uploadError, optionsFrom };
