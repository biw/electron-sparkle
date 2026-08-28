import AppKit
import Foundation
import Sparkle

private enum SparkleBridgeError: LocalizedError {
    case notStarted

    var errorDescription: String? {
        switch self {
        case .notStarted:
            "The Sparkle updater has not been started. Call updater.start() after Electron is ready."
        }
    }
}

private struct PendingRelaunchRequest {
    let identifier: UUID
    let installHandler: () -> Void
}

@MainActor
private final class SparkleBridge: NSObject, SPUUpdaterDelegate {
    static let shared = SparkleBridge()

    private var controller: SPUStandardUpdaterController?
    private var stateObservations: [NSKeyValueObservation] = []
    private var streams: [UUID: AsyncStream<SparkleUpdaterEvent>.Continuation] = [:]
    private var reportedErrorKeys: Set<String> = []
    private var httpHeaders: [String: String]?
    private var relaunchPostponementEnabled = false
    private var pendingRelaunchRequest: PendingRelaunchRequest?

    private var updater: SPUUpdater? {
        controller?.updater
    }

    func start() {
        guard controller == nil else { return }

        let controller = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil,
        )
        self.controller = controller
        controller.updater.httpHeaders = httpHeaders
        observeState(for: controller.updater)
        controller.startUpdater()
        emitStateChanged()
    }

    func checkForUpdates() throws {
        guard let controller else { throw SparkleBridgeError.notStarted }
        controller.checkForUpdates(nil)
    }

    func checkForUpdatesInBackground() throws {
        guard let updater else { throw SparkleBridgeError.notStarted }
        updater.checkForUpdatesInBackground()
    }

    func setHTTPHeaders(_ headers: [String: String]) {
        httpHeaders = headers.isEmpty ? nil : headers
        updater?.httpHeaders = httpHeaders
    }

    func setRelaunchPostponementEnabled(_ enabled: Bool) {
        relaunchPostponementEnabled = enabled
    }

    func continueRelaunch(_ requestID: String) -> Bool {
        guard
            let pendingRelaunchRequest,
            pendingRelaunchRequest.identifier.uuidString == requestID
        else { return false }

        self.pendingRelaunchRequest = nil
        pendingRelaunchRequest.installHandler()
        return true
    }

    func state() -> SparkleUpdaterState {
        guard let updater else {
            return SparkleUpdaterState(
                started: false,
                canCheckForUpdates: false,
                sessionInProgress: false,
                automaticallyChecksForUpdates: false,
                automaticallyDownloadsUpdates: false,
            )
        }

        return SparkleUpdaterState(
            started: true,
            canCheckForUpdates: updater.canCheckForUpdates,
            sessionInProgress: updater.sessionInProgress,
            automaticallyChecksForUpdates: updater.automaticallyChecksForUpdates,
            automaticallyDownloadsUpdates: updater.automaticallyDownloadsUpdates,
        )
    }

    func setAutomaticallyChecksForUpdates(_ value: Bool) throws {
        guard let updater else { throw SparkleBridgeError.notStarted }
        updater.automaticallyChecksForUpdates = value
        emitStateChanged()
    }

    func setAutomaticallyDownloadsUpdates(_ value: Bool) throws {
        guard let updater else { throw SparkleBridgeError.notStarted }
        updater.automaticallyDownloadsUpdates = value
        emitStateChanged()
    }

    func eventStream() -> AsyncStream<SparkleUpdaterEvent> {
        AsyncStream { [weak self] continuation in
            guard let self else {
                continuation.finish()
                return
            }

            let identifier = UUID()
            streams[identifier] = continuation
            continuation.yield(SparkleUpdaterEvent(type: "state-changed", state: state(), update: nil, error: nil, userInitiated: nil))
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.streams.removeValue(forKey: identifier)
                }
            }
        }
    }

    private func observeState(for updater: SPUUpdater) {
        stateObservations = [
            updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in
                    self?.emitStateChanged()
                }
            },
            updater.observe(\.sessionInProgress, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in
                    self?.emitStateChanged()
                }
            },
            updater.observe(\.automaticallyChecksForUpdates, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in
                    self?.emitStateChanged()
                }
            },
            updater.observe(\.automaticallyDownloadsUpdates, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in
                    self?.emitStateChanged()
                }
            },
        ]
    }

    private func emitStateChanged() {
        emit(SparkleUpdaterEvent(type: "state-changed", state: state(), update: nil, error: nil, userInitiated: nil))
    }

    private func emit(_ event: SparkleUpdaterEvent) {
        for continuation in streams.values {
            continuation.yield(event)
        }
    }

    private func update(from item: SUAppcastItem) -> SparkleUpdate {
        let contentLength = item.contentLength <= UInt64(Int64.max) ? Int64(item.contentLength) : nil
        return SparkleUpdate(
            version: item.versionString,
            displayVersion: item.displayVersionString,
            title: item.title,
            fileURL: item.fileURL?.absoluteString,
            infoURL: item.infoURL?.absoluteString,
            releaseNotesURL: item.releaseNotesURL?.absoluteString,
            contentLength: contentLength,
            publicationDate: item.date?.description ?? item.dateString,
        )
    }

    private func updaterError(from error: Error) -> SparkleUpdaterError {
        let value = error as NSError
        return SparkleUpdaterError(domain: value.domain, code: value.code, message: value.localizedDescription)
    }

    private func isNoUpdateError(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == SUSparkleErrorDomain && value.code == Int(SUError.noUpdateError.rawValue)
    }

    private func emitUpdaterError(_ error: Error, update: SparkleUpdate? = nil) {
        guard !isNoUpdateError(error) else { return }

        let value = error as NSError
        let key = "\(value.domain):\(value.code):\(value.localizedDescription)"
        guard reportedErrorKeys.insert(key).inserted else { return }

        emit(SparkleUpdaterEvent(type: "error", state: state(), update: update, error: updaterError(from: error), userInitiated: nil))
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        emit(SparkleUpdaterEvent(type: "update-available", state: state(), update: update(from: item), error: nil, userInitiated: nil))
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        let value = error as NSError
        let userInitiated = value.userInfo[SPUNoUpdateFoundUserInitiatedKey] as? Bool
        emit(SparkleUpdaterEvent(type: "update-not-available", state: state(), update: nil, error: nil, userInitiated: userInitiated))
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        emit(SparkleUpdaterEvent(type: "update-downloaded", state: state(), update: update(from: item), error: nil, userInitiated: nil))
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        emit(SparkleUpdaterEvent(type: "before-install", state: state(), update: update(from: item), error: nil, userInitiated: nil))
    }

    func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        guard relaunchPostponementEnabled, pendingRelaunchRequest == nil else { return false }

        let identifier = UUID()
        pendingRelaunchRequest = PendingRelaunchRequest(
            identifier: identifier,
            installHandler: installHandler
        )
        emit(
            SparkleUpdaterEvent(
                type: "relaunch-requested",
                state: state(),
                update: update(from: item),
                error: nil,
                userInitiated: nil,
                relaunchRequestID: identifier.uuidString
            )
        )
        return true
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        emit(SparkleUpdaterEvent(type: "before-relaunch", state: state(), update: nil, error: nil, userInitiated: nil))
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        if let error {
            emitUpdaterError(error)
        }
        emit(SparkleUpdaterEvent(type: "cycle-complete", state: state(), update: nil, error: nil, userInitiated: nil))
        reportedErrorKeys.removeAll(keepingCapacity: true)
    }

    func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
        emitUpdaterError(error, update: update(from: item))
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        emitUpdaterError(error)
    }
}

// @swift-node:export
@MainActor
func start() {
    SparkleBridge.shared.start()
}

// @swift-node:export
@MainActor
func checkForUpdates() throws {
    try SparkleBridge.shared.checkForUpdates()
}

// @swift-node:export
@MainActor
func checkForUpdatesInBackground() throws {
    try SparkleBridge.shared.checkForUpdatesInBackground()
}

// @swift-node:export
@MainActor
func setHTTPHeaders(_ headers: [String: String]) {
    SparkleBridge.shared.setHTTPHeaders(headers)
}

// @swift-node:export
@MainActor
func setRelaunchPostponementEnabled(_ enabled: Bool) {
    SparkleBridge.shared.setRelaunchPostponementEnabled(enabled)
}

// @swift-node:export
@MainActor
func continueRelaunch(_ requestID: String) -> Bool {
    SparkleBridge.shared.continueRelaunch(requestID)
}

// @swift-node:export
@MainActor
func getState() -> SparkleUpdaterState {
    SparkleBridge.shared.state()
}

// @swift-node:export
@MainActor
func setAutomaticallyChecksForUpdates(_ value: Bool) throws {
    try SparkleBridge.shared.setAutomaticallyChecksForUpdates(value)
}

// @swift-node:export
@MainActor
func setAutomaticallyDownloadsUpdates(_ value: Bool) throws {
    try SparkleBridge.shared.setAutomaticallyDownloadsUpdates(value)
}

// @swift-node:export
// @swift-node:stream
func events() -> AsyncStream<SparkleUpdaterEvent> {
    AsyncStream { continuation in
        let task = Task { @MainActor in
            let source = SparkleBridge.shared.eventStream()
            for await event in source {
                if Task.isCancelled { break }
                continuation.yield(event)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in
            task.cancel()
        }
    }
}
