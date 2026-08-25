export class SparklePackagerConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SparklePackagerConfigurationError'
  }
}
