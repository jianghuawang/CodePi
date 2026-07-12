import AppKit
import CodePiKit
import UniformTypeIdentifiers

/// Registers the Phase 1 + Phase 2 bridge channels — the Swift counterpart of
/// `registerIpc()` in the Electron main process. Channels not yet ported
/// (git/changes, terminal, preview, workspace, export) intentionally stay
/// unregistered so the router reports them as not implemented.
@MainActor
final class Backend {
  let store: StateStore
  let processes: PiProcessManager
  let terminals: PtyService
  private let events: EventDispatcher
  private var sessionsRecovered = false
  private weak var mainWindow: NSWindow?
  var openSettingsWindow: (() -> Void)?

  init(store: StateStore, events: EventDispatcher, mainWindow: NSWindow?) {
    self.store = store
    self.events = events
    self.mainWindow = mainWindow
    self.processes = PiProcessManager(store: store) { [events] payload in
      events.emit(channel: BridgeChannels.threadEvent, payload: payload)
    }
    self.terminals = PtyService { [events] payload in
      events.emit(channel: BridgeChannels.terminalEvent, payload: payload)
    }
  }

  // MARK: - Registration

  func registerMainChannels(on router: BridgeRouter) {
    router.register(BridgeChannels.bootstrap) { [self] _ in try await bootstrap() }
    router.register(BridgeChannels.addProject) { [self] _ in try await addProject() }
    router.register(BridgeChannels.toggleProject) { [self] args in
      let projectId = try requireString(args, 0, "projectId")
      let expanded = try requireBool(args, 1, "expanded")
      _ = try store.project(projectId)
      store.update { state in
        guard let index = state.projects.firstIndex(where: { $0.id == projectId }) else { return }
        state.projects[index].expanded = expanded
      }
      return nil
    }
    router.register(BridgeChannels.selectThread) { [self] args in
      let threadId = args.first?.stringValue
      if let threadId {
        let thread = try store.thread(threadId)
        if thread.deletedAt != nil { throw BridgeError("Restore this thread before opening it") }
      }
      store.update { state in
        state.selectedThreadId = threadId
        if let threadId, let index = state.threads.firstIndex(where: { $0.id == threadId }) {
          state.threads[index].unread = false
        }
      }
      return nil
    }
    router.register(BridgeChannels.createThread) { [self] args in
      try await createThread(args.first ?? .null)
    }
    router.register(BridgeChannels.deleteThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      _ = try store.thread(threadId)
      await processes.close(threadId)
      await terminals.closeThread(threadId)
      _ = try ThreadLibrary.softTrashThread(store: store, threadId: threadId)
      return nil
    }
    router.register(BridgeChannels.restoreThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      let thread = try store.thread(threadId)
      guard thread.deletedAt != nil else { throw BridgeError("Thread is not in Trash") }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: thread.cwd, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw BridgeError("The thread working directory no longer exists. Restore it before restoring the thread.")
      }
      return try ThreadLibrary.restoreTrashedThread(store: store, threadId: threadId).payload
    }
    router.register(BridgeChannels.purgeThread) { [self] args in
      try await purgeThread(threadId: requireString(args, 0, "threadId"))
    }
    router.register(BridgeChannels.duplicateThread) { [self] args in
      try await duplicateThread(threadId: requireString(args, 0, "threadId"))
    }
    router.register(BridgeChannels.branchThread) { [self] args in
      let sourceThreadId = try requireString(args, 0, "sourceThreadId")
      let entryId = try requireString(args, 1, "entryId")
      let source = try store.thread(sourceThreadId)
      return try await createThread(.object([
        "projectId": .string(source.projectId),
        "isolated": .bool(false),
        "branchFrom": .object(["sourceThreadId": .string(sourceThreadId), "entryId": .string(entryId)])
      ]))
    }
    router.register(BridgeChannels.updateThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      let previous = try store.thread(threadId)
      let update = try ThreadUpdate(from: args.count > 1 ? args[1] : .null)
      let updated = try ThreadLibrary.updateThreadMetadata(store: store, threadId: threadId, update: update)
      if updated.title != previous.title {
        await processes.setSessionName(threadId, name: updated.title)
      }
      if updated.archived && !previous.archived {
        await processes.close(threadId)
        await terminals.closeThread(threadId)
        store.update { state in
          if state.selectedThreadId == threadId { state.selectedThreadId = nil }
        }
      }
      return try store.thread(threadId).payload
    }

    router.register(BridgeChannels.openThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      if try store.thread(threadId).deletedAt != nil { throw BridgeError("Restore this thread before opening it") }
      return try await processes.open(threadId)
    }
    router.register(BridgeChannels.restartThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      if try store.thread(threadId).deletedAt != nil { throw BridgeError("Restore this thread before opening it") }
      return try await processes.restart(threadId)
    }
    router.register(BridgeChannels.restartThreadWithoutCapabilities) { [self] args in
      // Capability discovery is not ported yet; a plain restart is the
      // closest safe behavior.
      try await processes.restart(requireString(args, 0, "threadId"))
    }
    router.register(BridgeChannels.sendMessage) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      let thread = try store.thread(threadId)
      if thread.deletedAt != nil { throw BridgeError("Restore this thread before sending") }
      if thread.archived { throw BridgeError("Unarchive this thread before sending") }
      let message = try requireString(args, 1, "message")
      guard message.count <= 2_000_000 else { throw BridgeError("message is invalid") }
      let mode = try requireString(args, 2, "mode")
      guard ["prompt", "steer", "followUp"].contains(mode) else { throw BridgeError("Delivery mode is invalid") }
      let attachments = args.count > 3 ? (args[3].arrayValue ?? []) : []
      guard attachments.count <= 12 else { throw BridgeError("A maximum of 12 attachments is allowed") }
      try await processes.send(threadId, message: message, mode: mode, attachments: attachments)
      return nil
    }
    router.register(BridgeChannels.abortThread) { [self] args in
      try await processes.abort(requireString(args, 0, "threadId"))
      return nil
    }
    router.register(BridgeChannels.setModel) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      _ = try store.thread(threadId)
      return try await processes.setModel(
        threadId,
        provider: requireString(args, 1, "provider"),
        modelId: requireString(args, 2, "model")
      )
    }
    router.register(BridgeChannels.setThinkingLevel) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      _ = try store.thread(threadId)
      let level = try requireString(args, 1, "thinkingLevel")
      guard ["off", "minimal", "low", "medium", "high", "xhigh"].contains(level) else {
        throw BridgeError("Invalid thinking level")
      }
      return try await processes.setThinkingLevel(threadId, level: level)
    }
    router.register(BridgeChannels.getCommands) { [self] args in
      try await processes.commands(requireString(args, 0, "threadId"))
    }
    router.register(BridgeChannels.compactThread) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      let instructions = args.count > 1 ? args[1].stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
      return try await processes.compact(threadId, customInstructions: instructions?.isEmpty == false ? instructions : nil)
    }
    router.register(BridgeChannels.setAutoCompaction) { [self] args in
      try await processes.setAutoCompaction(requireString(args, 0, "threadId"), enabled: requireBool(args, 1, "enabled"))
    }
    router.register(BridgeChannels.setAutoRetry) { [self] args in
      try await processes.setAutoRetry(requireString(args, 0, "threadId"), enabled: requireBool(args, 1, "enabled"))
    }
    router.register(BridgeChannels.getHistory) { [self] args in
      try await processes.history(requireString(args, 0, "threadId"))
    }
    router.register(BridgeChannels.getCapabilities) { [self] args in
      _ = try store.thread(requireString(args, 0, "threadId"))
      // Capability discovery ships in a later increment; Pi currently runs
      // with its default extension/skill discovery.
      return .array([])
    }
    router.register(BridgeChannels.setCapabilityEnabled) { _ in
      throw BridgeError("Per-thread extensions and skills are not ported to the Swift shell yet")
    }

    router.register(BridgeChannels.listPromptTemplates) { [self] _ in
      ThreadLibrary.listPromptTemplates(store: store)
    }
    router.register(BridgeChannels.savePromptTemplate) { [self] args in
      guard let record = args.first?.objectValue, let title = record["title"]?.stringValue,
            let prompt = record["prompt"]?.stringValue else {
        throw BridgeError("Prompt template is invalid")
      }
      try ThreadLibrary.savePromptTemplate(store: store, id: record["id"]?.stringValue, title: title, prompt: prompt)
      return ThreadLibrary.listPromptTemplates(store: store)
    }
    router.register(BridgeChannels.deletePromptTemplate) { [self] args in
      try ThreadLibrary.deletePromptTemplate(store: store, id: requireString(args, 0, "templateId"))
      return ThreadLibrary.listPromptTemplates(store: store)
    }
    router.register(BridgeChannels.getUsageDashboard) { [self] args in
      let projectId = args.first?.stringValue
      if let projectId { _ = try store.project(projectId) }
      return ThreadLibrary.usageDashboard(entries: store.snapshot().usageLedger, projectId: projectId)
    }
    router.register(BridgeChannels.searchThreads) { [self] args in
      searchThreadsMetadata(query: args.first?.stringValue ?? "")
    }
    router.register(BridgeChannels.pickAttachments) { [self] args in
      _ = try store.thread(requireString(args, 0, "threadId"))
      return await pickAttachments()
    }
    // Graceful degradation until the workspace service is ported: the
    // composer's @-mention flows treat empty results as "nothing found".
    router.register(BridgeChannels.searchProjectFiles) { _ in .array([]) }
    router.register(BridgeChannels.getRecentFiles) { _ in .array([]) }

    router.register(BridgeChannels.openSettings) { [self] _ in
      openSettingsWindow?()
      return nil
    }

    // MARK: Git and worktrees (Phase 3)

    router.register(BridgeChannels.getChanges) { [self] args in
      let thread = try store.thread(requireString(args, 0, "threadId"))
      guard try store.project(thread.projectId).isGit else { return .array([]) }
      return try await GitService.getChanges(thread: thread)
    }
    router.register(BridgeChannels.setFileStaged) { [self] args in
      let thread = try store.thread(requireString(args, 0, "threadId"))
      guard try store.project(thread.projectId).isGit else { return nil }
      let requestedPath = try requireRepoPath(args, 1)
      let staged = try requireBool(args, 2, "staged")
      let files = try await GitService.getChanges(thread: thread).arrayValue ?? []
      let selected = files.first { file in
        let object = file.objectValue
        let current = object?["to"]?.stringValue?.isEmpty == false
          ? object?["to"]?.stringValue
          : object?["from"]?.stringValue
        return current == requestedPath
      }
      var paths = [requestedPath]
      if let object = selected?.objectValue {
        paths = [object["from"]?.stringValue, object["to"]?.stringValue]
          .compactMap { $0 }
          .filter { !$0.isEmpty }
        if paths.isEmpty { paths = [requestedPath] }
      }
      try await GitService.setFileStaged(cwd: thread.cwd, files: paths, staged: staged)
      return nil
    }
    router.register(BridgeChannels.commit) { [self] args in
      guard let input = args.first?.objectValue,
            let threadId = input["threadId"]?.stringValue,
            let rawMessage = input["message"]?.stringValue,
            let push = input["push"]?.boolValue else {
        throw BridgeError("Commit input is invalid")
      }
      let message = rawMessage.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !message.isEmpty, message.count <= 20_000 else { throw BridgeError("Commit message is invalid") }
      let thread = try store.thread(threadId)
      guard try store.project(thread.projectId).isGit else { throw BridgeError("This project is not a Git repository") }
      return try await GitService.commitChanges(thread: thread, message: message, push: push)
    }
    router.register(BridgeChannels.applyToMain) { [self] args in
      let thread = try store.thread(requireString(args, 0, "threadId"))
      let project = try store.project(thread.projectId)
      try await GitService.applyWorktreeToMain(projectPath: project.path, thread: thread)
      return nil
    }
    router.register(BridgeChannels.openInEditor) { [self] args in
      let thread = try store.thread(requireString(args, 0, "threadId"))
      let result = await ProcessRunner.run(
        command: ["code", thread.cwd],
        cwd: thread.cwd,
        env: PiEnvironment.environmentForPi(store.snapshot().settings.env),
        timeout: 15
      )
      if result.status != 0 {
        NSWorkspace.shared.open(URL(fileURLWithPath: thread.cwd))
      }
      return nil
    }

    // MARK: Terminal (Phase 4)

    router.register(BridgeChannels.openTerminal) { [self] args in
      let threadId = try requireString(args, 0, "threadId")
      let thread = try store.thread(threadId)
      let columns = try requireInteger(args, 1, "columns")
      let rows = try requireInteger(args, 2, "rows")
      let terminalId = try terminals.open(threadId: threadId, cwd: thread.cwd, columns: columns, rows: rows)
      return .object(["terminalId": .string(terminalId)])
    }
    router.register(BridgeChannels.writeTerminal) { [self] args in
      let terminalId = try requireString(args, 0, "terminalId")
      let data = args.count > 1 ? (args[1].stringValue ?? "") : ""
      try terminals.write(terminalId: terminalId, data: data)
      return nil
    }
    router.register(BridgeChannels.resizeTerminal) { [self] args in
      try terminals.resize(
        terminalId: requireString(args, 0, "terminalId"),
        columns: requireInteger(args, 1, "columns"),
        rows: requireInteger(args, 2, "rows")
      )
      return nil
    }
    router.register(BridgeChannels.closeTerminal) { [self] args in
      await terminals.closeTerminal(try requireString(args, 0, "terminalId"))
      return nil
    }
  }

  func registerSettingsChannels(on router: BridgeRouter) {
    router.register(BridgeChannels.getSettings) { [self] _ in
      store.snapshot().settings.payload
    }
    router.register(BridgeChannels.saveSettings) { [self] args in
      let settings = StateNormalizer.normalizeSettings(args.first)
      let validation = await PiEnvironment.validatePiBinary(path: settings.piPath, env: settings.env)
      guard validation.available else { throw BridgeError(validation.error ?? "Pi is unavailable") }
      store.update { state in state.settings = settings }
      Theme.apply(settings.theme)
      return settings.payload
    }
    router.register(BridgeChannels.validatePi) { [self] args in
      let path = try requireString(args, 0, "Pi path")
      return await PiEnvironment.validatePiBinary(path: path, env: store.snapshot().settings.env).payload
    }
  }

  // MARK: - Handlers

  private func bootstrap() async throws -> JSONValue {
    if !sessionsRecovered {
      sessionsRecovered = true
      recoverSessions()
    }
    let settings = store.snapshot().settings
    let validation = await PiEnvironment.validatePiBinary(path: settings.piPath, env: settings.env)
    return .object([
      "state": store.snapshot().publicPayload,
      "pi": validation.payload,
      "platform": .string("darwin")
    ])
  }

  private func recoverSessions() {
    let snapshot = store.snapshot()
    let discovered = Sessions.discoverProjectSessions(
      projects: snapshot.projects,
      knownThreads: snapshot.threads,
      env: snapshot.settings.env
    )
    store.update { state in
      for index in state.threads.indices where ["running", "waiting"].contains(state.threads[index].status) {
        state.threads[index].status = "idle"
      }
      var existing = Set(state.threads.compactMap { thread in
        thread.sessionFile.map { URL(fileURLWithPath: $0).standardizedFileURL.path }
      })
      let dismissed = Set(state.dismissedSessionFiles.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
      for project in state.projects {
        for session in discovered[project.id] ?? [] {
          let file = URL(fileURLWithPath: session.file).standardizedFileURL.path
          if existing.contains(file) || dismissed.contains(file) { continue }
          var id = Sessions.recoveredThreadId(sessionFile: file)
          var suffix = 1
          while state.threads.contains(where: { $0.id == id }) {
            id = "\(Sessions.recoveredThreadId(sessionFile: file))-\(suffix)"
            suffix += 1
          }
          state.threads.append(ThreadRecord(
            id: id,
            projectId: project.id,
            title: session.title,
            cwd: session.cwd,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            sessionFile: file,
            autoRetryEnabled: state.threads.first?.autoRetryEnabled ?? true
          ))
          existing.insert(file)
        }
      }
      if let selected = state.selectedThreadId, !state.threads.contains(where: { $0.id == selected }) {
        state.selectedThreadId = nil
      }
    }
  }

  private func addProject() async throws -> JSONValue {
    let panel = NSOpenPanel()
    panel.title = "Add Project"
    panel.prompt = "Add Project"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    let response = await runPanel(panel)
    guard response == .OK, let url = panel.url else { return .null }
    let path = url.resolvingSymlinksInPath().standardizedFileURL.path
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw BridgeError("Select a folder")
    }
    if let duplicate = store.snapshot().projects.first(where: {
      URL(fileURLWithPath: $0.path).standardizedFileURL.path == path
    }) {
      return duplicate.payload
    }
    let project = ProjectRecord(
      id: UUID().uuidString.lowercased(),
      name: url.lastPathComponent,
      path: path,
      isGit: await PiEnvironment.isGitProject(path),
      expanded: true,
      createdAt: nowMilliseconds()
    )
    store.update { state in state.projects.append(project) }
    return project.payload
  }

  private func createThread(_ input: JSONValue) async throws -> JSONValue {
    guard let record = input.objectValue, let projectId = record["projectId"]?.stringValue else {
      throw BridgeError("Thread input is invalid")
    }
    let project = try store.project(projectId)
    let id = UUID().uuidString.lowercased()
    let now = nowMilliseconds()
    var cwd = project.path
    var worktree: WorktreeRecord?
    let isolated = record["isolated"]?.boolValue == true

    var source: ThreadRecord?
    if let branch = record["branchFrom"]?.objectValue {
      guard let sourceThreadId = branch["sourceThreadId"]?.stringValue,
            branch["entryId"]?.stringValue != nil else {
        throw BridgeError("Branch input is invalid")
      }
      source = try store.thread(sourceThreadId)
      guard source?.projectId == project.id else { throw BridgeError("History can only branch within its project") }
    }

    let autoRetry = store.snapshot().threads.first?.autoRetryEnabled ?? true
    func threadRecord(title: String, sessionFile: String?) -> ThreadRecord {
      ThreadRecord(
        id: id,
        projectId: project.id,
        title: title,
        cwd: cwd,
        createdAt: now,
        updatedAt: now,
        sessionFile: sessionFile,
        worktree: worktree,
        autoRetryEnabled: autoRetry
      )
    }

    var sessionFile: String?
    do {
      if isolated && project.isGit {
        worktree = try await GitService.createWorktree(
          projectPath: project.path,
          threadId: id,
          seed: source?.worktree != nil ? source : nil
        )
        cwd = worktree!.path
        if let source, source.worktree != nil {
          try await GitService.copyWorktreeState(source: source, target: threadRecord(title: "New thread", sessionFile: nil))
        }
      }
      if record["branchFrom"]?.objectValue != nil {
        var branchSource = source!
        if branchSource.sessionFile == nil {
          _ = try await processes.open(branchSource.id)
          branchSource = try store.thread(branchSource.id)
        }
        guard let sourceFile = branchSource.sessionFile else {
          throw BridgeError("The source thread does not have a Pi session yet")
        }
        sessionFile = try Sessions.cloneSessionBranch(
          sourceFile: sourceFile,
          entryId: record["branchFrom"]!.objectValue!["entryId"]!.stringValue!,
          targetCwd: cwd,
          env: store.snapshot().settings.env,
          rewindSelectedUser: true
        )
      }
    } catch {
      if worktree != nil {
        try? await GitService.removeWorktree(
          projectPath: project.path,
          thread: threadRecord(title: "New thread", sessionFile: nil)
        )
      }
      throw error
    }

    let rawTitle = record["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = rawTitle?.isEmpty == false
      ? rawTitle!
      : source.map { "Branch of \($0.title)" } ?? "New thread"
    let thread = threadRecord(title: title, sessionFile: sessionFile)
    store.update { state in
      state.threads.insert(thread, at: 0)
      state.selectedThreadId = thread.id
    }
    return thread.payload
  }

  private func duplicateThread(threadId: String) async throws -> JSONValue {
    let source = try store.thread(threadId)
    if source.deletedAt != nil { throw BridgeError("Restore this thread before duplicating it") }
    let project = try store.project(source.projectId)
    let id = UUID().uuidString.lowercased()
    let now = nowMilliseconds()
    let title = String("Copy of \(source.title)".prefix(240))
    var cwd = project.path
    var worktree: WorktreeRecord?
    var sessionFile: String?

    func threadRecord(_ sessionFile: String?) -> ThreadRecord {
      ThreadRecord(
        id: id,
        projectId: source.projectId,
        title: title,
        cwd: cwd,
        createdAt: now,
        updatedAt: now,
        sessionFile: sessionFile,
        worktree: worktree,
        tags: source.tags,
        disabledCapabilityIds: source.disabledCapabilityIds,
        autoRetryEnabled: source.autoRetryEnabled
      )
    }

    do {
      if source.worktree != nil && project.isGit {
        worktree = try await GitService.createWorktree(projectPath: project.path, threadId: id, seed: source)
        cwd = worktree!.path
        try await GitService.copyWorktreeState(source: source, target: threadRecord(nil))
      }
      if let sourceFile = source.sessionFile {
        let history = try Sessions.readSessionTree(sessionFile: sourceFile)
        if let leafId = history.leafId.stringValue {
          sessionFile = try Sessions.cloneSessionBranch(
            sourceFile: sourceFile,
            entryId: leafId,
            targetCwd: cwd,
            env: store.snapshot().settings.env,
            rewindSelectedUser: false
          )
        }
      }
    } catch {
      if worktree != nil {
        try? await GitService.removeWorktree(projectPath: project.path, thread: threadRecord(nil))
      }
      throw error
    }

    let thread = threadRecord(sessionFile)
    store.update { state in
      state.threads.insert(thread, at: 0)
      state.selectedThreadId = thread.id
    }
    return thread.payload
  }

  private func purgeThread(threadId: String) async throws -> JSONValue? {
    let thread = try store.thread(threadId)
    guard thread.deletedAt != nil else { throw BridgeError("Move the thread to Trash before deleting it permanently") }
    let project = try store.project(thread.projectId)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Delete “\(thread.title)” permanently?"
    alert.informativeText = "Its CodePi metadata and session listing will be removed. This cannot be undone."
    if thread.worktree != nil {
      let risk = await GitService.worktreeRemovalRisk(thread: thread)
      if risk.dirty || risk.unpushedCommits > 0 {
        var details: [String] = []
        if risk.dirty { details.append("uncommitted changes") }
        if risk.unpushedCommits > 0 {
          details.append("\(risk.unpushedCommits) unpushed commit\(risk.unpushedCommits == 1 ? "" : "s")")
        }
        alert.messageText = "This isolated worktree has \(details.joined(separator: " and "))."
        alert.informativeText = "Permanent deletion removes its local worktree and branch. This cannot be undone."
      }
    }
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Delete Permanently")
    let response: NSApplication.ModalResponse
    if let mainWindow {
      response = await alert.beginSheetModal(for: mainWindow)
    } else {
      response = alert.runModal()
    }
    guard response == .alertSecondButtonReturn else { throw BridgeError("Permanent deletion was cancelled") }
    await processes.close(threadId)
    await terminals.closeThread(threadId)
    if thread.worktree != nil {
      try await GitService.removeWorktree(projectPath: project.path, thread: thread)
    }
    store.update { state in
      state.threads.removeAll { $0.id == threadId }
      if let sessionFile = thread.sessionFile {
        let resolved = URL(fileURLWithPath: sessionFile).standardizedFileURL.path
        if !state.dismissedSessionFiles.contains(resolved) {
          state.dismissedSessionFiles.append(resolved)
        }
      }
      if state.selectedThreadId == threadId { state.selectedThreadId = nil }
    }
    return nil
  }

  private func searchThreadsMetadata(query: String) -> JSONValue {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    let snapshot = store.snapshot()
    let projectNames = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.id, $0.name) })
    let matches = snapshot.threads
      .filter { $0.deletedAt == nil }
      .filter { thread in
        needle.isEmpty
          || thread.title.lowercased().contains(needle)
          || thread.cwd.lowercased().contains(needle)
          || thread.tags.contains { $0.lowercased().contains(needle) }
          || (projectNames[thread.projectId]?.lowercased().contains(needle) ?? false)
      }
      .sorted { $0.updatedAt > $1.updatedAt }
      .prefix(80)
    return .array(matches.map { thread in
      .object([
        "threadId": .string(thread.id),
        "projectId": .string(thread.projectId),
        "title": .string(thread.title),
        "snippet": .string(projectNames[thread.projectId] ?? ""),
        "timestamp": .number(thread.updatedAt)
      ])
    })
  }

  private func pickAttachments() async -> JSONValue {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    let response = await runPanel(panel)
    guard response == .OK else { return .array([]) }
    var attachments: [JSONValue] = []
    for url in panel.urls.prefix(12) {
      guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]), let size = values.fileSize else { continue }
      let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
      var attachment: [String: JSONValue] = [
        "id": .string(UUID().uuidString.lowercased()),
        "name": .string(url.lastPathComponent),
        "mimeType": .string(mime),
        "size": .number(Double(size))
      ]
      if mime.hasPrefix("image/"), size <= 10 * 1024 * 1024, let data = try? Data(contentsOf: url) {
        attachment["kind"] = .string("image")
        attachment["data"] = .string(data.base64EncodedString())
      } else if size <= 256 * 1024,
                let data = try? Data(contentsOf: url),
                let text = String(data: data, encoding: .utf8) {
        attachment["kind"] = .string("text")
        attachment["text"] = .string(text)
      } else {
        attachment["kind"] = .string("file")
        attachment["path"] = .string(url.path)
      }
      attachments.append(.object(attachment))
    }
    return .array(attachments)
  }

  private func runPanel(_ panel: NSOpenPanel) async -> NSApplication.ModalResponse {
    if let mainWindow {
      return await panel.beginSheetModal(for: mainWindow)
    }
    return panel.runModal()
  }
}

// MARK: - Argument helpers (validation.ts posture: renderer input is untrusted)

func requireString(_ args: [JSONValue], _ index: Int, _ name: String) throws -> String {
  guard args.count > index, let value = args[index].stringValue, !value.isEmpty, !value.contains("\0") else {
    throw BridgeError("\(name) is invalid")
  }
  return value
}

func requireBool(_ args: [JSONValue], _ index: Int, _ name: String) throws -> Bool {
  guard args.count > index, let value = args[index].boolValue else {
    throw BridgeError("\(name) is invalid")
  }
  return value
}

func requireInteger(_ args: [JSONValue], _ index: Int, _ name: String) throws -> Int {
  guard args.count > index, let value = args[index].numberValue, value == value.rounded() else {
    throw BridgeError("\(name) is invalid")
  }
  return Int(value)
}

/// A repository-relative path: never absolute, never traversing upward.
func requireRepoPath(_ args: [JSONValue], _ index: Int) throws -> String {
  let value = try requireString(args, index, "path")
  let components = value.components(separatedBy: "/")
  guard !value.hasPrefix("/"), !value.hasPrefix("~"), !components.contains(".."), value.count <= 4_096 else {
    throw BridgeError("path is invalid")
  }
  return value
}

@MainActor
enum Theme {
  static func apply(_ theme: String) {
    switch theme {
    case "light": NSApp.appearance = NSAppearance(named: .aqua)
    case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
    default: NSApp.appearance = nil
    }
  }
}
