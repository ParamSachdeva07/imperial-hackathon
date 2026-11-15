// pointy-ax: resident macOS Accessibility helper. JSON lines over stdio.
//
// Requests (one JSON object per line on stdin):
//   {"id":1,"cmd":"snapshot","maxElements":150,"excludePids":[123]}
//   {"id":2,"cmd":"resolve","ids":["ax-abc123"]}
//   {"id":3,"cmd":"trusted"}
//   {"id":4,"cmd":"active","on":true}   (default off: while off nothing is read or observed)
//   {"id":5,"cmd":"elementAt","x":640,"y":400,"excludePids":[123]}  -> {"ok":true,"element":{id,role,label,window,x,y,w,h}|null}
// Responses carry the same "id". Unsolicited events: {"event":"ready"|"changed", ...}.
// Secure text field values are never read. Coordinates are global points (top-left origin,
// same space as Electron DIP).
import Cocoa
import ApplicationServices

let useful: Set<String> = ["AXButton","AXLink","AXTextField","AXTextArea","AXMenuItem","AXMenuBarItem","AXTab","AXRadioButton","AXCheckBox","AXPopUpButton","AXComboBox","AXCell","AXRow","AXHeading","AXStaticText","AXImage","AXSlider","AXDisclosureTriangle","AXMenuButton","AXToolbar","AXSearchField"]
let skipDescend: Set<String> = ["AXScrollBar","AXMenu","AXSecureTextField"]
let textLike: Set<String> = ["AXStaticText","AXImage","AXCell","AXRow"]
let valueRoles: Set<String> = ["AXStaticText","AXHeading"]

let MAX_VISIT = 4000
let MAX_DEPTH = 14
let BUDGET: TimeInterval = 0.8

// ---- output ----
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  outLock.lock(); defer { outLock.unlock() }
  FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}

// ---- AX helpers ----
func attr(_ e: AXUIElement, _ k: String) -> AnyObject? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? (v as AnyObject?) : nil
}
func pointSize(_ p: AnyObject?, _ s: AnyObject?) -> CGRect? {
  guard let p = p, let s = s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}
func frame(_ e: AXUIElement) -> CGRect? { pointSize(attr(e, "AXPosition"), attr(e, "AXSize")) }
func nonEmpty(_ v: AnyObject?) -> String? { if let s = v as? String, !s.isEmpty { return s }; return nil }
func fnv(_ s: String) -> String {
  var h: UInt64 = 1469598103934665603
  for b in s.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
  return String(String(h, radix: 36).prefix(8))
}

func screenRects() -> [CGRect] {
  let H = NSScreen.screens.first?.frame.height ?? 0
  return NSScreen.screens.map { CGRect(x: $0.frame.minX, y: H - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
}

// ---- state ----
var curRefs: [String: AXUIElement] = [:]
var prevRefs: [String: AXUIElement] = [:]
var refsPid: pid_t = 0
var excluded: Set<pid_t> = [getpid()]
var lastTarget: pid_t? = nil
var manualSet: Set<pid_t> = []
/// Screen/AX data is only read while the assistant is open: snapshot/resolve are refused and no observer is
/// attached while inactive. The host turns this on with the "active" command.
var active = false

/// True when the element's window is minimised or its app is hidden: such frames are stale and not visible.
func isHiddenOrMinimized(_ e: AXUIElement) -> Bool {
  var pid: pid_t = 0
  if AXUIElementGetPid(e, &pid) == .success, let a = NSRunningApplication(processIdentifier: pid), a.isHidden { return true }
  if let w = attr(e, "AXWindow"), CFGetTypeID(w) == AXUIElementGetTypeID(),
     (attr(w as! AXUIElement, "AXMinimized") as? Bool) == true { return true }
  return false
}

let batchKeys = ["AXRole","AXSubrole","AXTitle","AXDescription","AXPlaceholderValue","AXHelp","AXPosition","AXSize","AXChildren"] as CFArray

// Private but long-stable API: the CGWindowID of an AX window element. Unlike the window's position in AXWindows
// (reordered on every focus change) it stays the same for the window's lifetime.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func windowKey(_ win: AXUIElement, fallbackIndex: Int) -> String {
  var wid: CGWindowID = 0
  if _AXUIElementGetWindow(win, &wid) == .success, wid != 0 { return "wid\(wid)" }
  return "win\(fallbackIndex)"
}

final class Walker {
  var pid: pid_t = 0
  var out: [[String: Any]] = []
  var refs: [String: AXUIElement] = [:]
  var idSeen: [String: Int] = [:]
  var visited = 0
  var truncated = false
  let maxEls: Int
  let deadline: Date
  let screens = screenRects()
  var focused: AXUIElement?
  init(maxEls: Int) { self.maxEls = maxEls; deadline = Date().addingTimeInterval(BUDGET) }

  func onScreen(_ r: CGRect) -> Bool { screens.contains { $0.intersects(r) } }

  func walk(_ e: AXUIElement, _ depth: Int, _ path: String, _ win: String, _ winKey: String, _ origin: CGPoint) {
    if out.count >= maxEls || visited >= MAX_VISIT || Date() > deadline { truncated = true; return }
    if depth > MAX_DEPTH { truncated = true; return }
    visited += 1
    var raw: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, batchKeys, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
          let vals = raw as? [AnyObject], vals.count == 9 else { return }
    func s(_ i: Int) -> String? { nonEmpty(vals[i]) }
    let role = s(0) ?? ""
    let subrole = s(1) ?? ""
    if skipDescend.contains(role) || subrole == "AXSecureTextField" { return }
    let f = pointSize(vals[6], vals[7])
    if useful.contains(role), let f = f, f.width > 2, f.height > 2, onScreen(f) {
      // label priority: title, description, placeholder, help. Values are only read for static text/headings.
      var label = s(2) ?? s(3) ?? s(4) ?? s(5) ?? ""
      if label.isEmpty && valueRoles.contains(role) { label = nonEmpty(attr(e, "AXValue")) ?? "" }
      if !(textLike.contains(role) && label.isEmpty) {
        // Coarse (64 pt) position relative to the window keeps repeated same-role/label rows apart without
        // depending on traversal order or child index; the counter below only breaks ties inside one cell.
        let bx = Int(((f.minX - origin.x) / 64).rounded(.down)), by = Int(((f.minY - origin.y) / 64).rounded(.down))
        let base = path + "|" + role + "|" + String(label.prefix(40)) + "|@\(bx),\(by)"
        let n = idSeen[base, default: 0]; idSeen[base] = n + 1
        // The window title is volatile (tab/page title, unread counts): ids key on the window index instead.
        let id = "ax-" + fnv("\(pid)|" + winKey + "|" + base + "#\(n)")
        refs[id] = e
        var item: [String: Any] = ["id": id, "role": String(role.dropFirst(2)), "label": String(label.prefix(80)), "window": win,
          "x": Int(f.minX.rounded()), "y": Int(f.minY.rounded()), "w": Int(f.width.rounded()), "h": Int(f.height.rounded())]
        if let fe = focused, CFEqual(fe, e) { item["focused"] = true }
        out.append(item)
      }
    }
    if let kids = vals[8] as? [AXUIElement] {
      for k in kids { walk(k, depth + 1, path + "/" + role, win, winKey, origin) }
    }
  }
}

func targetPid(_ excl: Set<pid_t>) -> pid_t? {
  if let f = NSWorkspace.shared.frontmostApplication, !excl.contains(f.processIdentifier) { return f.processIdentifier }
  if let l = lastTarget, !excl.contains(l), NSRunningApplication(processIdentifier: l) != nil { return l }
  return nil
}

func doSnapshot(_ req: [String: Any]) -> [String: Any] {
  let t0 = Date()
  let maxEls = max(1, min(4000, (req["maxElements"] as? Int) ?? 150))
  for p in (req["excludePids"] as? [Int]) ?? [] { excluded.insert(pid_t(p)) }
  guard let pid = targetPid(excluded) else { return ["ok": false, "error": "no_target"] }
  lastTarget = pid
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.25)
  if !manualSet.contains(pid) {
    manualSet.insert(pid)
    // Chromium/Electron only build their tree once asked; harmless for other apps.
    if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
      Thread.sleep(forTimeInterval: 0.15)
    }
  }
  let w = Walker(maxEls: maxEls)
  w.pid = pid
  if let fe = attr(app, "AXFocusedUIElement"), CFGetTypeID(fe) == AXUIElementGetTypeID() { w.focused = (fe as! AXUIElement) }
  var winTitle = ""
  let focusedWin = attr(app, "AXFocusedWindow") as! AXUIElement?
  if let mb = attr(app, "AXMenuBar"), CFGetTypeID(mb) == AXUIElementGetTypeID() { w.walk(mb as! AXUIElement, 0, "mb", "MenuBar", "MenuBar", .zero) }
  var wins = (attr(app, "AXWindows") as? [AXUIElement]) ?? []
  if let fw = focusedWin, let i = wins.firstIndex(where: { CFEqual($0, fw) }), i > 0 { wins.swapAt(0, i) } // focused window first
  for (i, win) in wins.enumerated() {
    if (attr(win, "AXMinimized") as? Bool) == true { continue } // minimised windows keep stale on-screen frames
    let t = nonEmpty(attr(win, "AXTitle")) ?? "window"
    if i == 0 { winTitle = t }
    w.walk(win, 0, "w", t, windowKey(win, fallbackIndex: i), frame(win)?.origin ?? .zero)
  }
  // Keep every ref the model may have been given for this app (ids are stable), not just two snapshots.
  var merged = (refsPid == pid) ? curRefs.merging(prevRefs) { a, _ in a } : [:]
  if merged.count > 8000 { merged = curRefs }
  prevRefs = merged; curRefs = w.refs; refsPid = pid
  let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
  return ["ok": true, "app": name, "pid": Int(pid), "window": winTitle, "elements": w.out, "truncated": w.truncated,
          "visited": w.visited, "ms": Int(Date().timeIntervalSince(t0) * 1000)]
}

/// The accessibility element under a global point (what a pointing finger / mouse is over), walked up to the nearest
/// useful ancestor. Ids use the snapshot scheme; when the element is in the cached refs the listed id is returned.
func doElementAt(_ req: [String: Any]) -> [String: Any] {
  let t0 = Date()
  for p in (req["excludePids"] as? [Int]) ?? [] { excluded.insert(pid_t(p)) }
  guard let x = (req["x"] as? NSNumber)?.floatValue, let y = (req["y"] as? NSNumber)?.floatValue else { return ["ok": false, "error": "bad_args"] }
  let sys = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(sys, 0.25)
  // Query the frontmost non-excluded app first: Pointy's own click-through overlays would otherwise win the
  // system-wide hit test. Fall back to the system-wide element when the app has nothing at the point.
  var hit: AXUIElement?
  var pid: pid_t = 0
  if let tp = targetPid(excluded) {
    let app = AXUIElementCreateApplication(tp)
    AXUIElementSetMessagingTimeout(app, 0.25)
    if !manualSet.contains(tp) {
      manualSet.insert(tp)
      if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success { Thread.sleep(forTimeInterval: 0.15) }
    }
    var h: AXUIElement?
    if AXUIElementCopyElementAtPosition(app, x, y, &h) == .success, let e = h { hit = e; pid = tp }
  }
  if hit == nil {
    var h: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, x, y, &h) == .success, let e = h else { return ["ok": true, "element": NSNull()] }
    guard AXUIElementGetPid(e, &pid) == .success, !excluded.contains(pid) else { return ["ok": true, "element": NSNull()] }
    hit = e
    if !manualSet.contains(pid) {
      manualSet.insert(pid)
      if AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        Thread.sleep(forTimeInterval: 0.15)
        var again: AXUIElement?
        if AXUIElementCopyElementAtPosition(sys, x, y, &again) == .success, let a = again { hit = a }
      }
    }
  }
  let cur = hit!
  AXUIElementSetMessagingTimeout(cur, 0.25)
  let screens = screenRects()
  func role(_ e: AXUIElement) -> String { nonEmpty(attr(e, "AXRole")) ?? "" }
  func labelOf(_ e: AXUIElement, _ r: String) -> String {
    var l = nonEmpty(attr(e, "AXTitle")) ?? nonEmpty(attr(e, "AXDescription")) ?? nonEmpty(attr(e, "AXPlaceholderValue")) ?? nonEmpty(attr(e, "AXHelp")) ?? ""
    if l.isEmpty && valueRoles.contains(r) { l = nonEmpty(attr(e, "AXValue")) ?? "" }
    return l
  }
  // Chain from the hit element up to the top (index 0 = hit).
  var chain: [AXUIElement] = [cur]
  while chain.count < 40, let p = attr(chain[chain.count - 1], "AXParent"), CFGetTypeID(p) == AXUIElementGetTypeID() { chain.append(p as! AXUIElement) }
  var pick = -1
  for (i, e) in chain.enumerated() {
    let r = role(e)
    if r == "AXWindow" || r == "AXApplication" { break }
    guard useful.contains(r), let f = frame(e), f.width > 2, f.height > 2, screens.contains(where: { $0.intersects(f) }) else { continue }
    if textLike.contains(r) && labelOf(e, r).isEmpty { continue }
    pick = i; break
  }
  guard pick >= 0 else { return ["ok": true, "element": NSNull()] }
  let el = chain[pick]
  if isHiddenOrMinimized(el) { return ["ok": true, "element": NSNull()] }
  let r = role(el), f = frame(el)!
  let label = labelOf(el, r)
  // Window / menu bar root of the chain.
  var rootIdx = -1
  for i in pick..<chain.count { let rr = role(chain[i]); if rr == "AXWindow" || rr == "AXMenuBar" { rootIdx = i; break } }
  var winTitle = "window", winKeyS = "win0", origin = CGPoint.zero, prefix = "w"
  if rootIdx >= 0 {
    let root = chain[rootIdx]
    if role(root) == "AXMenuBar" { winTitle = "MenuBar"; winKeyS = "MenuBar"; prefix = "mb" }
    else {
      winTitle = nonEmpty(attr(root, "AXTitle")) ?? "window"
      let wins = (attr(AXUIElementCreateApplication(pid), "AXWindows") as? [AXUIElement]) ?? []
      winKeyS = windowKey(root, fallbackIndex: wins.firstIndex(where: { CFEqual($0, root) }) ?? 0)
      origin = frame(root)?.origin ?? .zero
    }
  }
  // Same id as the walker: path = prefix + "/" + role of every ancestor from the root down to the parent.
  var id: String? = nil
  if let found = (curRefs.first { CFEqual($0.value, el) } ?? prevRefs.first { CFEqual($0.value, el) }) { id = found.key }
  if id == nil {
    var path = prefix
    if rootIdx >= 0 { for i in stride(from: rootIdx, to: pick, by: -1) { path += "/" + role(chain[i]) } }
    let bx = Int(((f.minX - origin.x) / 64).rounded(.down)), by = Int(((f.minY - origin.y) / 64).rounded(.down))
    id = "ax-" + fnv("\(pid)|" + winKeyS + "|" + path + "|" + r + "|" + String(label.prefix(40)) + "|@\(bx),\(by)#0")
  }
  // The id is about to be shown to the model: keep the ref so a later resolve (highlight / point_at) finds it even if the snapshot omitted it.
  if curRefs[id!] == nil && prevRefs[id!] == nil && prevRefs.count < 8000 { prevRefs[id!] = el }
  let item: [String: Any] = ["id": id!, "role": String(r.dropFirst(2)), "label": String(label.prefix(80)), "window": winTitle,
    "x": Int(f.minX.rounded()), "y": Int(f.minY.rounded()), "w": Int(f.width.rounded()), "h": Int(f.height.rounded())]
  return ["ok": true, "element": item, "app": NSRunningApplication(processIdentifier: pid)?.localizedName ?? "", "ms": Int(Date().timeIntervalSince(t0) * 1000)]
}

func doResolve(_ ids: [String]) -> [String: Any] {
  let screens = screenRects()
  var res: [String: Any] = [:]
  for id in ids {
    guard let e = curRefs[id] ?? prevRefs[id], let f = frame(e), f.width > 2, f.height > 2, screens.contains(where: { $0.intersects(f) }), !isHiddenOrMinimized(e) else {
      res[id] = NSNull(); continue
    }
    res[id] = ["x": Int(f.minX.rounded()), "y": Int(f.minY.rounded()), "w": Int(f.width.rounded()), "h": Int(f.height.rounded())]
  }
  return ["ok": true, "rects": res]
}

// ---- change observer ----
var observer: AXObserver?
var observedPid: pid_t = 0
var lastEmit = Date.distantPast
func notifyChanged(_ reason: String) {
  let now = Date()
  if reason != "app" && now.timeIntervalSince(lastEmit) < 0.1 { return }
  lastEmit = now
  emit(["event": "changed", "reason": reason])
}
let observerCallback: AXObserverCallback = { _, _, notif, _ in notifyChanged(notif as String) }

func detachObserver() {
  if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
  observer = nil; observedPid = 0
}

func attachObserver(_ pid: pid_t) {
  if !active { return }
  if pid == observedPid { return }
  if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
  observer = nil; observedPid = 0
  guard !excluded.contains(pid) else { return }
  var o: AXObserver?
  guard AXObserverCreate(pid, observerCallback, &o) == .success, let obs = o else { return }
  let app = AXUIElementCreateApplication(pid)
  for n in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXWindowMovedNotification,
            kAXWindowResizedNotification, kAXWindowCreatedNotification, kAXWindowMiniaturizedNotification,
            kAXWindowDeminiaturizedNotification, kAXTitleChangedNotification] {
    AXObserverAddNotification(obs, app, n as CFString, nil)
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
  observer = obs; observedPid = pid
}

// Window moved/resized only fire when registered on the window element itself.
func observeWindows(_ pid: pid_t) {
  guard let obs = observer, observedPid == pid else { return }
  let app = AXUIElementCreateApplication(pid)
  for w in (attr(app, "AXWindows") as? [AXUIElement]) ?? [] {
    for n in [kAXMovedNotification, kAXResizedNotification, kAXWindowMiniaturizedNotification] {
      AXObserverAddNotification(obs, w, n as CFString, nil) // already-registered errors are harmless
    }
  }
}

func handle(_ req: [String: Any]) {
  var resp: [String: Any]
  switch req["cmd"] as? String {
  case "trusted": resp = ["ok": true, "trusted": AXIsProcessTrusted()]
  case "active":
    active = (req["on"] as? Bool) == true
    if !active { detachObserver(); curRefs = [:]; prevRefs = [:]; refsPid = 0 }
    resp = ["ok": true, "active": active]
  case "snapshot":
    if !active { resp = ["ok": false, "error": "inactive"] }
    else if !AXIsProcessTrusted() { resp = ["ok": false, "error": "not_trusted"] }
    else {
      resp = doSnapshot(req)
      if let p = resp["pid"] as? Int { attachObserver(pid_t(p)); observeWindows(pid_t(p)) }
    }
  case "resolve":
    resp = !active ? ["ok": false, "error": "inactive"] : AXIsProcessTrusted() ? doResolve((req["ids"] as? [String]) ?? []) : ["ok": false, "error": "not_trusted"]
  case "elementAt":
    resp = !active ? ["ok": false, "error": "inactive"] : AXIsProcessTrusted() ? doElementAt(req) : ["ok": false, "error": "not_trusted"]
  default: resp = ["ok": false, "error": "unknown_cmd"]
  }
  if let id = req["id"] { resp["id"] = id }
  emit(resp)
}

// app switches
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
  if let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, !excluded.contains(a.processIdentifier) {
    lastTarget = a.processIdentifier
    if active {
      if AXIsProcessTrusted() { attachObserver(a.processIdentifier); observeWindows(a.processIdentifier) }
      notifyChanged("app")
    }
  }
}

// stdin reader
Thread.detachNewThread {
  while let line = readLine() {
    guard let d = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
    DispatchQueue.main.async { handle(obj) }
  }
  exit(0)
}

emit(["event": "ready", "trusted": AXIsProcessTrusted(), "pid": Int(getpid())])
setvbuf(stdout, nil, _IOLBF, 0)
RunLoop.main.run()
