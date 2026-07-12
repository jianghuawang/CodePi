import XCTest
@testable import CodePiKit

/// Drives PiRpcClient end-to-end against a scripted fake `pi --mode rpc`
/// process (python3), verifying spawn, request correlation, streaming event
/// normalization, and the settled fallback — no network, no API keys.
@MainActor
final class FakePiIntegrationTests: XCTestCase {
  private static let fakePiScript = """
  #!/usr/bin/env python3
  import sys, json

  def send(obj):
      sys.stdout.write(json.dumps(obj) + "\\n")
      sys.stdout.flush()

  for line in sys.stdin:
      try:
          cmd = json.loads(line)
      except ValueError:
          continue
      t = cmd.get("type")
      i = cmd.get("id")
      if t == "get_state":
          send({"type": "response", "id": i, "command": t, "success": True, "data": {
              "thinkingLevel": "off", "isStreaming": False, "isCompacting": False,
              "steeringMode": "all", "followUpMode": "all", "sessionId": "fake-session",
              "messageCount": 0, "pendingMessageCount": 0}})
      elif t == "get_messages":
          send({"type": "response", "id": i, "command": t, "success": True, "data": {"messages": []}})
      elif t == "get_available_models":
          send({"type": "response", "id": i, "command": t, "success": True, "data": {
              "models": [{"id": "fake-1", "name": "Fake Model", "provider": "fake"}]}})
      elif t == "get_session_stats":
          send({"type": "response", "id": i, "command": t, "success": True, "data": {
              "sessionId": "fake-session",
              "tokens": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "total": 3},
              "cost": 0.01}})
      elif t == "prompt":
          send({"type": "response", "id": i, "command": t, "success": True})
          send({"type": "agent_start"})
          send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "Hel", "contentIndex": 0}})
          send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "lo", "contentIndex": 0}})
          send({"type": "turn_end",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello"}], "timestamp": 1},
                "toolResults": []})
          send({"type": "agent_end", "messages": []})
      elif t == "bad_command":
          send({"type": "response", "id": i, "command": t, "success": False, "error": "nope"})
      else:
          send({"type": "response", "id": i, "command": t, "success": True})
  """

  private func makeClient() throws -> PiRpcClient {
    let script = FileManager.default.temporaryDirectory
      .appendingPathComponent("fake-pi-\(UUID().uuidString).py")
    try Data(Self.fakePiScript.utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return PiRpcClient(options: PiRpcClientOptions(
      piPath: script.path,
      cwd: FileManager.default.temporaryDirectory.path,
      env: ProcessInfo.processInfo.environment,
      requestTimeout: 10
    ))
  }

  func testStreamsPromptAndSettles() async throws {
    let client = try makeClient()
    var deltas: [String] = []
    var sawAgentStart = false
    var sawTurnEnd = false
    let settled = expectation(description: "settled")
    client.onEvent = { event in
      switch event {
      case .agentStart: sawAgentStart = true
      case .textDelta(let delta, _): deltas.append(delta)
      case .turnEnd(let message, _):
        sawTurnEnd = true
        XCTAssertEqual(
          message.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"],
          .string("Hello")
        )
      case .agentSettled: settled.fulfill()
      case .error(let message, _): XCTFail("Unexpected error event: \(message)")
      default: break
      }
    }
    try client.start()

    let state = try await client.getState()
    XCTAssertEqual(state.objectValue?["sessionId"], .string("fake-session"))
    XCTAssertEqual(state.objectValue?["model"], .null, "getState must guarantee a model key")

    let models = try await client.getAvailableModels()
    XCTAssertEqual(models.arrayValue?.first?.objectValue?["provider"], .string("fake"))

    try await client.prompt("say hello", images: [])
    await fulfillment(of: [settled], timeout: 5)
    XCTAssertTrue(sawAgentStart)
    XCTAssertTrue(sawTurnEnd)
    XCTAssertEqual(deltas, ["Hel", "lo"])

    let stats = try await client.getSessionStats()
    XCTAssertEqual(stats.objectValue?["tokens"]?.objectValue?["total"], .number(3))
    await client.stop()
  }

  func testCommandFailuresRejectTheRequest() async throws {
    let client = try makeClient()
    try client.start()
    do {
      _ = try await client.request(["type": .string("bad_command")])
      XCTFail("Expected a rejection")
    } catch {
      XCTAssertEqual((error as? BridgeError)?.message, "nope")
    }
    await client.stop()
  }

  func testProcessCrashSurfacesAndRejectsPending() async throws {
    let client = try makeClient()
    let crashed = expectation(description: "crash")
    client.onEvent = { event in
      if case .processCrash = event { crashed.fulfill() }
    }
    try client.start()
    _ = try await client.getState()
    // Closing stdin makes the fake pi exit; the client must surface a crash.
    kill(try XCTUnwrap(clientPid(client)), SIGKILL)
    await fulfillment(of: [crashed], timeout: 5)
  }

  private func clientPid(_ client: PiRpcClient) -> pid_t? {
    // The fake pi is the direct child of /usr/bin/env; killing the process
    // group is unnecessary — env exec-replaces itself with the script.
    client.processIdentifierForTesting
  }
}
