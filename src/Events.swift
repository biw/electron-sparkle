import Foundation

// @swift-node:codable
struct SparkleUpdaterState: Codable {
    let started: Bool
    let canCheckForUpdates: Bool
    let sessionInProgress: Bool
    let automaticallyChecksForUpdates: Bool
    let automaticallyDownloadsUpdates: Bool
}

// @swift-node:codable
struct SparkleUpdate: Codable {
    let version: String
    let displayVersion: String
    let title: String?
    let fileURL: String?
    let infoURL: String?
    let releaseNotesURL: String?
    let contentLength: Int64?
    let publicationDate: String?
}

// @swift-node:codable
struct SparkleUpdaterError: Codable {
    let domain: String
    let code: Int
    let message: String
}

// @swift-node:codable
struct SparkleUpdaterEvent: Codable {
    let type: String
    let state: SparkleUpdaterState?
    let update: SparkleUpdate?
    let error: SparkleUpdaterError?
    let userInitiated: Bool?
    let relaunchRequestID: String?

    init(
        type: String,
        state: SparkleUpdaterState?,
        update: SparkleUpdate?,
        error: SparkleUpdaterError?,
        userInitiated: Bool?,
        relaunchRequestID: String? = nil
    ) {
        self.type = type
        self.state = state
        self.update = update
        self.error = error
        self.userInitiated = userInitiated
        self.relaunchRequestID = relaunchRequestID
    }
}
