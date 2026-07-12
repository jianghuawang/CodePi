import AppKit

/// Native application menu mirroring the Electron template. Custom items emit
/// the same `menuAction` strings the renderer already understands; in-page
/// shortcuts (⌘K, ⌘Enter, Esc) stay in the renderer.
@MainActor
final class MenuActionRelay: NSObject {
  private let emit: (String) -> Void

  init(emit: @escaping (String) -> Void) {
    self.emit = emit
  }

  @objc func relay(_ sender: NSMenuItem) {
    guard let action = sender.representedObject as? String else { return }
    emit(action)
  }
}

@MainActor
enum MenuBuilder {
  static func build(relay: MenuActionRelay) -> NSMenu {
    let mainMenu = NSMenu()

    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About CodePi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(actionItem(title: "Settings…", action: "settings", key: ",", relay: relay))
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide CodePi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit CodePi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    mainMenu.addItem(submenu(appMenu, title: "CodePi"))

    let fileMenu = NSMenu(title: "File")
    fileMenu.addItem(actionItem(title: "New Thread", action: "new-thread", key: "n", relay: relay))
    let newProject = actionItem(title: "New Project…", action: "new-project", key: "N", relay: relay)
    newProject.keyEquivalentModifierMask = [.command, .shift]
    fileMenu.addItem(newProject)
    fileMenu.addItem(.separator())
    fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    mainMenu.addItem(submenu(fileMenu, title: "File"))

    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    mainMenu.addItem(submenu(editMenu, title: "Edit"))

    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    mainMenu.addItem(submenu(windowMenu, title: "Window"))
    NSApp.windowsMenu = windowMenu

    return mainMenu
  }

  private static func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.submenu = menu
    return item
  }

  private static func actionItem(title: String, action: String, key: String, relay: MenuActionRelay) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: #selector(MenuActionRelay.relay(_:)), keyEquivalent: key)
    item.target = relay
    item.representedObject = action
    return item
  }
}
