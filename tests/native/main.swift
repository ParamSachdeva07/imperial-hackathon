import AppKit
import ApplicationServices

func check(_ condition: Bool, _ message: String) {
  if !condition { fatalError(message) }
}
func contents(_ board: NSPasteboard) -> [[String: Data]] {
  (board.pasteboardItems ?? []).map { item in
    Dictionary(uniqueKeysWithValues: item.types.map { ($0.rawValue, item.data(forType: $0)!) })
  }
}
let board = NSPasteboard(name: NSPasteboard.Name("assistant-paste-test-" + UUID().uuidString))
defer { board.releaseGlobally() }
let first = NSPasteboardItem()
first.setString("Original text", forType: .string)
first.setString("<b>Original text</b>", forType: .html)
first.setData(Data([0, 1, 254, 255]), forType: NSPasteboard.PasteboardType("example.custom"))
let second = NSPasteboardItem()
second.setString("file:///tmp/example", forType: .fileURL)
board.writeObjects([first, second])
let original = contents(board)
let transaction = try ClipboardTransaction(text: "Hello café 😊", board: board)
check(board.string(forType: .string) == "Hello café 😊", "Literal Unicode clipboard")
check(transaction.owns(), "Clipboard ownership")
check(transaction.restore() == "restored", "Successful restoration")
check(contents(board) == original, "Every format and item must survive restoration")
check(transaction.restore() == "not_needed", "Restoration is idempotent")
let concurrent = try ClipboardTransaction(text: "temporary", board: board)
board.clearContents()
board.setString("New user clipboard", forType: .string)
check(!concurrent.owns(), "Detect newer clipboard")
check(concurrent.restore() == "preserved_newer_clipboard", "Do not overwrite concurrent copy")
check(board.string(forType: .string) == "New user clipboard", "New clipboard preserved")
board.clearContents()
do {
  let scoped = try ClipboardTransaction(text: "temporary", board: board)
  check(scoped.owns(), "Scoped ownership")
}
check((board.pasteboardItems ?? []).isEmpty, "Cleanup restores an empty clipboard")
check(
  unselectedTerminator("Hello😊", selection: CFRange(location: 0, length: 7)) == "",
  "UTF-16 full selection")
check(
  unselectedTerminator("Hello😊\n", selection: CFRange(location: 0, length: 7)) == "\n",
  "Unselectable paragraph terminator")
check(
  unselectedTerminator("Hello😊\n", selection: CFRange(location: 0, length: 2)) == nil,
  "Reject partial selection")
check(
  unselectedTerminator("Hello😊\n", selection: CFRange(location: 1, length: 7)) == nil,
  "Reject offset selection")
check(
  unselectedTerminator("\n\n", selection: CFRange(location: 0, length: 0)) == nil,
  "Never trim arbitrary newlines")
check(
  identifierAttribute("ax_identifier") == "AXIdentifier", "AX identifier preserves its namespace")
check(
  identifierAttribute("ax_dom_identifier") == "AXDOMIdentifier",
  "DOM identifier preserves its namespace")
check(identifierAttribute("unknown") == nil, "Unknown identifier cannot weaken identity checks")
check(matchesEditorRole("textfield", axRole: "AXComboBox", subrole: "AXSearchField"),
  "Search combo boxes match the bridge's observed textfield role")
check(matchesEditorRole("combobox", axRole: "AXComboBox", subrole: nil),
  "Ordinary combo boxes retain their role")
check(!matchesEditorRole("textfield", axRole: "AXComboBox", subrole: nil),
  "An unrelated combo box cannot replace the observed text field")
check(!matchesEditorRole("textfield", axRole: "AXButton", subrole: "AXSearchField"),
  "A search subrole does not make a non-editor writable")
check(!matchesEditorRole("textfield", axRole: "AXTextField", subrole: "AXSecureTextField"),
  "Secure subroles remain ineligible")
check(!matchesEditorRole("textfield", axRole: "AXSecureTextField", subrole: nil),
  "Secure roles remain ineligible")
check(matchesEditorRole("textfield", axRole: "AXTextArea", subrole: nil),
  "Multiline text areas preserve their existing bridge normalization")
print("PASS: native clipboard preservation, selection, identifiers and editor role normalization")
