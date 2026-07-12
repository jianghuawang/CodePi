import Foundation

/// Typed mirrors of the persisted-state slice of `src/shared/contracts.ts`.
/// Every type builds its own JSONValue payload so field presence/absence
/// matches the Electron main process byte for byte (optionals are omitted,
/// never null). Normalizers replicate `state-store.ts` rules exactly.

public func nowMilliseconds() -> Double {
  (Date().timeIntervalSince1970 * 1000).rounded()
}

public struct WorktreeRecord: Sendable, Equatable {
  public var path: String
  public var branch: String
  public var baseBranch: String
  public var baseCommit: String

  public var payload: JSONValue {
    .object([
      "path": .string(path),
      "branch": .string(branch),
      "baseBranch": .string(baseBranch),
      "baseCommit": .string(baseCommit)
    ])
  }
}

public struct ThreadUsageSnapshot: Sendable, Equatable {
  public var sessionId: String
  public var tokens: Double
  public var cost: Double

  public var payload: JSONValue {
    .object(["sessionId": .string(sessionId), "tokens": .number(tokens), "cost": .number(cost)])
  }
}

public struct ProjectRecord: Sendable, Equatable {
  public var id: String
  public var name: String
  public var path: String
  public var isGit: Bool
  public var expanded: Bool
  public var createdAt: Double

  public init(id: String, name: String, path: String, isGit: Bool, expanded: Bool, createdAt: Double) {
    self.id = id
    self.name = name
    self.path = path
    self.isGit = isGit
    self.expanded = expanded
    self.createdAt = createdAt
  }

  public var payload: JSONValue {
    .object([
      "id": .string(id),
      "name": .string(name),
      "path": .string(path),
      "isGit": .bool(isGit),
      "expanded": .bool(expanded),
      "createdAt": .number(createdAt)
    ])
  }
}

public struct ThreadRecord: Sendable, Equatable {
  public var id: String
  public var projectId: String
  public var title: String
  public var cwd: String
  public var status: String
  public var createdAt: Double
  public var updatedAt: Double
  public var sessionFile: String?
  public var lastError: String?
  public var worktree: WorktreeRecord?
  public var pinned: Bool
  public var archived: Bool
  public var unread: Bool
  public var tags: [String]
  public var deletedAt: Double?
  public var disabledCapabilityIds: [String]
  public var autoRetryEnabled: Bool
  public var usageSnapshot: ThreadUsageSnapshot?

  public init(
    id: String,
    projectId: String,
    title: String,
    cwd: String,
    status: String = "idle",
    createdAt: Double,
    updatedAt: Double,
    sessionFile: String? = nil,
    lastError: String? = nil,
    worktree: WorktreeRecord? = nil,
    pinned: Bool = false,
    archived: Bool = false,
    unread: Bool = false,
    tags: [String] = [],
    deletedAt: Double? = nil,
    disabledCapabilityIds: [String] = [],
    autoRetryEnabled: Bool = true,
    usageSnapshot: ThreadUsageSnapshot? = nil
  ) {
    self.id = id
    self.projectId = projectId
    self.title = title
    self.cwd = cwd
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.sessionFile = sessionFile
    self.lastError = lastError
    self.worktree = worktree
    self.pinned = pinned
    self.archived = archived
    self.unread = unread
    self.tags = tags
    self.deletedAt = deletedAt
    self.disabledCapabilityIds = disabledCapabilityIds
    self.autoRetryEnabled = autoRetryEnabled
    self.usageSnapshot = usageSnapshot
  }

  public var payload: JSONValue {
    var object: [String: JSONValue] = [
      "id": .string(id),
      "projectId": .string(projectId),
      "title": .string(title),
      "cwd": .string(cwd),
      "status": .string(status),
      "createdAt": .number(createdAt),
      "updatedAt": .number(updatedAt),
      "pinned": .bool(pinned),
      "archived": .bool(archived),
      "unread": .bool(unread),
      "tags": .array(tags.map(JSONValue.string)),
      "disabledCapabilityIds": .array(disabledCapabilityIds.map(JSONValue.string)),
      "autoRetryEnabled": .bool(autoRetryEnabled)
    ]
    if let sessionFile { object["sessionFile"] = .string(sessionFile) }
    if let lastError { object["lastError"] = .string(lastError) }
    if let worktree { object["worktree"] = worktree.payload }
    if let deletedAt { object["deletedAt"] = .number(deletedAt) }
    if let usageSnapshot { object["usageSnapshot"] = usageSnapshot.payload }
    return .object(object)
  }
}

public struct PromptTemplate: Sendable, Equatable {
  public var id: String
  public var title: String
  public var prompt: String
  public var createdAt: Double
  public var updatedAt: Double

  public var payload: JSONValue {
    .object([
      "id": .string(id),
      "title": .string(title),
      "prompt": .string(prompt),
      "createdAt": .number(createdAt),
      "updatedAt": .number(updatedAt)
    ])
  }
}

public struct UsageLedgerEntry: Sendable, Equatable {
  public var id: String
  public var projectId: String
  public var threadId: String
  public var timestamp: Double
  public var tokens: Double
  public var cost: Double

  public var payload: JSONValue {
    .object([
      "id": .string(id),
      "projectId": .string(projectId),
      "threadId": .string(threadId),
      "timestamp": .number(timestamp),
      "tokens": .number(tokens),
      "cost": .number(cost)
    ])
  }
}

public struct AppSettings: Sendable, Equatable {
  public var piPath: String
  public var defaultModel: String
  public var theme: String
  public var env: [String: String]

  public init(piPath: String = "pi", defaultModel: String = "", theme: String = "system", env: [String: String] = [:]) {
    self.piPath = piPath
    self.defaultModel = defaultModel
    self.theme = theme
    self.env = env
  }

  public var payload: JSONValue {
    .object([
      "piPath": .string(piPath),
      "defaultModel": .string(defaultModel),
      "theme": .string(theme),
      "env": .object(env.mapValues(JSONValue.string))
    ])
  }
}

public struct WindowBounds: Sendable, Equatable {
  public var width: Double
  public var height: Double
  public var x: Double?
  public var y: Double?

  public static let `default` = WindowBounds(width: 1240, height: 820)

  public var payload: JSONValue {
    var object: [String: JSONValue] = ["width": .number(width), "height": .number(height)]
    if let x { object["x"] = .number(x) }
    if let y { object["y"] = .number(y) }
    return .object(object)
  }
}

public struct PersistedState: Sendable, Equatable {
  public var projects: [ProjectRecord] = []
  public var threads: [ThreadRecord] = []
  public var promptLibrary: [PromptTemplate] = []
  public var usageLedger: [UsageLedgerEntry] = []
  public var selectedThreadId: String?
  public var windowBounds: WindowBounds = .default
  public var settings = AppSettings()
  public var dismissedSessionFiles: [String] = []

  public init() {}

  /// Full payload as written to state.json (schema v2, internal fields kept).
  public var diskPayload: JSONValue {
    var object: [String: JSONValue] = [
      "version": .number(2),
      "projects": .array(projects.map(\.payload)),
      "threads": .array(threads.map(\.payload)),
      "promptLibrary": .array(promptLibrary.map(\.payload)),
      "usageLedger": .array(usageLedger.map(\.payload)),
      "windowBounds": windowBounds.payload,
      "settings": settings.payload,
      "dismissedSessionFiles": .array(dismissedSessionFiles.map(JSONValue.string))
    ]
    if let selectedThreadId { object["selectedThreadId"] = .string(selectedThreadId) }
    return .object(object)
  }

  /// Renderer payload: settings env values and dismissed-session bookkeeping
  /// never cross into the web view (mirrors `publicState()`).
  public var publicPayload: JSONValue {
    var sanitized = self
    sanitized.settings.env = [:]
    guard var object = sanitized.diskPayload.objectValue else { return sanitized.diskPayload }
    object.removeValue(forKey: "dismissedSessionFiles")
    if var settingsObject = object["settings"]?.objectValue {
      settingsObject["env"] = .object([:])
      object["settings"] = .object(settingsObject)
    }
    return .object(object)
  }
}

// MARK: - Normalization (state-store.ts parity)

public enum StateNormalizer {
  public static func normalize(_ value: JSONValue?) -> PersistedState {
    let record = value?.objectValue ?? [:]
    var state = PersistedState()
    state.projects = (record["projects"]?.arrayValue ?? []).compactMap(normalizeProject)
    let projectIds = Set(state.projects.map(\.id))
    state.threads = (record["threads"]?.arrayValue ?? [])
      .compactMap(normalizeThread)
      .filter { projectIds.contains($0.projectId) }
    state.promptLibrary = Array((record["promptLibrary"]?.arrayValue ?? []).compactMap(normalizePrompt).prefix(500))
    state.usageLedger = Array((record["usageLedger"]?.arrayValue ?? []).compactMap(normalizeUsage).suffix(20_000))
    state.selectedThreadId = record["selectedThreadId"]?.stringValue
    state.windowBounds = normalizeBounds(record["windowBounds"])
    state.settings = normalizeSettings(record["settings"])
    state.dismissedSessionFiles = (record["dismissedSessionFiles"]?.arrayValue ?? []).compactMap(\.stringValue)
    return state
  }

  static func normalizeBounds(_ value: JSONValue?) -> WindowBounds {
    let record = value?.objectValue ?? [:]
    let width = min(6000, max(900, record["width"]?.numberValue ?? WindowBounds.default.width))
    let height = min(4000, max(620, record["height"]?.numberValue ?? WindowBounds.default.height))
    return WindowBounds(width: width, height: height, x: record["x"]?.numberValue, y: record["y"]?.numberValue)
  }

  public static func normalizeSettings(_ value: JSONValue?) -> AppSettings {
    let record = value?.objectValue ?? [:]
    let theme = record["theme"]?.stringValue
    var env: [String: String] = [:]
    for (key, item) in record["env"]?.objectValue ?? [:] {
      if key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil, let text = item.stringValue {
        env[key] = text
      }
    }
    let piPath = record["piPath"]?.stringValue
    return AppSettings(
      piPath: piPath?.isEmpty == false ? piPath! : "pi",
      defaultModel: record["defaultModel"]?.stringValue ?? "",
      theme: theme == "light" || theme == "dark" ? theme! : "system",
      env: env
    )
  }

  static func normalizeProject(_ value: JSONValue) -> ProjectRecord? {
    guard
      let record = value.objectValue,
      let id = record["id"]?.stringValue,
      let name = record["name"]?.stringValue,
      let path = record["path"]?.stringValue,
      let isGit = record["isGit"]?.boolValue
    else { return nil }
    return ProjectRecord(
      id: id,
      name: name,
      path: path,
      isGit: isGit,
      expanded: record["expanded"]?.boolValue != false,
      createdAt: record["createdAt"]?.numberValue ?? nowMilliseconds()
    )
  }

  static func normalizeThread(_ value: JSONValue) -> ThreadRecord? {
    guard
      let record = value.objectValue,
      let id = record["id"]?.stringValue,
      let projectId = record["projectId"]?.stringValue,
      let title = record["title"]?.stringValue,
      let cwd = record["cwd"]?.stringValue
    else { return nil }
    var worktree: WorktreeRecord?
    if
      let raw = record["worktree"]?.objectValue,
      let path = raw["path"]?.stringValue,
      let branch = raw["branch"]?.stringValue,
      let baseBranch = raw["baseBranch"]?.stringValue,
      let baseCommit = raw["baseCommit"]?.stringValue
    {
      worktree = WorktreeRecord(path: path, branch: branch, baseBranch: baseBranch, baseCommit: baseCommit)
    }
    var snapshot: ThreadUsageSnapshot?
    if
      let raw = record["usageSnapshot"]?.objectValue,
      let sessionId = raw["sessionId"]?.stringValue,
      let tokens = raw["tokens"]?.numberValue,
      let cost = raw["cost"]?.numberValue
    {
      snapshot = ThreadUsageSnapshot(sessionId: sessionId, tokens: max(0, tokens), cost: max(0, cost))
    }
    return ThreadRecord(
      id: id,
      projectId: projectId,
      title: title,
      cwd: cwd,
      status: record["status"]?.stringValue == "error" ? "error" : "idle",
      createdAt: record["createdAt"]?.numberValue ?? nowMilliseconds(),
      updatedAt: record["updatedAt"]?.numberValue ?? nowMilliseconds(),
      sessionFile: record["sessionFile"]?.stringValue,
      lastError: record["lastError"]?.stringValue,
      worktree: worktree,
      pinned: record["pinned"]?.boolValue == true,
      archived: record["archived"]?.boolValue == true,
      unread: record["unread"]?.boolValue == true,
      tags: uniqueStrings(record["tags"], limit: 24).map { String($0.prefix(48)) },
      deletedAt: record["deletedAt"]?.numberValue,
      disabledCapabilityIds: uniqueStrings(record["disabledCapabilityIds"], limit: 2_000),
      autoRetryEnabled: record["autoRetryEnabled"]?.boolValue != false,
      usageSnapshot: snapshot
    )
  }

  static func normalizePrompt(_ value: JSONValue) -> PromptTemplate? {
    guard
      let record = value.objectValue,
      let id = record["id"]?.stringValue,
      let title = record["title"]?.stringValue,
      let prompt = record["prompt"]?.stringValue
    else { return nil }
    return PromptTemplate(
      id: id,
      title: String(title.prefix(120)),
      prompt: String(prompt.prefix(200_000)),
      createdAt: record["createdAt"]?.numberValue ?? nowMilliseconds(),
      updatedAt: record["updatedAt"]?.numberValue ?? nowMilliseconds()
    )
  }

  static func normalizeUsage(_ value: JSONValue) -> UsageLedgerEntry? {
    guard
      let record = value.objectValue,
      let id = record["id"]?.stringValue,
      let projectId = record["projectId"]?.stringValue,
      let threadId = record["threadId"]?.stringValue
    else { return nil }
    return UsageLedgerEntry(
      id: id,
      projectId: projectId,
      threadId: threadId,
      timestamp: record["timestamp"]?.numberValue ?? nowMilliseconds(),
      tokens: max(0, record["tokens"]?.numberValue ?? 0),
      cost: max(0, record["cost"]?.numberValue ?? 0)
    )
  }

  private static func uniqueStrings(_ value: JSONValue?, limit: Int) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for item in value?.arrayValue ?? [] {
      guard let text = item.stringValue, !text.isEmpty, seen.insert(text).inserted else { continue }
      result.append(text)
      if result.count >= limit { break }
    }
    return result
  }
}

extension JSONValue {
  public var numberValue: Double? {
    if case .number(let value) = self, value.isFinite { return value }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }
}
