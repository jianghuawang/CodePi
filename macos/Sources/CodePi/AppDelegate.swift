import AppKit
import CodePiKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var windowController: MainWindowController?
  private var settingsController: SettingsWindowController?
  private var themeObserver: ThemeObserver?
  private var menuRelay: MenuActionRelay?
  private var backend: Backend?
  private var store: StateStore?
  private var resources: ShellResources?
  private var terminating = false

  /// The release bundle id reuses the Electron app-support directory for a
  /// seamless swap; every other build (dev bundle id, `swift run`) stays in
  /// its own directory unless CODEPI_STATE_DIR points elsewhere.
  static func stateDirectory() -> URL {
    if let override = ProcessInfo.processInfo.environment["CODEPI_STATE_DIR"], !override.isEmpty {
      return URL(fileURLWithPath: override)
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let name = Bundle.main.bundleIdentifier == "works.earendil.codepi" ? "CodePi" : "CodePiDev"
    return support.appendingPathComponent(name, isDirectory: true)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let resources = ShellResources.locate()
    self.resources = resources

    let directory = Self.stateDirectory()
    let store: StateStore
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      store = try StateStore.open(directory: directory)
    } catch {
      let alert = NSAlert()
      alert.messageText = "CodePi could not start"
      alert.informativeText = (error as? BridgeError)?.message ?? error.localizedDescription
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    self.store = store
    Theme.apply(store.snapshot().settings.theme)

    let mainRouter = BridgeRouter()
    let controller = MainWindowController(resources: resources, router: mainRouter)
    windowController = controller

    let backend = Backend(store: store, events: controller.events, mainWindow: controller.window)
    self.backend = backend
    backend.registerMainChannels(on: mainRouter)
    backend.registerSettingsChannels(on: mainRouter)
    backend.openSettingsWindow = { [weak self] in self?.showSettings() }

    let relay = MenuActionRelay { [weak controller] action in
      controller?.events.emit(channel: BridgeChannels.menuAction, payload: .string(action))
      controller?.window?.makeKeyAndOrderFront(nil)
    }
    menuRelay = relay
    NSApp.mainMenu = MenuBuilder.build(relay: relay)

    themeObserver = ThemeObserver { [weak self] theme in
      self?.windowController?.events.emit(channel: BridgeChannels.themeChanged, payload: .string(theme))
      self?.settingsController?.events.emit(channel: BridgeChannels.themeChanged, payload: .string(theme))
    }

    controller.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func showSettings() {
    if let settingsController {
      settingsController.window?.makeKeyAndOrderFront(nil)
      return
    }
    guard let resources, let backend else { return }
    let router = BridgeRouter()
    backend.registerSettingsChannels(on: router)
    let controller = SettingsWindowController(resources: resources, router: router)
    settingsController = controller
    controller.showWindow(nil)
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if terminating { return .terminateNow }
    terminating = true
    Task { @MainActor in
      await backend?.processes.stopAll()
      await store?.flush()
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}
