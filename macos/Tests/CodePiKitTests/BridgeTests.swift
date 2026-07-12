import XCTest
@testable import CodePiKit

final class JSONValueTests: XCTestCase {
  func testRoundTripsNestedValues() throws {
    let raw = #"{"a":[1,true,null,"x"],"b":{"c":2.5}}"#
    let value = try JSONValue.parse(raw)
    let reparsed = try JSONValue.parse(value.jsonString())
    XCTAssertEqual(value, reparsed)
  }

  func testSerializesFragments() throws {
    XCTAssertEqual(try JSONValue.parse("\"hi\"").jsonString(), "\"hi\"")
    XCTAssertEqual(try JSONValue.parse("null").jsonString(), "null")
    XCTAssertEqual(try JSONValue.parse("3").jsonString(), "3")
  }

  func testKeepsWholeNumbersUnsuffixed() {
    XCTAssertEqual(JSONValue.number(1280).jsonString(), "1280")
  }
}

final class BridgeRequestTests: XCTestCase {
  func testDecodesEnvelope() throws {
    let request = try BridgeRequest.decode(#"{"channel":"codepi:bootstrap","args":[]}"#)
    XCTAssertEqual(request.channel, "codepi:bootstrap")
    XCTAssertTrue(request.args.isEmpty)
  }

  func testDecodesMissingArgsAsEmpty() throws {
    let request = try BridgeRequest.decode(#"{"channel":"codepi:bootstrap"}"#)
    XCTAssertTrue(request.args.isEmpty)
  }

  func testRejectsMalformedJson() {
    XCTAssertThrowsError(try BridgeRequest.decode("not json"))
  }
}

@MainActor
final class BridgeRouterTests: XCTestCase {
  func testDispatchesToRegisteredHandler() async throws {
    let router = BridgeRouter()
    router.register("codepi:echo") { args in
      .array(args)
    }
    let response = await router.dispatch(raw: #"{"channel":"codepi:echo","args":["a",2]}"#)
    XCTAssertNil(response.error)
    XCTAssertEqual(response.body, #"["a",2]"#)
  }

  func testNilResultResolvesUndefined() async {
    let router = BridgeRouter()
    router.register("codepi:void") { _ in nil }
    let response = await router.dispatch(raw: #"{"channel":"codepi:void","args":[]}"#)
    XCTAssertNil(response.error)
    XCTAssertNil(response.body)
  }

  func testUnknownChannelFails() async {
    let router = BridgeRouter()
    let response = await router.dispatch(raw: #"{"channel":"codepi:nope","args":[]}"#)
    XCTAssertNil(response.body)
    XCTAssertEqual(response.error, "codepi:nope is not implemented in the Swift shell yet")
  }

  func testHandlerErrorsBecomeBridgeErrors() async {
    let router = BridgeRouter()
    router.register("codepi:boom") { _ in
      throw BridgeError("It broke")
    }
    let response = await router.dispatch(raw: #"{"channel":"codepi:boom","args":[]}"#)
    XCTAssertEqual(response.error, "It broke")
  }

  func testMalformedRequestFailsSafely() async {
    let router = BridgeRouter()
    let response = await router.dispatch(raw: "{{{{")
    XCTAssertEqual(response.error, "Malformed bridge request")
  }
}

final class EventCoalescerTests: XCTestCase {
  func testPreservesPerChannelOrderAndChannelArrival() {
    var coalescer = EventCoalescer()
    coalescer.append(channel: "a", payload: .number(1))
    coalescer.append(channel: "b", payload: .number(10))
    coalescer.append(channel: "a", payload: .number(2))
    let drained = coalescer.drain()
    XCTAssertEqual(drained.map(\.channel), ["a", "b"])
    XCTAssertEqual(drained[0].payloads, [.number(1), .number(2)])
    XCTAssertEqual(drained[1].payloads, [.number(10)])
    XCTAssertTrue(coalescer.isEmpty)
    XCTAssertTrue(coalescer.drain().isEmpty)
  }
}

final class PiEnvironmentTests: XCTestCase {
  func testReportsMissingBinary() async {
    let result = await PiEnvironment.validatePiBinary(path: "/nonexistent/definitely-not-pi")
    XCTAssertFalse(result.available)
    XCTAssertNotNil(result.error)
  }

  func testValidatesRealBinary() async {
    // git is guaranteed in CI and dev environments and answers --version.
    let result = await PiEnvironment.validatePiBinary(path: "git")
    XCTAssertTrue(result.available)
    XCTAssertNotNil(result.version)
  }

  func testRejectsRelativePathsOutsidePath() async {
    let result = await PiEnvironment.validatePiBinary(path: "bin/pi")
    XCTAssertFalse(result.available)
    XCTAssertEqual(result.error, "Use an absolute path for a Pi executable outside PATH.")
  }
}

@MainActor
final class StateStoreTests: XCTestCase {
  private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  func testOpensMissingFileWithDefaults() throws {
    let store = try StateStore.open(directory: try temporaryDirectory())
    let state = store.snapshot()
    XCTAssertTrue(state.projects.isEmpty)
    XCTAssertEqual(state.settings.piPath, "pi")
    XCTAssertEqual(state.windowBounds.width, 1240)
  }

  func testRejectsFutureVersions() throws {
    let directory = try temporaryDirectory()
    try Data(#"{"version":3}"#.utf8).write(to: directory.appendingPathComponent("state.json"))
    XCTAssertThrowsError(try StateStore.open(directory: directory))
  }

  func testRoundTripsElectronShapedState() throws {
    let directory = try temporaryDirectory()
    let electronState = """
    {
      "version": 2,
      "projects": [{"id": "p1", "name": "Demo", "path": "/tmp/demo", "isGit": true, "expanded": true, "createdAt": 1000}],
      "threads": [{
        "id": "t1", "projectId": "p1", "title": "Hello", "cwd": "/tmp/demo",
        "status": "idle", "createdAt": 1000, "updatedAt": 2000,
        "pinned": false, "archived": false, "unread": true, "tags": ["a"],
        "disabledCapabilityIds": [], "autoRetryEnabled": true,
        "sessionFile": "/tmp/session.jsonl"
      }],
      "promptLibrary": [], "usageLedger": [],
      "selectedThreadId": "t1",
      "windowBounds": {"width": 1280, "height": 800},
      "settings": {"piPath": "pi", "defaultModel": "", "theme": "dark", "env": {"FOO": "bar"}},
      "dismissedSessionFiles": ["/tmp/old.jsonl"]
    }
    """
    try Data(electronState.utf8).write(to: directory.appendingPathComponent("state.json"))
    let store = try StateStore.open(directory: directory)
    let state = store.snapshot()
    XCTAssertEqual(state.threads.first?.title, "Hello")
    XCTAssertEqual(state.threads.first?.sessionFile, "/tmp/session.jsonl")
    XCTAssertEqual(state.selectedThreadId, "t1")
    XCTAssertEqual(state.settings.env["FOO"], "bar")
    XCTAssertEqual(state.dismissedSessionFiles, ["/tmp/old.jsonl"])

    // Renderer payload must strip env values and dismissed files.
    let publicObject = state.publicPayload.objectValue!
    XCTAssertNil(publicObject["dismissedSessionFiles"])
    XCTAssertEqual(publicObject["settings"]?.objectValue?["env"], .object([:]))

    // Persist and re-normalize: the state survives its own disk format.
    store.update { _ in }
    let waited = expectation(description: "flush")
    Task { @MainActor in
      await store.flush()
      waited.fulfill()
    }
    wait(for: [waited], timeout: 5)
    let reopened = try StateStore.open(directory: directory)
    XCTAssertEqual(reopened.snapshot(), state)
  }

  func testDropsThreadsForUnknownProjects() throws {
    let directory = try temporaryDirectory()
    let raw = """
    {"version": 2, "projects": [], "threads": [{"id": "t1", "projectId": "ghost", "title": "x", "cwd": "/tmp"}]}
    """
    try Data(raw.utf8).write(to: directory.appendingPathComponent("state.json"))
    let store = try StateStore.open(directory: directory)
    XCTAssertTrue(store.snapshot().threads.isEmpty)
  }
}

@MainActor
final class ThreadLibraryTests: XCTestCase {
  private func storeWithThread() throws -> StateStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let store = try StateStore.open(directory: directory)
    store.update { state in
      state.projects.append(ProjectRecord(id: "p1", name: "Demo", path: "/tmp", isGit: false, expanded: true, createdAt: 0))
      state.threads.append(ThreadRecord(id: "t1", projectId: "p1", title: "Hello", cwd: "/tmp", createdAt: 0, updatedAt: 0))
    }
    return store
  }

  func testRenameAndTags() throws {
    let store = try storeWithThread()
    let update = try ThreadUpdate(from: .object(["title": .string("  Renamed  "), "tags": .array([.string("One"), .string("one"), .string(" two ")])]))
    let updated = try ThreadLibrary.updateThreadMetadata(store: store, threadId: "t1", update: update)
    XCTAssertEqual(updated.title, "Renamed")
    XCTAssertEqual(updated.tags, ["One", "two"])
  }

  func testArchiveUnpins() throws {
    let store = try storeWithThread()
    _ = try ThreadLibrary.updateThreadMetadata(
      store: store, threadId: "t1",
      update: try ThreadUpdate(from: .object(["pinned": .bool(true)]))
    )
    let archived = try ThreadLibrary.updateThreadMetadata(
      store: store, threadId: "t1",
      update: try ThreadUpdate(from: .object(["archived": .bool(true)]))
    )
    XCTAssertTrue(archived.archived)
    XCTAssertFalse(archived.pinned)
  }

  func testPinningArchivedThreadFails() throws {
    let store = try storeWithThread()
    _ = try ThreadLibrary.updateThreadMetadata(
      store: store, threadId: "t1",
      update: try ThreadUpdate(from: .object(["archived": .bool(true)]))
    )
    XCTAssertThrowsError(try ThreadLibrary.updateThreadMetadata(
      store: store, threadId: "t1",
      update: try ThreadUpdate(from: .object(["pinned": .bool(true)]))
    ))
  }

  func testTrashRestoreCycle() throws {
    let store = try storeWithThread()
    let trashed = try ThreadLibrary.softTrashThread(store: store, threadId: "t1", now: 42)
    XCTAssertEqual(trashed.deletedAt, 42)
    XCTAssertEqual(trashed.status, "idle")
    let restored = try ThreadLibrary.restoreTrashedThread(store: store, threadId: "t1")
    XCTAssertNil(restored.deletedAt)
    XCTAssertThrowsError(try ThreadLibrary.restoreTrashedThread(store: store, threadId: "t1"))
  }

  func testUsageDashboardBucketsByDay() {
    let now = Date()
    let entries = [
      UsageLedgerEntry(id: "1", projectId: "p1", threadId: "t1", timestamp: now.timeIntervalSince1970 * 1000 - 1000, tokens: 100, cost: 0.5),
      UsageLedgerEntry(id: "2", projectId: "p2", threadId: "t2", timestamp: now.timeIntervalSince1970 * 1000 - 2000, tokens: 50, cost: 0.1)
    ]
    let all = ThreadLibrary.usageDashboard(entries: entries, projectId: nil, now: now).objectValue!
    XCTAssertEqual(all["today"]?.objectValue?["tokens"], .number(150))
    XCTAssertEqual(all["days"]?.arrayValue?.count, 30)
    let filtered = ThreadLibrary.usageDashboard(entries: entries, projectId: "p1", now: now).objectValue!
    XCTAssertEqual(filtered["today"]?.objectValue?["tokens"], .number(100))
  }
}

final class SessionsTests: XCTestCase {
  private func writeSession(_ lines: [String]) throws -> String {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-session-\(UUID().uuidString).jsonl")
    try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
    return url.path
  }

  func testReadsTreeAndLeaf() throws {
    let file = try writeSession([
      #"{"type":"session","id":"s1","cwd":"/tmp","version":3}"#,
      #"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi","timestamp":1}}"#,
      #"{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[],"timestamp":2}}"#
    ])
    let result = try Sessions.readSessionTree(sessionFile: file)
    XCTAssertEqual(result.leafId, .string("e2"))
    let roots = result.tree.arrayValue!
    XCTAssertEqual(roots.count, 1)
    XCTAssertEqual(roots[0].objectValue?["children"]?.arrayValue?.count, 1)
  }

  func testCloneBranchRewindsUserSelection() throws {
    let file = try writeSession([
      #"{"type":"session","id":"s1","cwd":"/tmp","version":3}"#,
      #"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"one","timestamp":1}}"#,
      #"{"type":"message","id":"e2","parentId":"e1","message":{"role":"assistant","content":[],"timestamp":2}}"#,
      #"{"type":"message","id":"e3","parentId":"e2","message":{"role":"user","content":"two","timestamp":3}}"#
    ])
    let scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-agent-\(UUID().uuidString)").path
    let target = try Sessions.cloneSessionBranch(
      sourceFile: file,
      entryId: "e3",
      targetCwd: "/tmp",
      env: ["PI_CODING_AGENT_DIR": scratch],
      rewindSelectedUser: true
    )
    let content = try String(contentsOfFile: target, encoding: .utf8)
    let lines = content.split(separator: "\n")
    // Header + e1 + e2; the selected user prompt e3 is rewound away.
    XCTAssertEqual(lines.count, 3)
    XCTAssertTrue(lines[0].contains(#""parentSession""#))
    XCTAssertTrue(lines[2].contains(#""id":"e2""#))
  }

  func testTitleFromPrefixPrefersSessionName() {
    let prefix = """
    {"type":"session","id":"s1","cwd":"/tmp"}
    {"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"first prompt text"}}
    {"type":"session_info","name":"Named session"}
    """
    XCTAssertEqual(Sessions.titleFromPrefix(prefix), "Named session")
  }

  func testRecoveredThreadIdIsStable() {
    let a = Sessions.recoveredThreadId(sessionFile: "/tmp/x.jsonl")
    let b = Sessions.recoveredThreadId(sessionFile: "/tmp/x.jsonl")
    XCTAssertEqual(a, b)
    XCTAssertTrue(a.hasPrefix("session-"))
  }
}

final class MessageLimitsTests: XCTestCase {
  func testCollapsesAttachedContext() {
    let message = "Do the thing\n\nAttached file `notes.txt`:\n\n```text\nhello\n```\n\nAttached file path: `/tmp/big.bin`"
    let collapsed = MessageLimits.collapseAttachedContext(message)
    XCTAssertEqual(collapsed, "Do the thing\n\n📎 notes.txt\n📎 /tmp/big.bin")
  }

  func testTruncatesLongToolOutput() {
    let long = String(repeating: "x", count: 600 * 1024)
    let truncated = MessageLimits.truncateDisplayText(long)
    XCTAssertTrue(truncated.contains("[CodePi truncated"))
    XCTAssertLessThan(truncated.count, 600 * 1024)
  }

  func testStripsImageDataFromUserMessages() throws {
    let message = try JSONValue.parse(
      #"{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1}"#
    )
    let limited = MessageLimits.limitAgentMessage(message)
    let parts = limited.objectValue?["content"]?.arrayValue
    XCTAssertEqual(parts?[1].objectValue?["mimeType"], .string("image/png"))
    XCTAssertNil(parts?[1].objectValue?["data"])
  }
}

@MainActor
final class ProcessManagerPromptTests: XCTestCase {
  func testBuildPromptAppendsAttachmentBlocks() {
    let attachments: [JSONValue] = [
      .object(["kind": .string("image"), "data": .string("data:image/png;base64,QUJD"), "mimeType": .string("image/png")]),
      .object(["kind": .string("text"), "name": .string("a.txt"), "text": .string("body")]),
      .object(["kind": .string("file"), "path": .string("/tmp/thing.bin")])
    ]
    let prompt = PiProcessManager.buildPrompt(message: "run it", attachments: attachments)
    XCTAssertEqual(prompt.images.count, 1)
    XCTAssertEqual(prompt.images[0].objectValue?["data"], .string("QUJD"))
    XCTAssertTrue(prompt.message.hasPrefix("run it\n\n"))
    XCTAssertTrue(prompt.message.contains("Attached file `a.txt`:"))
    XCTAssertTrue(prompt.message.contains("Attached file path: `/tmp/thing.bin`"))
  }
}
