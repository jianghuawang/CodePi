import Foundation

/// Port of `pi-manager.ts`: one PiRpcClient per open thread, status/state
/// bookkeeping in the StateStore, and normalized `ThreadEvent` payloads for
/// the renderer.
@MainActor
public final class PiProcessManager {
  private let store: StateStore
  private let emit: (JSONValue) -> Void
  private var clients: [String: PiRpcClient] = [:]
  private var opening: [String: (token: UUID, task: Task<JSONValue, Error>)] = [:]

  /// Supplies extra spawn args per thread (capability opt-in flags).
  public var spawnArgsProvider: (@MainActor (ThreadRecord, AppSettings) async -> [String])?

  public init(store: StateStore, emit: @escaping (JSONValue) -> Void) {
    self.store = store
    self.emit = emit
  }

  public func has(_ threadId: String) -> Bool {
    clients[threadId] != nil
  }

  // MARK: - Prompt assembly (buildPrompt + attachment-context parity)

  static func attachedTextBlock(name: String, text: String) -> String {
    let safeName = String(
      name
        .replacingOccurrences(of: "[\r\n`]", with: " ", options: .regularExpression)
        .prefix(240)
    )
    return "Attached file `\(safeName)`:\n\n```text\n\(text)\n```"
  }

  static func attachedPathBlock(path: String) -> String {
    "Attached file path: `\(path.replacingOccurrences(of: "`", with: "\\`"))`"
  }

  static func buildPrompt(message: String, attachments: [JSONValue]) -> (message: String, images: [JSONValue]) {
    var images: [JSONValue] = []
    var context: [String] = []
    for attachment in attachments {
      guard let object = attachment.objectValue else { continue }
      let kind = object["kind"]?.stringValue
      if kind == "image", let data = object["data"]?.stringValue {
        let stripped = data.replacingOccurrences(of: "^data:[^;]+;base64,", with: "", options: .regularExpression)
        var image: [String: JSONValue] = ["type": .string("image"), "data": .string(stripped)]
        if let mime = object["mimeType"] { image["mimeType"] = mime }
        images.append(.object(image))
        continue
      }
      if kind == "text", let text = object["text"]?.stringValue {
        context.append(attachedTextBlock(name: object["name"]?.stringValue ?? "attachment", text: text))
        continue
      }
      if let path = object["path"]?.stringValue {
        context.append(attachedPathBlock(path: path))
      }
    }
    let full = context.isEmpty ? message : message + "\n\n" + context.joined(separator: "\n\n")
    return (full, images)
  }

  // MARK: - Lifecycle

  public func open(_ threadId: String) async throws -> JSONValue {
    if let pending = opening[threadId] {
      return try await pending.task.value
    }
    let token = UUID()
    let task = Task<JSONValue, Error> { @MainActor in
      try await self.openOnce(threadId)
    }
    opening[threadId] = (token, task)
    defer {
      if opening[threadId]?.token == token { opening.removeValue(forKey: threadId) }
    }
    return try await task.value
  }

  private func openOnce(_ threadId: String) async throws -> JSONValue {
    let thread = try store.thread(threadId)
    var client = clients[threadId]
    if client == nil {
      let settings = store.snapshot().settings
      let extraArgs = await spawnArgsProvider?(thread, settings) ?? []
      let created = PiRpcClient(options: PiRpcClientOptions(
        piPath: settings.piPath,
        cwd: thread.cwd,
        env: PiEnvironment.environmentForPi(settings.env),
        session: thread.sessionFile,
        model: thread.sessionFile == nil && !settings.defaultModel.isEmpty ? settings.defaultModel : nil,
        requestTimeout: 30,
        extraArgs: extraArgs
      ))
      attach(threadId: threadId, client: created)
      clients[threadId] = created
      setStatus(threadId, status: "waiting")
      do {
        try created.start()
      } catch {
        clients.removeValue(forKey: threadId)
        await created.stop()
        setStatus(threadId, status: "error", error: errorText(error))
        throw error
      }
      client = created
    }
    guard let client else { throw BridgeError("Pi process did not start") }

    do {
      let state = try await client.getState()
      let messages = try await client.getMessages()
      let models = try await client.getAvailableModels()
      let history = try await client.getTree()
      let commands = (try? await client.getCommands()) ?? .array([])
      let stats = try? await client.getSessionStats()

      var stateObject = state.objectValue ?? [:]
      stateObject["autoRetryEnabled"] = .bool(thread.autoRetryEnabled)
      let isStreaming = stateObject["isStreaming"]?.boolValue == true
      let sessionFile = stateObject["sessionFile"]?.stringValue
      let sessionId = stateObject["sessionId"]?.stringValue

      store.update { persisted in
        guard let index = persisted.threads.firstIndex(where: { $0.id == threadId }) else { return }
        persisted.threads[index].status = isStreaming ? "running" : "idle"
        persisted.threads[index].lastError = nil
        if let sessionFile { persisted.threads[index].sessionFile = sessionFile }
        if let stats = stats?.objectValue {
          let statsSessionId = stats["sessionId"]?.stringValue ?? sessionId ?? threadId
          if persisted.threads[index].usageSnapshot?.sessionId != statsSessionId {
            persisted.threads[index].usageSnapshot = ThreadUsageSnapshot(
              sessionId: statsSessionId,
              tokens: stats["tokens"]?.objectValue?["total"]?.numberValue ?? 0,
              cost: stats["cost"]?.numberValue ?? 0
            )
          }
        }
      }
      let current = try store.thread(threadId)
      emit(threadEventPayload(["type": .string("status"), "threadId": .string(threadId), "status": .string(current.status)]))
      var result: [String: JSONValue] = [
        "thread": current.payload,
        "state": .object(stateObject),
        "messages": messages,
        "models": models,
        "tree": history.tree,
        "commands": commands
      ]
      if let stats { result["stats"] = stats }
      return .object(result)
    } catch {
      let stderr = client.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
      let message = stderr.isEmpty ? errorText(error) : String(stderr.suffix(4_000))
      setStatus(threadId, status: "error", error: message)
      throw BridgeError(message)
    }
  }

  public func restart(_ threadId: String) async throws -> JSONValue {
    await close(threadId)
    return try await open(threadId)
  }

  public func send(_ threadId: String, message: String, mode: String, attachments: [JSONValue]) async throws {
    let client = try await ensureClient(threadId)
    let prompt = Self.buildPrompt(message: message, attachments: attachments)
    store.update { state in
      guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else { return }
      state.threads[index].updatedAt = nowMilliseconds()
    }
    switch mode {
    case "steer": try await client.steer(prompt.message, images: prompt.images)
    case "followUp": try await client.followUp(prompt.message, images: prompt.images)
    default: try await client.prompt(prompt.message, images: prompt.images)
    }
  }

  public func abort(_ threadId: String) async throws {
    if let client = clients[threadId] { try await client.abort() }
  }

  public func setModel(_ threadId: String, provider: String, modelId: String) async throws -> JSONValue {
    try await ensureClient(threadId).setModel(provider: provider, modelId: modelId)
  }

  public func setThinkingLevel(_ threadId: String, level: String) async throws -> JSONValue {
    try await ensureClient(threadId).setThinkingLevel(level)
    return .string(level)
  }

  public func commands(_ threadId: String) async throws -> JSONValue {
    try await ensureClient(threadId).getCommands()
  }

  public func compact(_ threadId: String, customInstructions: String?) async throws -> JSONValue {
    let client = try await ensureClient(threadId)
    let state = try await client.getState()
    if state.objectValue?["isStreaming"]?.boolValue == true {
      throw BridgeError("Stop the running turn before compacting context")
    }
    try await client.compact(customInstructions: customInstructions)
    return (try? await client.getSessionStats()) ?? .null
  }

  public func setAutoCompaction(_ threadId: String, enabled: Bool) async throws -> JSONValue {
    let client = try await ensureClient(threadId)
    try await client.setAutoCompaction(enabled)
    for (id, sibling) in clients where id != threadId {
      try? await sibling.setAutoCompaction(enabled)
    }
    let state = try? await client.getState()
    return state?.objectValue?["autoCompactionEnabled"] ?? .bool(enabled)
  }

  public func setAutoRetry(_ threadId: String, enabled: Bool) async throws -> JSONValue {
    let client = try await ensureClient(threadId)
    try await client.setAutoRetry(enabled)
    for (id, sibling) in clients where id != threadId {
      try? await sibling.setAutoRetry(enabled)
    }
    store.update { state in
      for index in state.threads.indices {
        state.threads[index].autoRetryEnabled = enabled
      }
    }
    return .bool(enabled)
  }

  public func setSessionName(_ threadId: String, name: String) async {
    guard let client = clients[threadId] else { return }
    try? await client.setSessionName(name)
  }

  public func messages(_ threadId: String) async throws -> JSONValue {
    try await ensureClient(threadId).getMessages()
  }

  public func history(_ threadId: String) async throws -> JSONValue {
    let client = try await ensureClient(threadId)
    let history = try await client.getTree()
    return .object(["tree": history.tree, "leafId": history.leafId])
  }

  public func close(_ threadId: String) async {
    _ = try? await opening[threadId]?.task.value
    guard let client = clients.removeValue(forKey: threadId) else { return }
    await client.stop()
    if (try? store.thread(threadId)) != nil {
      setStatus(threadId, status: "idle")
    }
  }

  public func stopAll() async {
    for entry in opening.values { _ = try? await entry.task.value }
    let all = clients.values
    clients.removeAll()
    opening.removeAll()
    for client in all { await client.stop() }
  }

  private func ensureClient(_ threadId: String) async throws -> PiRpcClient {
    _ = try? await opening[threadId]?.task.value
    if let existing = clients[threadId] { return existing }
    _ = try await open(threadId)
    guard let client = clients[threadId] else { throw BridgeError("Pi process did not start") }
    return client
  }

  // MARK: - Event mapping

  private func threadEventPayload(_ fields: [String: JSONValue]) -> JSONValue {
    .object(fields)
  }

  private func setStatus(_ threadId: String, status: String, error: String? = nil) {
    store.update { state in
      guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else { return }
      state.threads[index].status = status
      state.threads[index].lastError = error
    }
    var payload: [String: JSONValue] = [
      "type": .string("status"),
      "threadId": .string(threadId),
      "status": .string(status)
    ]
    if let error { payload["error"] = .string(error) }
    emit(threadEventPayload(payload))
  }

  private func attach(threadId: String, client: PiRpcClient) {
    client.onEvent = { [weak self, weak client] event in
      guard let self else { return }
      let id = JSONValue.string(threadId)
      switch event {
      case .agentStart:
        self.setStatus(threadId, status: "running")
        self.emit(.object(["type": .string("agent-start"), "threadId": id]))
      case .textDelta(let delta, let contentIndex):
        self.emit(.object(["type": .string("text-delta"), "threadId": id, "delta": .string(delta), "contentIndex": contentIndex]))
      case .thinkingDelta(let delta, let contentIndex):
        self.emit(.object(["type": .string("thinking-delta"), "threadId": id, "delta": .string(delta), "contentIndex": contentIndex]))
      case .toolCallStart(let toolCallId, let toolName, let contentIndex):
        var payload: [String: JSONValue] = ["type": .string("tool-call-start"), "threadId": id]
        if toolCallId != .null { payload["toolCallId"] = toolCallId }
        if toolName != .null { payload["toolName"] = toolName }
        if contentIndex != .null { payload["contentIndex"] = contentIndex }
        self.emit(.object(payload))
      case .toolCallArgs(let toolCallId, let toolName, let delta, let contentIndex):
        var payload: [String: JSONValue] = ["type": .string("tool-call-args"), "threadId": id, "delta": .string(delta)]
        if toolCallId != .null { payload["toolCallId"] = toolCallId }
        if toolName != .null { payload["toolName"] = toolName }
        if contentIndex != .null { payload["contentIndex"] = contentIndex }
        self.emit(.object(payload))
      case .toolCallEnd(let toolCallId, let toolName, let args, let contentIndex):
        var payload: [String: JSONValue] = [
          "type": .string("tool-call-end"),
          "threadId": id,
          "toolCallId": .string(toolCallId),
          "toolName": .string(toolName),
          "args": args
        ]
        if contentIndex != .null { payload["contentIndex"] = contentIndex }
        self.emit(.object(payload))
      case .toolExecutionStart(let toolCallId, let toolName):
        self.emit(.object([
          "type": .string("tool-call-start"),
          "threadId": id,
          "toolCallId": .string(toolCallId),
          "toolName": .string(toolName)
        ]))
      case .toolOutput(let toolCallId, let toolName, let output, let isError, let complete):
        var payload: [String: JSONValue] = [
          "type": .string("tool-output"),
          "threadId": id,
          "toolCallId": .string(toolCallId),
          "toolName": .string(toolName),
          "output": .string(output),
          "complete": .bool(complete)
        ]
        if isError { payload["isError"] = .bool(true) }
        self.emit(.object(payload))
      case .messageEnd(let message):
        self.emit(.object(["type": .string("message-end"), "threadId": id, "message": message]))
      case .turnEnd(let message, let toolResults):
        self.store.update { state in
          guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else { return }
          state.threads[index].updatedAt = nowMilliseconds()
        }
        self.emit(.object(["type": .string("turn-end"), "threadId": id, "message": message, "toolResults": toolResults]))
      case .queue(let steering, let followUp):
        self.emit(.object(["type": .string("queue"), "threadId": id, "steering": steering, "followUp": followUp]))
      case .aborted:
        self.setStatus(threadId, status: "idle")
        self.emit(.object(["type": .string("aborted"), "threadId": id]))
      case .agentSettled:
        guard let client else { return }
        self.settleAfterDelay(threadId: threadId, client: client)
      case .error(let message, let recoverable):
        self.emit(.object([
          "type": .string("error"),
          "threadId": id,
          "message": .string(message),
          "recoverable": .bool(recoverable)
        ]))
      case .processCrash(let detail, let stderr):
        if self.clients[threadId] === client { self.clients.removeValue(forKey: threadId) }
        let trimmed = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = trimmed.isEmpty
          ? "Pi stopped unexpectedly (\(detail))"
          : "Pi stopped unexpectedly: \(String(trimmed.suffix(2_000)))"
        self.setStatus(threadId, status: "error", error: message)
      }
    }
  }

  private func settleAfterDelay(threadId: String, client: PiRpcClient) {
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 200_000_000)
      guard let self, self.clients[threadId] === client else { return }
      let currentState = try? await client.getState()
      let stats = try? await client.getSessionStats()
      guard self.clients[threadId] === client else { return }
      let stateObject = currentState?.objectValue
      let statsObject = stats?.objectValue
      let sessionFile = statsObject?["sessionFile"]?.stringValue ?? stateObject?["sessionFile"]?.stringValue
      self.store.update { state in
        guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else { return }
        var thread = state.threads[index]
        if let sessionFile { thread.sessionFile = sessionFile }
        thread.updatedAt = nowMilliseconds()
        thread.unread = state.selectedThreadId != threadId
        if let statsObject {
          let statsSessionId = statsObject["sessionId"]?.stringValue ?? stateObject?["sessionId"]?.stringValue
          let sameSession = thread.usageSnapshot?.sessionId == statsSessionId
          let totalTokens = statsObject["tokens"]?.objectValue?["total"]?.numberValue ?? 0
          let totalCost = statsObject["cost"]?.numberValue ?? 0
          let tokens = max(0, totalTokens - (sameSession ? thread.usageSnapshot?.tokens ?? 0 : 0))
          let cost = max(0, totalCost - (sameSession ? thread.usageSnapshot?.cost ?? 0 : 0))
          if tokens > 0 || cost > 0 {
            state.usageLedger.append(UsageLedgerEntry(
              id: UUID().uuidString.lowercased(),
              projectId: thread.projectId,
              threadId: threadId,
              timestamp: nowMilliseconds(),
              tokens: tokens,
              cost: cost
            ))
            if state.usageLedger.count > 20_000 {
              state.usageLedger.removeFirst(state.usageLedger.count - 20_000)
            }
          }
          thread.usageSnapshot = ThreadUsageSnapshot(
            sessionId: statsSessionId ?? threadId,
            tokens: totalTokens,
            cost: totalCost
          )
        }
        state.threads[index] = thread
      }
      // Older Pi versions only emit agent_end; skip the idle transition when a
      // retry or compaction is already under way.
      if stateObject?["isStreaming"]?.boolValue == true || stateObject?["isCompacting"]?.boolValue == true {
        return
      }
      self.setStatus(threadId, status: "idle")
      var payload: [String: JSONValue] = ["type": .string("settled"), "threadId": .string(threadId)]
      if let stats { payload["stats"] = stats }
      self.emit(.object(payload))
    }
  }

  private func errorText(_ error: Error) -> String {
    (error as? BridgeError)?.message ?? error.localizedDescription
  }
}
