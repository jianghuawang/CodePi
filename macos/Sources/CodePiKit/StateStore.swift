import Foundation

/// Port of `state-store.ts`: owns state.json with debounced, atomic,
/// serialized writes. All access happens on the main actor; the actual disk
/// write runs off-main through a chained background task.
@MainActor
public final class StateStore {
  public let fileURL: URL
  private var state: PersistedState
  private var saveScheduled = false
  private var writeChain: Task<Void, Never> = Task {}

  private init(fileURL: URL, state: PersistedState) {
    self.fileURL = fileURL
    self.state = state
  }

  public static func open(directory: URL) throws -> StateStore {
    let fileURL = directory.appendingPathComponent("state.json")
    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
      return StateStore(fileURL: fileURL, state: PersistedState())
    } catch {
      throw BridgeError("CodePi could not read its state file at \(fileURL.path): \(error.localizedDescription)")
    }
    guard let raw = String(data: data, encoding: .utf8), let value = try? JSONValue.parse(raw) else {
      let stamp = ISO8601DateFormatter().string(from: Date())
        .replacingOccurrences(of: ":", with: "-")
        .replacingOccurrences(of: ".", with: "-")
      let backup = fileURL.appendingPathExtension("corrupt-\(stamp).bak")
      try? FileManager.default.copyItem(at: fileURL, to: backup)
      throw BridgeError("CodePi state is not valid JSON. The original was preserved and copied to \(backup.path).")
    }
    if let version = value.objectValue?["version"]?.numberValue, version > 2 {
      throw BridgeError("CodePi state version \(Int(version)) is newer than this app supports")
    }
    if value.objectValue?["version"]?.numberValue == 1 {
      let backup = fileURL.appendingPathExtension("v1.bak")
      if !FileManager.default.fileExists(atPath: backup.path) {
        try? FileManager.default.copyItem(at: fileURL, to: backup)
      }
    }
    return StateStore(fileURL: fileURL, state: StateNormalizer.normalize(value))
  }

  public func snapshot() -> PersistedState {
    state
  }

  public func thread(_ threadId: String) throws -> ThreadRecord {
    guard let thread = state.threads.first(where: { $0.id == threadId }) else {
      throw BridgeError("Thread not found")
    }
    return thread
  }

  public func project(_ projectId: String) throws -> ProjectRecord {
    guard let project = state.projects.first(where: { $0.id == projectId }) else {
      throw BridgeError("Project not found")
    }
    return project
  }

  public func update(_ mutator: (inout PersistedState) throws -> Void) rethrows {
    try mutator(&state)
    scheduleSave()
  }

  private func scheduleSave() {
    guard !saveScheduled else { return }
    saveScheduled = true
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 180_000_000)
      guard let self else { return }
      self.saveScheduled = false
      self.enqueueWrite()
    }
  }

  private func enqueueWrite() {
    let serialized = state.diskPayload.prettyJSONString() + "\n"
    let target = fileURL
    let previous = writeChain
    writeChain = Task.detached(priority: .utility) {
      await previous.value
      do {
        try Self.atomicWrite(serialized, to: target)
      } catch {
        // Matches the Electron behavior: a failed save is logged, not fatal.
        FileHandle.standardError.write(Data("CodePi could not save application state: \(error)\n".utf8))
      }
    }
  }

  nonisolated static func atomicWrite(_ contents: String, to target: URL) throws {
    let directory = target.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let temp = directory.appendingPathComponent("\(target.lastPathComponent).\(ProcessInfo.processInfo.processIdentifier).\(UInt64(Date().timeIntervalSince1970 * 1000)).tmp")
    defer { try? FileManager.default.removeItem(at: temp) }
    try Data(contents.utf8).write(to: temp, options: [])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
    _ = try FileManager.default.replaceItemAt(target, withItemAt: temp)
  }

  public func flush() async {
    if saveScheduled {
      saveScheduled = false
      enqueueWrite()
    }
    await writeChain.value
  }
}

extension JSONValue {
  /// Pretty two-space output for state.json readability, matching the intent
  /// of `JSON.stringify(state, null, 2)` (key order differs; parsers agree).
  public func prettyJSONString() -> String {
    let data = try? JSONSerialization.data(
      withJSONObject: anyRepresentation,
      options: [.fragmentsAllowed, .sortedKeys, .prettyPrinted]
    )
    guard let data, let text = String(data: data, encoding: .utf8) else { return "null" }
    return text
  }

  private var anyRepresentation: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let value): return value
    case .number(let value): return value
    case .string(let value): return value
    case .array(let value): return value.map(\.anyRepresentation)
    case .object(let value): return value.mapValues(\.anyRepresentation)
    }
  }
}
