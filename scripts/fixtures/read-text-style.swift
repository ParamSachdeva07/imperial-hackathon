// Read-only test oracle: checks attributed content, not a toolbar's editable value.
import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
func rangeAttribute(_ element: AXUIElement, _ name: String, _ count: Int) -> CFTypeRef? {
    var range = CFRange(location: 0, length: count)
    guard let parameter = AXValueCreate(.cfRange, &range) else { return nil }
    var value: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(element, name as CFString, parameter, &value) == .success ? value : nil
}

guard CommandLine.arguments.count == 4 else { fatalError("Usage: read-text-style bundle-id window-title expected-text") }
let args = CommandLine.arguments
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == args[1] }) else {
    fatalError("Target application is not running")
}
let root = AXUIElementCreateApplication(app.processIdentifier)
let windows = (attribute(root, "AXWindows") as? [AXUIElement] ?? []).filter { string($0, "AXTitle") == args[2] }
guard windows.count == 1 else { fatalError("Expected one uniquely titled test window") }
var queue = windows
var visited = 0
var matches: [[String: Any]] = []
while !queue.isEmpty && visited < 2500 {
    let element = queue.removeFirst()
    visited += 1
    if let count = attribute(element, "AXNumberOfCharacters") as? Int, count > 0 && count <= 10000,
       let text = rangeAttribute(element, "AXStringForRange", count) as? String,
       text.trimmingCharacters(in: .whitespacesAndNewlines) == args[3] {
        var sizes = Set<Double>()
        var unknownFont = false
        if let styled = rangeAttribute(element, "AXAttributedStringForRange", count) as? NSAttributedString {
            styled.enumerateAttributes(in: NSRange(location: 0, length: styled.length)) { attrs, range, _ in
                let segment = (styled.string as NSString).substring(with: range)
                if segment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
                if let font = attrs[NSAttributedString.Key("AXFont")] as? [String: Any],
                   let size = font["AXFontSize"] as? NSNumber {
                    sizes.insert(size.doubleValue)
                } else { unknownFont = true }
            }
        } else { unknownFont = true }
        matches.append(["exactTextOnce": true, "fontSizes": sizes.sorted(), "unknownFont": unknownFont])
    }
    queue += attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
let result: [String: Any] = ["matches": matches, "complete": queue.isEmpty, "visited": visited]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
