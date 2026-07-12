import Foundation

/// Normalized client events, mirroring the `PiRpcClientEventMap` surface that
/// `pi-manager.ts` consumes. Message payloads stay as JSONValue pass-throughs
/// (bounded by `MessageLimits`) exactly like the Electron client.
public enum PiClientEvent: Sendable {
  case agentStart
  case textDelta(delta: String, contentIndex: JSONValue)
  case thinkingDelta(delta: String, contentIndex: JSONValue)
  case toolCallStart(toolCallId: JSONValue, toolName: JSONValue, contentIndex: JSONValue)
  case toolCallArgs(toolCallId: JSONValue, toolName: JSONValue, delta: String, contentIndex: JSONValue)
  case toolCallEnd(toolCallId: String, toolName: String, args: JSONValue, contentIndex: JSONValue)
  case toolExecutionStart(toolCallId: String, toolName: String)
  case toolOutput(toolCallId: String, toolName: String, output: String, isError: Bool, complete: Bool)
  case messageEnd(message: JSONValue)
  case turnEnd(message: JSONValue, toolResults: JSONValue)
  case queue(steering: JSONValue, followUp: JSONValue)
  case aborted
  case agentSettled
  case error(message: String, recoverable: Bool)
  case processCrash(detail: String, stderr: String)
}

public struct PiRpcClientOptions: Sendable {
  public var piPath: String
  public var cwd: String
  public var env: [String: String]
  public var session: String?
  public var model: String?
  public var requestTimeout: TimeInterval
  public var extraArgs: [String]

  public init(
    piPath: String,
    cwd: String,
    env: [String: String],
    session: String? = nil,
    model: String? = nil,
    requestTimeout: TimeInterval = 30,
    extraArgs: [String] = []
  ) {
    self.piPath = piPath
    self.cwd = cwd
    self.env = env
    self.session = session
    self.model = model
    self.requestTimeout = requestTimeout
    self.extraArgs = extraArgs
  }
}

/// One PiRpcClient owns exactly one `pi --mode rpc` subprocess/session.
/// Port of `pi-rpc.ts` with the same request correlation, event
/// normalization, settled fallback, and crash semantics.
@MainActor
public final class PiRpcClient {
  private struct Pending {
    let command: String
    let continuation: CheckedContinuation<JSONValue, Error>
    let timeoutTask: Task<Void, Never>?
  }

  private let options: PiRpcClientOptions
  private var process: Process?
  private var stdinHandle: FileHandle?
  private var stdoutBuffer = Data()
  private var pending: [String: Pending] = [:]
  private var activeToolOutput: [String: String] = [:]
  private var requestSequence = 0
  private(set) public var stderrText = ""
  private var stopping = false
  private var runGeneration = 0
  private var abortEmittedGeneration = -1
  private var settledEmittedGeneration = -1
  private var pendingAgentEnd = false
  private var retryInProgress = false
  private var compactionInProgress = false
  private var settledFallback: Task<Void, Never>?

  public var onEvent: ((PiClientEvent) -> Void)?

  private static let compactionTimeout: TimeInterval = 600
  private static let maxStderr = 256 * 1024
  private static let maxRecordBytes = 64 * 1024 * 1024

  public init(options: PiRpcClientOptions) {
    self.options = options
  }

  public var isRunning: Bool {
    guard let process else { return false }
    return process.isRunning
  }

  /// Exposed for the fake-pi integration tests only.
  public var processIdentifierForTesting: pid_t? {
    process?.processIdentifier
  }

  public func start() throws {
    guard !isRunning else { return }
    stopping = false
    stderrText = ""
    stdoutBuffer.removeAll()
    activeToolOutput.removeAll()
    clearSettledFallback()
    pendingAgentEnd = false
    retryInProgress = false
    compactionInProgress = false

    var arguments = [options.piPath, "--mode", "rpc"]
    if let session = options.session { arguments += ["--session", session] }
    if let model = options.model { arguments += ["--model", model] }
    arguments += options.extraArgs

    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    child.arguments = arguments
    child.currentDirectoryURL = URL(fileURLWithPath: options.cwd)
    child.environment = options.env

    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = stderr

    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.process === child else { return }
          if chunk.isEmpty {
            handle.readabilityHandler = nil
            return
          }
          self.consumeStdout(chunk)
        }
      }
    }
    stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      guard !chunk.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      let text = String(decoding: chunk, as: UTF8.self)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.process === child else { return }
          self.stderrText = String((self.stderrText + text).suffix(Self.maxStderr))
        }
      }
    }
    child.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.handleClose(child: finished)
        }
      }
    }

    do {
      try child.run()
    } catch {
      throw BridgeError("Unable to start Pi: \(error.localizedDescription)")
    }
    process = child
    stdinHandle = stdin.fileHandleForWriting
  }

  public func stop() async {
    guard let child = process else { return }
    stopping = true
    clearSettledFallback()
    rejectPending(BridgeError("Pi RPC client stopped"))
    if !child.isRunning {
      if process === child { process = nil }
      return
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let resumed = OneShotFlag()
      let previousHandler = child.terminationHandler
      child.terminationHandler = { finished in
        previousHandler?(finished)
        if resumed.tryFire() { continuation.resume() }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
          if resumed.tryFire() { continuation.resume() }
        }
      }
      child.terminate()
    }
    if process === child { process = nil }
  }

  // MARK: - Requests

  public func request(_ command: [String: JSONValue], timeout: TimeInterval? = nil) async throws -> JSONValue {
    guard let child = process, child.isRunning, let stdin = stdinHandle else {
      throw BridgeError("Pi RPC process is not running")
    }
    requestSequence += 1
    let id = "codepi-\(requestSequence)"
    var payload = command
    payload["id"] = .string(id)
    let commandType = command["type"]?.stringValue ?? "unknown"
    let line = Data((JSONValue.object(payload).jsonString() + "\n").utf8)
    return try await withCheckedThrowingContinuation { continuation in
      let effectiveTimeout = timeout ?? options.requestTimeout
      let timeoutTask: Task<Void, Never>? = effectiveTimeout > 0
        ? Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(effectiveTimeout * 1_000_000_000))
            guard let self, let entry = self.pending.removeValue(forKey: id) else { return }
            entry.continuation.resume(throwing: BridgeError("Pi RPC request timed out: \(commandType)"))
          }
        : nil
      pending[id] = Pending(command: commandType, continuation: continuation, timeoutTask: timeoutTask)
      do {
        try stdin.write(contentsOf: line)
      } catch {
        if let entry = pending.removeValue(forKey: id) {
          entry.timeoutTask?.cancel()
          entry.continuation.resume(throwing: BridgeError("Failed to write Pi RPC command: \(error.localizedDescription)"))
        }
      }
    }
  }

  public func prompt(_ message: String, images: [JSONValue]) async throws {
    _ = try await request(sendCommand(type: "prompt", message: message, images: images))
  }

  public func steer(_ message: String, images: [JSONValue]) async throws {
    _ = try await request(sendCommand(type: "steer", message: message, images: images))
  }

  public func followUp(_ message: String, images: [JSONValue]) async throws {
    _ = try await request(sendCommand(type: "follow_up", message: message, images: images))
  }

  private func sendCommand(type: String, message: String, images: [JSONValue]) -> [String: JSONValue] {
    var command: [String: JSONValue] = ["type": .string(type), "message": .string(message)]
    if !images.isEmpty { command["images"] = .array(images) }
    return command
  }

  public func abort() async throws {
    _ = try await request(["type": .string("abort")])
    emitAborted()
  }

  /// `getState` parity: guarantees a `model` key (null when absent).
  public func getState() async throws -> JSONValue {
    let state = try await request(["type": .string("get_state")])
    var object = state.objectValue ?? [:]
    if object["model"] == nil { object["model"] = .null }
    return .object(object)
  }

  public func getMessages() async throws -> JSONValue {
    let data = try await request(["type": .string("get_messages")])
    let messages = data.objectValue?["messages"]?.arrayValue ?? []
    return .array(messages.map(MessageLimits.limitAgentMessage))
  }

  public func getAvailableModels() async throws -> JSONValue {
    let data = try await request(["type": .string("get_available_models")])
    return data.objectValue?["models"] ?? .array([])
  }

  public func getCommands() async throws -> JSONValue {
    let data = try await request(["type": .string("get_commands")])
    return data.objectValue?["commands"]?.arrayValue.map(JSONValue.array) ?? .array([])
  }

  public func setModel(provider: String, modelId: String) async throws -> JSONValue {
    try await request(["type": .string("set_model"), "provider": .string(provider), "modelId": .string(modelId)])
  }

  public func setThinkingLevel(_ level: String) async throws {
    _ = try await request(["type": .string("set_thinking_level"), "level": .string(level)])
  }

  public func compact(customInstructions: String?) async throws {
    var command: [String: JSONValue] = ["type": .string("compact")]
    if let customInstructions { command["customInstructions"] = .string(customInstructions) }
    _ = try await request(command, timeout: Self.compactionTimeout)
  }

  public func setAutoCompaction(_ enabled: Bool) async throws {
    _ = try await request(["type": .string("set_auto_compaction"), "enabled": .bool(enabled)])
  }

  public func setAutoRetry(_ enabled: Bool) async throws {
    _ = try await request(["type": .string("set_auto_retry"), "enabled": .bool(enabled)])
  }

  public func setSessionName(_ name: String) async throws {
    _ = try await request(["type": .string("set_session_name"), "name": .string(name)])
  }

  public func getSessionStats() async throws -> JSONValue {
    try await request(["type": .string("get_session_stats")])
  }

  public func getTree() async throws -> (tree: JSONValue, leafId: JSONValue, sessionFile: String?) {
    let state = try await getState()
    guard let sessionFile = state.objectValue?["sessionFile"]?.stringValue else {
      return (.array([]), .null, nil)
    }
    guard FileManager.default.fileExists(atPath: sessionFile) else {
      return (.array([]), .null, sessionFile)
    }
    let result = try Sessions.readSessionTree(sessionFile: sessionFile)
    return (result.tree, result.leafId, sessionFile)
  }

  // MARK: - Stdout handling

  private func consumeStdout(_ chunk: Data) {
    stdoutBuffer.append(chunk)
    while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
      let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newline]
      stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...newline)
      var line = String(decoding: lineData, as: UTF8.self)
      if line.hasSuffix("\r") { line.removeLast() }
      handleLine(line)
    }
    if stdoutBuffer.count > Self.maxRecordBytes {
      emitError("Pi RPC JSONL record exceeded its safety limit", recoverable: true)
      if let process { kill(process.processIdentifier, SIGTERM) }
    }
  }

  private func handleLine(_ line: String) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    guard let value = try? JSONValue.parse(line), let record = value.objectValue,
          let type = record["type"]?.stringValue else {
      emitError("Pi emitted a JSONL record without a string type field", recoverable: true)
      return
    }
    if type == "response" {
      handleResponse(record)
      return
    }
    normalizeEvent(type: type, record: record)
  }

  private func handleResponse(_ record: [String: JSONValue]) {
    guard let id = record["id"]?.stringValue, !id.isEmpty else {
      emitError("Received uncorrelated Pi RPC response", recoverable: true)
      return
    }
    guard let entry = pending.removeValue(forKey: id) else {
      emitError("Received Pi RPC response for unknown request id \(id)", recoverable: true)
      return
    }
    entry.timeoutTask?.cancel()
    if record["success"]?.boolValue == true {
      entry.continuation.resume(returning: record["data"] ?? .null)
    } else {
      let message = record["error"]?.stringValue ?? "Pi RPC command failed"
      entry.continuation.resume(throwing: BridgeError(message))
    }
  }

  private var agentEndMessages: JSONValue = .array([])

  private func normalizeEvent(type: String, record: [String: JSONValue]) {
    switch type {
    case "agent_start":
      runGeneration += 1
      agentEndMessages = .array([])
      clearSettledFallback()
      pendingAgentEnd = false
      retryInProgress = false
      compactionInProgress = false
      onEvent?(.agentStart)
    case "agent_end":
      agentEndMessages = .array((record["messages"]?.arrayValue ?? []).map(MessageLimits.limitAgentMessage))
      pendingAgentEnd = true
      scheduleSettledFallback()
    case "turn_end":
      let message = record["message"].map(MessageLimits.limitAgentMessage) ?? .null
      let toolResults = JSONValue.array((record["toolResults"]?.arrayValue ?? []).map(MessageLimits.limitAgentMessage))
      onEvent?(.turnEnd(message: message, toolResults: toolResults))
    case "message_update":
      if let update = record["assistantMessageEvent"]?.objectValue { normalizeAssistantUpdate(update) }
    case "message_end":
      onEvent?(.messageEnd(message: record["message"].map(MessageLimits.limitAgentMessage) ?? .null))
    case "tool_execution_start":
      guard let toolCallId = record["toolCallId"]?.stringValue, let toolName = record["toolName"]?.stringValue else { return }
      activeToolOutput[toolCallId] = ""
      onEvent?(.toolExecutionStart(toolCallId: toolCallId, toolName: toolName))
    case "tool_execution_update":
      guard let toolCallId = record["toolCallId"]?.stringValue, let toolName = record["toolName"]?.stringValue else { return }
      let output = MessageLimits.extractToolOutput(record["partialResult"])
      activeToolOutput[toolCallId] = output
      onEvent?(.toolOutput(toolCallId: toolCallId, toolName: toolName, output: output, isError: false, complete: false))
    case "tool_execution_end":
      guard let toolCallId = record["toolCallId"]?.stringValue, let toolName = record["toolName"]?.stringValue else { return }
      var output = MessageLimits.extractToolOutput(record["result"])
      if output.isEmpty { output = activeToolOutput[toolCallId] ?? "" }
      activeToolOutput.removeValue(forKey: toolCallId)
      onEvent?(.toolOutput(
        toolCallId: toolCallId,
        toolName: toolName,
        output: output,
        isError: record["isError"]?.boolValue == true,
        complete: true
      ))
    case "queue_update":
      onEvent?(.queue(
        steering: record["steering"]?.arrayValue.map(JSONValue.array) ?? .array([]),
        followUp: record["followUp"]?.arrayValue.map(JSONValue.array) ?? .array([])
      ))
    case "extension_error":
      emitError(record["error"]?.stringValue ?? "A Pi extension failed", recoverable: true)
    case "extension_ui_request":
      handleExtensionUiRequest(record)
    case "auto_retry_start":
      retryInProgress = true
      clearSettledFallback()
    case "auto_retry_end":
      retryInProgress = false
      if record["success"]?.boolValue == true {
        pendingAgentEnd = false
        clearSettledFallback()
      } else {
        emitError(record["finalError"]?.stringValue ?? "Pi exhausted its automatic retries", recoverable: true)
        scheduleSettledFallback()
      }
    case "compaction_start":
      compactionInProgress = true
      clearSettledFallback()
    case "compaction_end":
      compactionInProgress = false
      if record["aborted"]?.boolValue != true, let message = record["errorMessage"]?.stringValue, !message.isEmpty {
        emitError(message, recoverable: true)
      }
      if record["willRetry"]?.boolValue == true {
        pendingAgentEnd = false
        clearSettledFallback()
      } else {
        scheduleSettledFallback()
      }
    default:
      break
    }
  }

  private func normalizeAssistantUpdate(_ update: [String: JSONValue]) {
    let contentIndex = update["contentIndex"] ?? .null
    switch update["type"]?.stringValue {
    case "text_delta":
      onEvent?(.textDelta(delta: update["delta"]?.stringValue ?? "", contentIndex: contentIndex))
    case "thinking_delta":
      onEvent?(.thinkingDelta(delta: update["delta"]?.stringValue ?? "", contentIndex: contentIndex))
    case "toolcall_start":
      let partial = partialToolCall(update)
      onEvent?(.toolCallStart(
        toolCallId: partial?["id"] ?? .null,
        toolName: partial?["name"] ?? .null,
        contentIndex: contentIndex
      ))
    case "toolcall_delta":
      let partial = partialToolCall(update)
      onEvent?(.toolCallArgs(
        toolCallId: partial?["id"] ?? .null,
        toolName: partial?["name"] ?? .null,
        delta: update["delta"]?.stringValue ?? "",
        contentIndex: contentIndex
      ))
    case "toolcall_end":
      guard let toolCall = update["toolCall"]?.objectValue,
            let id = toolCall["id"]?.stringValue,
            let name = toolCall["name"]?.stringValue else { return }
      let args = toolCall["arguments"] ?? .object([:])
      onEvent?(.toolCallEnd(
        toolCallId: id,
        toolName: name,
        args: args.objectValue != nil ? args : .object([:]),
        contentIndex: contentIndex
      ))
    case "error":
      if update["reason"]?.stringValue == "aborted" {
        emitAborted()
      } else {
        let message = update["error"]?.objectValue?["errorMessage"]?.stringValue
        emitError(message?.isEmpty == false ? message! : "Pi failed while generating a response", recoverable: true)
      }
    default:
      break
    }
  }

  private func partialToolCall(_ update: [String: JSONValue]) -> [String: JSONValue]? {
    guard let content = update["partial"]?.objectValue?["content"]?.arrayValue,
          let index = update["contentIndex"]?.numberValue,
          index >= 0, Int(index) < content.count,
          let block = content[Int(index)].objectValue,
          block["type"]?.stringValue == "toolCall"
    else { return nil }
    return block
  }

  private func handleExtensionUiRequest(_ record: [String: JSONValue]) {
    guard let id = record["id"]?.stringValue, let method = record["method"]?.stringValue else {
      emitError("Pi emitted an invalid extension UI request", recoverable: true)
      return
    }
    guard ["select", "confirm", "input", "editor"].contains(method) else { return }
    if let stdin = stdinHandle, isRunning {
      let response = JSONValue.object([
        "type": .string("extension_ui_response"),
        "id": .string(id),
        "cancelled": .bool(true)
      ])
      try? stdin.write(contentsOf: Data((response.jsonString() + "\n").utf8))
    }
    let label = record["title"]?.stringValue ?? record["message"]?.stringValue ?? method
    emitError("Pi extension UI request cancelled because CodePi does not yet support “\(label)”.", recoverable: true)
  }

  // MARK: - Settling, aborting, crashing

  private func scheduleSettledFallback() {
    clearSettledFallback()
    guard pendingAgentEnd, !retryInProgress, !compactionInProgress else { return }
    let generation = runGeneration
    settledFallback = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 750_000_000)
      guard let self, !Task.isCancelled else { return }
      self.settledFallback = nil
      guard generation == self.runGeneration,
            self.pendingAgentEnd,
            !self.retryInProgress,
            !self.compactionInProgress else { return }
      self.pendingAgentEnd = false
      self.emitSettled()
    }
  }

  private func clearSettledFallback() {
    settledFallback?.cancel()
    settledFallback = nil
  }

  private func emitSettled() {
    guard settledEmittedGeneration != runGeneration else { return }
    settledEmittedGeneration = runGeneration
    onEvent?(.agentSettled)
  }

  private func emitAborted() {
    guard abortEmittedGeneration != runGeneration else { return }
    abortEmittedGeneration = runGeneration
    onEvent?(.aborted)
  }

  private func emitError(_ message: String, recoverable: Bool) {
    onEvent?(.error(message: message, recoverable: recoverable))
  }

  private func handleClose(child: Process) {
    guard process === child || process == nil else { return }
    process = nil
    stdinHandle = nil
    clearSettledFallback()
    activeToolOutput.removeAll()
    pendingAgentEnd = false
    retryInProgress = false
    compactionInProgress = false
    let detail: String
    if child.terminationReason == .uncaughtSignal {
      detail = "signal \(child.terminationStatus)"
    } else {
      detail = "exit code \(child.terminationStatus)"
    }
    rejectPending(BridgeError("Pi RPC process exited with \(detail)"))
    if !stopping {
      onEvent?(.processCrash(detail: detail, stderr: stderrText))
      emitError("Pi stopped unexpectedly (\(detail))", recoverable: true)
    }
  }

  private func rejectPending(_ error: Error) {
    let entries = pending.values
    pending.removeAll()
    for entry in entries {
      entry.timeoutTask?.cancel()
      entry.continuation.resume(throwing: error)
    }
  }
}

final class OneShotFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var fired = false

  func tryFire() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if fired { return false }
    fired = true
    return true
  }
}
