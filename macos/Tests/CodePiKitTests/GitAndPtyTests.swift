import XCTest
@testable import CodePiKit

final class DiffParserTests: XCTestCase {
  func testParsesAddDeleteAndContext() {
    let raw = """
    diff --git a/hello.txt b/hello.txt
    index 0000000..1111111 100644
    --- a/hello.txt
    +++ b/hello.txt
    @@ -1,3 +1,3 @@
     keep
    -old line
    +new line
     tail
    """
    let files = DiffParser.parse(raw)
    XCTAssertEqual(files.count, 1)
    let file = files[0]
    XCTAssertEqual(file.from, "hello.txt")
    XCTAssertEqual(file.to, "hello.txt")
    XCTAssertEqual(file.additions, 1)
    XCTAssertEqual(file.deletions, 1)
    let chunk = file.chunks[0].objectValue!
    XCTAssertEqual(chunk["oldStart"], .number(1))
    XCTAssertEqual(chunk["newLines"], .number(3))
    let changes = chunk["changes"]!.arrayValue!
    XCTAssertEqual(changes.count, 4)
    XCTAssertEqual(changes[0].objectValue?["type"], .string("normal"))
    XCTAssertEqual(changes[0].objectValue?["oldNumber"], .number(1))
    XCTAssertEqual(changes[0].objectValue?["newNumber"], .number(1))
    XCTAssertEqual(changes[1].objectValue?["type"], .string("del"))
    XCTAssertEqual(changes[1].objectValue?["oldNumber"], .number(2))
    XCTAssertEqual(changes[1].objectValue?["content"], .string("-old line"))
    XCTAssertEqual(changes[2].objectValue?["type"], .string("add"))
    XCTAssertEqual(changes[2].objectValue?["newNumber"], .number(2))
  }

  func testNewFileAgainstDevNull() {
    let raw = """
    diff --git a/fresh.txt b/fresh.txt
    new file mode 100644
    --- /dev/null
    +++ b/fresh.txt
    @@ -0,0 +1,2 @@
    +one
    +two
    """
    let files = DiffParser.parse(raw)
    XCTAssertEqual(files[0].from, "")
    XCTAssertEqual(files[0].to, "fresh.txt")
    XCTAssertEqual(files[0].additions, 2)
  }

  func testBinaryDetection() {
    let raw = """
    diff --git a/logo.png b/logo.png
    Binary files a/logo.png and b/logo.png differ
    """
    XCTAssertTrue(DiffParser.parse(raw)[0].binary)
  }

  func testMapDiffFlags() {
    let raw = """
    diff --git a/x.txt b/x.txt
    --- a/x.txt
    +++ b/x.txt
    @@ -1 +1 @@
    -a
    +b
    """
    let mapped = DiffParser.mapDiff(raw, stagedPaths: ["x.txt"], stageablePaths: [])
    let object = mapped[0].objectValue!
    XCTAssertEqual(object["staged"], .bool(true))
    XCTAssertEqual(object["stageable"], .bool(false))
  }
}

/// Real-git fixture tests: init a scratch repository, exercise the same
/// scenarios the Electron test suite covers.
@MainActor
final class GitServiceTests: XCTestCase {
  private var repo = ""

  override func setUp() async throws {
    repo = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-git-\(UUID().uuidString)").path
    try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
    try await sh("git", "init", "-b", "main")
    try await sh("git", "config", "user.email", "test@example.com")
    try await sh("git", "config", "user.name", "Test")
    try await sh("git", "config", "commit.gpgsign", "false")
    try "one\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
    try await sh("git", "add", ".")
    try await sh("git", "commit", "-m", "initial")
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(atPath: repo)
  }

  @discardableResult
  private func sh(_ args: String...) async throws -> String {
    let result = await ProcessRunner.run(command: Array(args), cwd: repo, env: PiEnvironment.environmentForPi([:]), timeout: 60)
    guard result.status == 0 else { throw BridgeError(result.stderr) }
    return result.stdout
  }

  private func thread(id: String = "t1", worktree: WorktreeRecord? = nil, cwd: String? = nil) -> ThreadRecord {
    ThreadRecord(id: id, projectId: "p1", title: "T", cwd: cwd ?? repo, createdAt: 0, updatedAt: 0, worktree: worktree)
  }

  func testChangesStageCommitCycle() async throws {
    try "one\ntwo\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
    try "fresh\n".write(toFile: repo + "/new.txt", atomically: true, encoding: .utf8)

    let changes = try await GitService.getChanges(thread: thread()).arrayValue!
    let paths = changes.compactMap { $0.objectValue?["to"]?.stringValue }.sorted()
    XCTAssertEqual(paths, ["file.txt", "new.txt"])
    let modified = changes.first { $0.objectValue?["to"]?.stringValue == "file.txt" }!.objectValue!
    XCTAssertEqual(modified["additions"], .number(1))
    XCTAssertEqual(modified["staged"], .bool(false))

    try await GitService.setFileStaged(cwd: repo, files: ["file.txt", "new.txt"], staged: true)
    let staged = try await GitService.getChanges(thread: thread()).arrayValue!
    XCTAssertTrue(staged.allSatisfy { $0.objectValue?["staged"]?.boolValue == true })

    try await GitService.setFileStaged(cwd: repo, files: ["new.txt"], staged: false)
    let commit = try await GitService.commitChanges(thread: thread(), message: "update", push: false).objectValue!
    XCTAssertEqual(commit["pushed"], .bool(false))
    XCTAssertEqual(commit["commit"]?.stringValue?.count, 40)

    let remaining = try await GitService.getChanges(thread: thread()).arrayValue!
    XCTAssertEqual(remaining.compactMap { $0.objectValue?["to"]?.stringValue }, ["new.txt"])
  }

  func testCommitWithoutStagedFilesFails() async throws {
    do {
      _ = try await GitService.commitChanges(thread: thread(), message: "nope", push: false)
      XCTFail("Expected failure")
    } catch {
      XCTAssertTrue((error as? BridgeError)?.message.contains("No files are staged") == true)
    }
  }

  func testWorktreeLifecycleAndApplyToMain() async throws {
    let worktree = try await GitService.createWorktree(projectPath: repo, threadId: "wt-1", seed: nil)
    XCTAssertEqual(worktree.branch, "pi/wt-1")
    XCTAssertEqual(worktree.baseBranch, "main")
    XCTAssertTrue(FileManager.default.fileExists(atPath: worktree.path + "/file.txt"))

    // The exclude file hides .pi-gui from git status in the main checkout.
    let status = try await sh("git", "status", "--porcelain")
    XCTAssertFalse(status.contains(".pi-gui"))

    // Commit a change inside the worktree.
    try "isolated\n".write(toFile: worktree.path + "/wt.txt", atomically: true, encoding: .utf8)
    let wtThread = thread(id: "wt-1", worktree: worktree, cwd: worktree.path)
    let changes = try await GitService.getChanges(thread: wtThread).arrayValue!
    XCTAssertEqual(changes.count, 1)
    XCTAssertEqual(changes[0].objectValue?["stageable"], .bool(true))
    try await GitService.setFileStaged(cwd: worktree.path, files: ["wt.txt"], staged: true)
    _ = try await GitService.commitChanges(thread: wtThread, message: "from worktree", push: false)

    // Committed-on-branch files remain visible but not stageable.
    let afterCommit = try await GitService.getChanges(thread: wtThread).arrayValue!
    XCTAssertEqual(afterCommit.count, 1)
    XCTAssertEqual(afterCommit[0].objectValue?["stageable"], .bool(false))

    let risk = await GitService.worktreeRemovalRisk(thread: wtThread)
    XCTAssertFalse(risk.dirty)
    XCTAssertEqual(risk.unpushedCommits, 1)

    try await GitService.applyWorktreeToMain(projectPath: repo, thread: wtThread)
    XCTAssertTrue(FileManager.default.fileExists(atPath: repo + "/wt.txt"))

    try await GitService.removeWorktree(projectPath: repo, thread: wtThread)
    XCTAssertFalse(FileManager.default.fileExists(atPath: worktree.path))
    let branches = try await sh("git", "branch", "--list", "pi/wt-1")
    XCTAssertTrue(branches.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }

  func testApplyRefusesDirtyMainTree() async throws {
    let worktree = try await GitService.createWorktree(projectPath: repo, threadId: "wt-2", seed: nil)
    let wtThread = thread(id: "wt-2", worktree: worktree, cwd: worktree.path)
    try "wt\n".write(toFile: worktree.path + "/w.txt", atomically: true, encoding: .utf8)
    try await GitService.setFileStaged(cwd: worktree.path, files: ["w.txt"], staged: true)
    _ = try await GitService.commitChanges(thread: wtThread, message: "wt", push: false)
    try "dirty\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
    do {
      try await GitService.applyWorktreeToMain(projectPath: repo, thread: wtThread)
      XCTFail("Expected failure")
    } catch {
      XCTAssertTrue((error as? BridgeError)?.message.contains("main working tree must be clean") == true)
    }
    try await GitService.removeWorktree(projectPath: repo, thread: wtThread)
  }

  func testRemoveWorktreeRefusesUnexpectedPath() async throws {
    let record = WorktreeRecord(path: "/tmp/evil", branch: "pi/t1", baseBranch: "main", baseCommit: "x")
    do {
      try await GitService.removeWorktree(projectPath: repo, thread: thread(worktree: record))
      XCTFail("Expected failure")
    } catch {
      XCTAssertTrue((error as? BridgeError)?.message.contains("unexpected worktree path") == true)
    }
  }
}

@MainActor
final class PtyServiceTests: XCTestCase {
  func testRunsShellStreamsOutputAndExits() async throws {
    var output = ""
    var exitPayload: [String: JSONValue]?
    let exited = expectation(description: "exit")
    let service = PtyService { payload in
      guard let object = payload.objectValue else { return }
      if object["type"]?.stringValue == "data" {
        output += object["data"]?.stringValue ?? ""
      }
      if object["type"]?.stringValue == "exit" {
        exitPayload = object
        exited.fulfill()
      }
    }
    let terminalId = try service.open(
      threadId: "t1",
      cwd: FileManager.default.temporaryDirectory.path,
      columns: 80,
      rows: 24
    )
    // Give the login shell a moment, then run a marker command and exit.
    try? await Task.sleep(nanoseconds: 800_000_000)
    try service.resize(terminalId: terminalId, columns: 120, rows: 40)
    try service.write(terminalId: terminalId, data: "printf 'pty-marker-%s\\n' works; exit\n")
    await fulfillment(of: [exited], timeout: 15)
    XCTAssertTrue(output.contains("pty-marker-works"), "PTY output missing marker: \(output.suffix(400))")
    XCTAssertEqual(exitPayload?["threadId"], .string("t1"))
    await service.stopAll()
  }

  func testCloseKillsHungShell() async throws {
    let exited = expectation(description: "exit")
    let service = PtyService { payload in
      if payload.objectValue?["type"]?.stringValue == "exit" { exited.fulfill() }
    }
    let terminalId = try service.open(
      threadId: "t1",
      cwd: FileManager.default.temporaryDirectory.path,
      columns: 80,
      rows: 24
    )
    try? await Task.sleep(nanoseconds: 500_000_000)
    await service.closeTerminal(terminalId)
    await fulfillment(of: [exited], timeout: 5)
    XCTAssertThrowsError(try service.write(terminalId: terminalId, data: "x"))
  }

  func testUtf8TailHoldback() {
    // "é" is 0xC3 0xA9; split across chunks it must not become U+FFFD.
    let first = PtyService.decodeKeepingIncompleteTail(Data([0x61, 0xC3]))
    XCTAssertEqual(first.text, "a")
    XCTAssertEqual([UInt8](first.tail), [0xC3])
    var next = first.tail
    next.append(contentsOf: [0xA9, 0x62])
    let second = PtyService.decodeKeepingIncompleteTail(next)
    XCTAssertEqual(second.text, "éb")
    XCTAssertTrue(second.tail.isEmpty)
  }
}
