import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
func windowNumber(_ element: AXUIElement, _ window: UnsafeMutablePointer<CGWindowID>) -> AXError

struct Bounds: Decodable { let x, y, width, height: Double }
struct Request: Decodable {
  let pid: Int32
  let windowId: UInt32
  let role: String
  let bounds: Bounds
  let nativeId: String?
  let nativeIdKind: String?
  let before: String
  let text: String
}
struct Failure: Error { let message: String }
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw Failure(message: message) }
}
func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  guard result == .success, let value else { throw Failure(message: "Cannot read " + name) }
  return value
}
func elementAttribute(_ element: AXUIElement, _ name: String) throws -> AXUIElement {
  let value = try attribute(element, name)
  try require(CFGetTypeID(value) == AXUIElementGetTypeID(), "Invalid element attribute")
  return unsafeBitCast(value, to: AXUIElement.self)
}
func rangeAttribute(_ element: AXUIElement) throws -> CFRange {
  let value = try attribute(element, kAXSelectedTextRangeAttribute)
  try require(CFGetTypeID(value) == AXValueGetTypeID(), "Selection is not readable")
  var range = CFRange()
  try require(
    AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range), "Invalid selection")
  return range
}
func textValue(_ element: AXUIElement) throws -> String {
  let count = try attribute(element, kAXNumberOfCharactersAttribute) as? NSNumber
  guard let count else { throw Failure(message: "Editor does not expose its text length") }
  try require(
    count.intValue >= 0 && count.intValue <= 131072, "Editor text exceeds the paste limit")
  var range = CFRange(location: 0, length: count.intValue)
  guard let parameter = AXValueCreate(.cfRange, &range) else {
    throw Failure(message: "Cannot construct text range")
  }
  var value: CFTypeRef?
  let result = AXUIElementCopyParameterizedAttributeValue(
    element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &value)
  guard result == .success, let text = value as? String else {
    throw Failure(message: "Editor does not expose complete range text")
  }
  let after = try attribute(element, kAXNumberOfCharactersAttribute) as? NSNumber
  try require(after == count && text.utf16.count == count.intValue, "Editor changed while reading")
  return text
}
func assertFocus(_ element: AXUIElement, app: AXUIElement, request: Request) throws {
  try require(
    NSWorkspace.shared.frontmostApplication?.processIdentifier == request.pid,
    "Target application lost focus")
  let focused = try elementAttribute(app, kAXFocusedUIElementAttribute)
  try require(CFEqual(focused, element), "Target editor lost focus")
  let window = try elementAttribute(element, kAXWindowAttribute)
  var id: CGWindowID = 0
  try require(
    windowNumber(window, &id) == .success && id == request.windowId, "Target window changed")
}
func matchesEditorRole(_ observed: String, axRole: String?, subrole: String?) -> Bool {
  guard axRole != kAXSecureTextFieldSubrole, subrole != kAXSecureTextFieldSubrole else { return false }
  // agent-desktop normalizes the search subrole to textfield, including editable
  // combo boxes. Keep the same semantics across the observation/native boundary.
  switch observed {
  case "textfield":
    return ["AXTextField", "AXTextArea", "AXSearchField"].contains(axRole ?? "")
      || (axRole == "AXComboBox" && subrole == "AXSearchField")
  case "textarea": return axRole == "AXTextArea"
  case "combobox": return axRole == "AXComboBox" && subrole != "AXSearchField"
  default: return false
  }
}
func assertIdentity(_ element: AXUIElement, request: Request) throws {
  let role = try attribute(element, kAXRoleAttribute) as? String
  let subrole = try? attribute(element, kAXSubroleAttribute) as? String
  try require(
    matchesEditorRole(request.role, axRole: role, subrole: subrole),
    "Focused target is not the observed text editor")
  if let nativeId = request.nativeId, !nativeId.isEmpty {
    guard let name = identifierAttribute(request.nativeIdKind) else {
      throw Failure(message: "Unsupported editor identifier kind")
    }
    try require(
      (try attribute(element, name) as? String) == nativeId,
      "Editor identity changed")
  }
  let position = try attribute(element, kAXPositionAttribute)
  let size = try attribute(element, kAXSizeAttribute)
  try require(
    CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID(),
    "Editor bounds unavailable")
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  try require(
    AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point)
      && AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
    "Invalid editor bounds")
  let pairs = [
    (point.x, request.bounds.x), (point.y, request.bounds.y),
    (dimensions.width, request.bounds.width), (dimensions.height, request.bounds.height),
  ]
  try require(
    pairs.allSatisfy { abs($0.0 - $0.1) < 1 },
    "Editor moved since observation; refresh before pasting")
}
func identifierAttribute(_ kind: String?) -> String? {
  switch kind {
  case nil, "ax_identifier": return kAXIdentifierAttribute
  case "ax_dom_identifier": return "AXDOMIdentifier"
  default: return nil
  }
}

final class ClipboardTransaction {
  private let board: NSPasteboard
  private var saved: [NSPasteboardItem] = []
  private var ownership: Int?
  init(text: String, board: NSPasteboard = .general) throws {
    self.board = board
    let version = board.changeCount
    var bytes = 0
    for item in board.pasteboardItems ?? [] {
      let copy = NSPasteboardItem()
      for type in item.types {
        guard let data = item.data(forType: type) else {
          throw Failure(message: "Cannot preserve every clipboard format")
        }
        bytes += data.count
        try require(bytes <= 32 * 1024 * 1024, "Clipboard too large to preserve")
        try require(copy.setData(data, forType: type), "Cannot preserve clipboard data")
      }
      saved.append(copy)
    }
    try require(board.changeCount == version, "Clipboard changed during capture")
    ownership = board.clearContents()
    if !board.setString(text, forType: .string) {
      _ = restore()
      throw Failure(message: "Cannot prepare paste clipboard")
    }
    try require(owns(), "Clipboard changed while preparing paste")
  }
  func owns() -> Bool { ownership == board.changeCount }
  func restore() -> String {
    guard let version = ownership else { return "not_needed" }
    ownership = nil
    guard board.changeCount == version else { return "preserved_newer_clipboard" }
    let cleared = board.clearContents()
    guard board.changeCount == cleared else { return "preserved_newer_clipboard" }
    if !saved.isEmpty && !board.writeObjects(saved) { return "restore_failed" }
    return "restored"
  }
  deinit { _ = restore() }
}

func key(_ code: CGKeyCode, pid: Int32) throws {
  guard let source = CGEventSource(stateID: .privateState),
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  else {
    throw Failure(message: "Cannot construct paste key events")
  }
  down.flags = .maskCommand
  up.flags = .maskCommand
  down.postToPid(pid)
  up.postToPid(pid)
}
func waitFor(_ predicate: () throws -> Bool) throws {
  let deadline = Date().addingTimeInterval(2)
  repeat {
    if try predicate() { return }
    Thread.sleep(forTimeInterval: 0.025)
  } while Date() < deadline
  throw Failure(message: "Requested editor state could not be verified; input was not repeated")
}
func unselectedTerminator(_ text: String, selection: CFRange) -> String? {
  guard selection.location == 0, selection.length >= 0 else { return nil }
  if selection.length == text.utf16.count { return "" }
  if selection.length == text.utf16.count - 1 && text.hasSuffix("\n") { return "\n" }
  return nil
}
func emit(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}

#if !PASTE_TESTS
  @main
  struct PasteMain {
    static func main() {
      let lockPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(
        "desktop-assistant-paste.lock")
      let lock = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
      guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
        emit([
          "ok": false,
          "error": [
            "code": "PASTE_BUSY", "message": "Another paste transaction is running",
            "disposition": ["delivery": "not_delivered", "retry": "inspect"],
          ],
        ])
        exit(1)
      }
      var pasteAttempted = false
      var clipboard: ClipboardTransaction?
      do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        try require(input.count <= 1024 * 1024, "Paste request too large")
        let request = try JSONDecoder().decode(Request.self, from: input)
        try require(
          request.text.utf8.count <= 131072 && !request.text.contains("\0"),
          "Unsupported paste text")
        let app = AXUIElementCreateApplication(request.pid)
        AXUIElementSetMessagingTimeout(app, 1)
        let editor = try elementAttribute(app, kAXFocusedUIElementAttribute)
        AXUIElementSetMessagingTimeout(editor, 1)
        try assertFocus(editor, app: app, request: request)
        try assertIdentity(editor, request: request)
        let before = try textValue(editor)
        try require(
          before == request.before,
          "Text changed since observation; stopped before replacing a user edit")
        if before == request.text {
          emit([
            "ok": true,
            "data": [
              "verification": "already_satisfied", "delivery": "not_delivered",
              "observedValue": before, "clipboard": "not_needed",
            ],
          ])
        } else {
          try assertFocus(editor, app: app, request: request)
          try key(0, pid: request.pid)
          var suffix: String?
          try waitFor {
            try assertFocus(editor, app: app, request: request)
            let selected = try rangeAttribute(editor)
            suffix = unselectedTerminator(before, selection: selected)
            return suffix != nil
          }
          let expected = request.text + (suffix ?? "")
          if before == expected {
            emit([
              "ok": true,
              "data": [
                "verification": "already_satisfied", "delivery": "not_delivered",
                "expectedValue": expected, "observedValue": before, "clipboard": "not_needed",
              ],
            ])
            exit(0)
          }
          clipboard = try ClipboardTransaction(text: request.text)
          try assertFocus(editor, app: app, request: request)
          try require(try textValue(editor) == before, "Text changed before paste")
          let selected = try rangeAttribute(editor)
          try require(
            unselectedTerminator(before, selection: selected) == suffix,
            "Editor selection changed before paste")
          try require(clipboard?.owns() == true, "Clipboard changed before paste")
          pasteAttempted = true
          try key(9, pid: request.pid)
          var after = before
          try waitFor {
            try assertFocus(editor, app: app, request: request)
            after = try textValue(editor)
            return after == expected
          }
          let restored = clipboard?.restore() ?? "not_needed"
          emit([
            "ok": true,
            "data": [
              "verification": "verified", "delivery": "delivered_verified",
              "expectedValue": expected, "observedValue": after, "clipboard": restored,
            ],
          ])
        }
      } catch {
        let restored = clipboard?.restore() ?? "not_needed"
        let message = (error as? Failure)?.message ?? "Invalid focus-and-paste request"
        emit([
          "ok": false,
          "error": [
            "code": pasteAttempted ? "UNVERIFIED_ACTION" : "PASTE_PRECONDITION", "message": message,
            "disposition": [
              "delivery": pasteAttempted ? "uncertain" : "not_delivered", "retry": "inspect",
            ],
            "details": [
              "pasteAttempted": pasteAttempted, "replayed": false, "clipboard": restored,
            ],
          ],
        ])
      }
    }
  }
#endif
