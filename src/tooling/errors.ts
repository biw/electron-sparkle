/** Errors raised while locating electron-sparkle's published macOS artifacts. */
export class ElectronSparkleToolingError extends Error {
  readonly code:
    | 'UNSUPPORTED_PLATFORM'
    | 'UNSUPPORTED_ARCHITECTURE'
    | 'DARWIN_ARTIFACTS_MISSING'
    | 'ARCHIVE_CHECKSUM_MISMATCH'
    | 'LICENSE_CHECKSUM_MISMATCH'
    | 'MATERIALIZATION_FAILED'
    | 'OFFICIAL_TOOL_MISSING'
    | 'DOCTOR_FAILED'

  constructor(code: ElectronSparkleToolingError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ElectronSparkleToolingError'
    this.code = code
  }
}
