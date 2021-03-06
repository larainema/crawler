// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const BaseHandler = require('../../lib/baseHandler')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const du = require('du')

let _toolVersion

class ScanCodeProcessor extends BaseHandler {
  constructor(options) {
    super(options)
    // TODO little questionable here. Kick off an async operation on load with the expecation that
    // by the time someone actually uses this instance, the call will have completed.
    // Need to detect the tool version before anyone tries to run this processor.
    this._detectVersion()
  }

  get schemaVersion() {
    return _toolVersion
  }

  get toolSpec() {
    return { tool: 'scancode', toolVersion: this.schemaVersion }
  }

  canHandle(request) {
    return request.type === 'scancode'
  }

  async handle(request) {
    const { document, spec } = super._process(request)
    const size = await this._computeSize(document)
    request.addMeta({ k: size.k, fileCount: size.count })
    this.addBasicToolLinks(request, spec)
    const file = this._createTempFile(request)
    this.logger.info(
      `Analyzing ${request.toString()} using ScanCode. input: ${request.document.location} output: ${file.name}`
    )

    return new Promise((resolve, reject) => {
      const parameters = [
        ...this.options.options,
        '--timeout',
        this.options.timeout.toString(),
        '-n',
        this.options.processes.toString(),
        this.options.format,
        file.name,
        request.document.location
      ].join(' ')
      exec(`cd ${this.options.installDir} && .${path.sep}scancode ${parameters}`, (error, stdout, stderr) => {
        if (this._isRealError(error) || this._hasRealErrors(file.name)) {
          request.markDead('Error', error ? error.message : 'ScanCode run failed')
          return reject(error)
        }
        document._metadata.contentLocation = file.name
        document._metadata.contentType = 'application/json'
        document._metadata.releaseDate = request.document.releaseDate
        resolve(request)
      })
    })
  }

  async _computeSize(document) {
    let count = 0
    const bytes = await promisify(du)(document.location, {
      filter: file => {
        if (path.basename(file) === '.git') {
          return false
        }
        count++
        return true
      }
    })
    return { k: Math.round(bytes / 1024), count }
  }

  // Workaround until https://github.com/nexB/scancode-toolkit/issues/983 is resolved
  _isRealError(error) {
    return error && error.message && !error.message.includes('Some files failed to scan properly')
  }

  // Scan the results file for any errors that are not just timeouts or other known errors
  _hasRealErrors(resultFile) {
    const results = JSON.parse(fs.readFileSync(resultFile))
    return results.files.some(file =>
      file.scan_errors.some(error => {
        return !(
          error.includes('ERROR: Processing interrupted: timeout after') ||
          error.includes('ValueError:') ||
          error.includes('package.json')
        )
      })
    )
  }

  _getUrn(spec) {
    const newSpec = Object.assign(Object.create(spec), spec, { tool: 'scancode', toolVersion: this.toolVersion })
    return newSpec.toUrn()
  }

  _detectVersion() {
    if (_toolVersion) return _toolVersion
    return new Promise((resolve, reject) => {
      exec(`cd ${this.options.installDir} && .${path.sep}scancode --version`, (error, stdout, stderr) => {
        if (error) return reject(error)
        _toolVersion = stdout.replace('ScanCode version ', '').trim()
        resolve(_toolVersion)
      })
    })
  }
}

module.exports = options => new ScanCodeProcessor(options)
