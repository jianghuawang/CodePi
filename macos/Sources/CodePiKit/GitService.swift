import Foundation

/// Port of `git-service.ts`. Every git invocation uses argument arrays via
/// /usr/bin/env (never an interpolated shell) with `core.quotepath=false`.
public enum GitService {
  @discardableResult
  static func git(
    _ cwd: String,
    _ args: [String],
    acceptedCodes: [Int32] = [0],
    input: String? = nil
  ) async throws -> String {
    let result = await ProcessRunner.run(
      command: ["git", "-c", "core.quotepath=false"] + args,
      cwd: cwd,
      env: PiEnvironment.environmentForPi([:]),
      timeout: 300,
      stdin: input
    )
    if acceptedCodes.contains(result.status) { return result.stdout }
    let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
    let fallback = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    throw BridgeError(detail.isEmpty ? (fallback.isEmpty ? "git \(args.first ?? "") failed" : fallback) : detail)
  }

  static func validThreadId(_ id: String) throws {
    guard id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$", options: .regularExpression) != nil else {
      throw BridgeError("Invalid thread identifier")
    }
  }

  static func pathWithin(parent: String, child: String) -> Bool {
    let parentURL = URL(fileURLWithPath: parent).standardizedFileURL.path
    let childURL = URL(fileURLWithPath: child).standardizedFileURL.path
    return childURL != parentURL && childURL.hasPrefix(parentURL + "/")
  }

  static func excludePiGui(projectPath: String) async {
    guard let excludePath = try? await git(projectPath, ["rev-parse", "--git-path", "info/exclude"]) else { return }
    let absolute = URL(fileURLWithPath: projectPath)
      .appendingPathComponent(excludePath.trimmingCharacters(in: .whitespacesAndNewlines))
      .standardizedFileURL
    let existing = (try? String(contentsOf: absolute, encoding: .utf8)) ?? ""
    if existing.components(separatedBy: .newlines).contains(".pi-gui/") { return }
    let prefix = existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n"
    try? FileManager.default.createDirectory(
      at: absolute.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? Data((existing + prefix + ".pi-gui/\n").utf8).write(to: absolute)
  }

  // MARK: - Worktrees

  public static func createWorktree(projectPath: String, threadId: String, seed: ThreadRecord?) async throws -> WorktreeRecord {
    try validThreadId(threadId)
    let projectCommit = try await git(projectPath, ["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
    if let seed, seed.worktree == nil { throw BridgeError("The source thread is not isolated") }
    if let base = seed?.worktree?.baseCommit,
       base.range(of: "^[0-9a-f]{40,64}$", options: [.regularExpression, .caseInsensitive]) == nil {
      throw BridgeError("The source worktree base commit is invalid")
    }
    let startCommit: String
    if let seed, seed.worktree != nil {
      startCommit = try await git(seed.cwd, ["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      startCommit = projectCommit
    }
    let baseCommit = seed?.worktree?.baseCommit ?? projectCommit
    var baseBranch: String
    if let seeded = seed?.worktree?.baseBranch {
      baseBranch = seeded
    } else {
      baseBranch = try await git(projectPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], acceptedCodes: [0, 1])
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if baseBranch.isEmpty {
      baseBranch = try await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if baseBranch.isEmpty || baseBranch == "HEAD" {
      throw BridgeError("Create a branch before using an isolated worktree")
    }
    let branch = "pi/\(threadId)"
    let worktreePath = URL(fileURLWithPath: projectPath)
      .appendingPathComponent(".pi-gui/worktrees/\(threadId)").standardizedFileURL.path
    guard pathWithin(parent: projectPath, child: worktreePath) else { throw BridgeError("Invalid worktree path") }
    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: worktreePath).deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    await excludePiGui(projectPath: projectPath)
    do {
      try await git(projectPath, ["worktree", "add", "-b", branch, worktreePath, startCommit])
    } catch {
      _ = try? await git(projectPath, ["worktree", "remove", "--force", worktreePath])
      try? FileManager.default.removeItem(atPath: worktreePath)
      _ = try? await git(projectPath, ["worktree", "prune"])
      _ = try? await git(projectPath, ["branch", "-D", branch])
      throw error
    }
    return WorktreeRecord(path: worktreePath, branch: branch, baseBranch: baseBranch, baseCommit: baseCommit)
  }

  /// Copy the source worktree's tracked and untracked working state onto a
  /// freshly seeded worktree.
  public static func copyWorktreeState(source: ThreadRecord, target: ThreadRecord) async throws {
    guard source.worktree != nil, target.worktree != nil else { return }
    let patch = try await git(source.cwd, ["diff", "--binary", "HEAD", "--"])
    if !patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      try await git(target.cwd, ["apply", "--whitespace=nowarn", "--"], input: patch)
    }
    let untracked = (try await git(source.cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]))
      .split(separator: "\0").map(String.init).prefix(5_000)
    for relativePath in untracked {
      let from = URL(fileURLWithPath: source.cwd).appendingPathComponent(relativePath).standardizedFileURL.path
      let to = URL(fileURLWithPath: target.cwd).appendingPathComponent(relativePath).standardizedFileURL.path
      guard pathWithin(parent: source.cwd, child: from), pathWithin(parent: target.cwd, child: to) else { continue }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: from, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
      try? FileManager.default.createDirectory(
        at: URL(fileURLWithPath: to).deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try? FileManager.default.copyItem(atPath: from, toPath: to)
    }
  }

  public static func removeWorktree(projectPath: String, thread: ThreadRecord) async throws {
    guard let worktree = thread.worktree else { return }
    try validThreadId(thread.id)
    let expected = URL(fileURLWithPath: projectPath)
      .appendingPathComponent(".pi-gui/worktrees/\(thread.id)").standardizedFileURL.path
    guard URL(fileURLWithPath: worktree.path).standardizedFileURL.path == expected,
          pathWithin(parent: projectPath, child: expected) else {
      throw BridgeError("Refusing to remove an unexpected worktree path")
    }
    do {
      try await git(projectPath, ["worktree", "remove", "--force", expected])
    } catch {
      _ = try? await git(projectPath, ["worktree", "unlock", expected])
      do {
        try await git(projectPath, ["worktree", "remove", "--force", expected])
      } catch {
        try? FileManager.default.removeItem(atPath: expected)
        try await git(projectPath, ["worktree", "prune"])
      }
    }
    _ = try? await git(projectPath, ["branch", "-D", worktree.branch])
  }

  public static func worktreeRemovalRisk(thread: ThreadRecord) async -> (dirty: Bool, unpushedCommits: Int) {
    guard let worktree = thread.worktree else { return (false, 0) }
    let status = (try? await git(worktree.path, ["status", "--porcelain"])) ?? ""
    let dirty = !status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let upstream = ((try? await git(
      worktree.path,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      acceptedCodes: [0, 1, 128]
    )) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let range = upstream.isEmpty ? "\(worktree.baseCommit)..HEAD" : "@{upstream}..HEAD"
    let count = (try? await git(worktree.path, ["rev-list", "--count", range]))?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (dirty, Int(count ?? "0") ?? 0)
  }

  // MARK: - Changes, staging, commits

  public static func getChanges(thread: ThreadRecord) async throws -> JSONValue {
    let base = thread.worktree?.baseCommit ?? "HEAD"
    var raw: String
    do {
      raw = try await git(thread.cwd, ["diff", "--no-ext-diff", "--no-color", "--find-renames", base, "--"])
    } catch {
      let unstaged = (try? await git(thread.cwd, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--"])) ?? ""
      let staged = (try? await git(thread.cwd, ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--"])) ?? ""
      raw = unstaged + "\n" + staged
    }
    let stagedOutput = (try? await git(thread.cwd, ["diff", "--cached", "--name-only", "-z", "--"])) ?? ""
    let stagedPaths = Set(stagedOutput.split(separator: "\0").map(String.init))
    var stageablePaths: Set<String>?
    if thread.worktree != nil {
      let output = (try? await git(thread.cwd, ["diff", "--name-only", "-z", "HEAD", "--"])) ?? ""
      stageablePaths = Set(output.split(separator: "\0").map(String.init))
    }
    var tracked = DiffParser.mapDiff(raw, stagedPaths: stagedPaths, stageablePaths: stageablePaths)
    var known = Set<String>()
    for file in tracked {
      if let from = file.objectValue?["from"]?.stringValue, !from.isEmpty { known.insert(from) }
      if let to = file.objectValue?["to"]?.stringValue, !to.isEmpty { known.insert(to) }
    }
    let untracked = (try await git(thread.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split(separator: "\0").map(String.init)
    for file in untracked.prefix(500) {
      if known.contains(file) { continue }
      let absolute = URL(fileURLWithPath: thread.cwd).appendingPathComponent(file).standardizedFileURL.path
      guard pathWithin(parent: thread.cwd, child: absolute) else { continue }
      let output = (try? await git(
        thread.cwd,
        ["diff", "--no-index", "--no-color", "--", "/dev/null", file],
        acceptedCodes: [0, 1]
      )) ?? ""
      for item in DiffParser.mapDiff(output, stagedPaths: stagedPaths, stageablePaths: nil) {
        guard var object = item.objectValue else { continue }
        if object["to"]?.stringValue?.isEmpty != false { object["to"] = .string(file) }
        object["staged"] = .bool(false)
        tracked.append(.object(object))
      }
    }
    return .array(tracked)
  }

  public static func setFileStaged(cwd: String, files: [String], staged: Bool) async throws {
    var seen = Set<String>()
    let paths = files.filter { !$0.isEmpty && seen.insert($0).inserted }
    guard !paths.isEmpty else { throw BridgeError("No file was selected") }
    for file in paths {
      let absolute = URL(fileURLWithPath: cwd).appendingPathComponent(file).standardizedFileURL.path
      guard pathWithin(parent: cwd, child: absolute) else { throw BridgeError("File is outside the working directory") }
    }
    if staged {
      try await git(cwd, ["add", "-A", "--"] + paths)
      return
    }
    do {
      try await git(cwd, ["restore", "--staged", "--"] + paths)
    } catch {
      try await git(cwd, ["reset", "-q", "HEAD", "--"] + paths)
    }
  }

  public static func commitChanges(thread: ThreadRecord, message: String, push: Bool) async throws -> JSONValue {
    let staged = try await git(thread.cwd, ["diff", "--cached", "--name-only", "--"])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !staged.isEmpty else { throw BridgeError("No files are staged. Stage the changes to commit first.") }
    try await git(thread.cwd, ["commit", "-m", message])
    let commit = try await git(thread.cwd, ["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
    if !push { return .object(["commit": .string(commit), "pushed": .bool(false)]) }
    let upstream = ((try? await git(
      thread.cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      acceptedCodes: [0, 1, 128]
    )) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if upstream.isEmpty {
      try await git(thread.cwd, ["push", "--set-upstream", "origin", "HEAD"])
    } else {
      try await git(thread.cwd, ["push"])
    }
    return .object(["commit": .string(commit), "pushed": .bool(true)])
  }

  public static func applyWorktreeToMain(projectPath: String, thread: ThreadRecord) async throws {
    guard let worktree = thread.worktree else { throw BridgeError("This thread is not using an isolated worktree") }
    let worktreeStatus = try await git(worktree.path, ["status", "--porcelain"])
    guard worktreeStatus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw BridgeError("Commit the worktree changes before applying them")
    }
    let mainStatus = try await git(projectPath, ["status", "--porcelain"])
    guard mainStatus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw BridgeError("The main working tree must be clean before applying changes")
    }
    let mainBranch = try await git(projectPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], acceptedCodes: [0, 1])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard mainBranch == worktree.baseBranch else {
      throw BridgeError("Switch the main working tree to \(worktree.baseBranch) before applying changes")
    }
    let commits = try await git(worktree.path, ["rev-list", "--reverse", "\(worktree.baseCommit)..\(worktree.branch)"])
      .split(separator: "\n").filter { !$0.isEmpty }
    if commits.isEmpty { return }
    let mainHead = try await git(projectPath, ["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
    if mainHead == worktree.baseCommit {
      try await git(projectPath, ["merge", "--ff-only", worktree.branch])
      return
    }
    let unapplied = try await git(worktree.path, ["cherry", worktree.baseBranch, worktree.branch])
      .split(separator: "\n")
      .filter { $0.hasPrefix("+ ") }
      .map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if unapplied.isEmpty { return }
    do {
      try await git(projectPath, ["cherry-pick"] + unapplied)
    } catch {
      _ = try? await git(projectPath, ["cherry-pick", "--abort"])
      throw error
    }
  }
}
