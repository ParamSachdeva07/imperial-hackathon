/**
 * Nearest IconName for a caption / image prompt, used as the large-icon fallback when an image
 * fails or times out (spec §7.3). Pure.
 */
import type { IconName } from "@pointy/shared/overlay";

export const DEFAULT_ICON: IconName = "photo";

/** Keyword stems per icon. A word matches a keyword when it starts with it (so "emails" -> "email"). */
const KEYWORDS: Record<IconName, string[]> = {
  click: ["click", "tap", "press", "button", "cursor", "mouse", "select", "choose"],
  type: ["type", "typing", "keyboard", "write", "text", "enter", "word"],
  folder: ["folder", "directory", "album", "shelf", "shelves", "library", "archive", "storage", "building", "organis", "organiz"],
  file: ["file", "document", "paper", "page", "pdf", "form", "report"],
  photo: ["photo", "picture", "image", "camera", "gallery", "snapshot", "selfie", "portrait"],
  email: ["mail", "email", "letter", "envelope", "inbox", "message", "post"],
  attach: ["attach", "paperclip", "clip", "enclose"],
  send: ["send", "share", "forward", "deliver", "submit", "reply"],
  search: ["search", "find", "look", "magnif", "discover", "explore"],
  settings: ["setting", "settings", "gear", "option", "preference", "config", "adjust", "menu", "tool"],
  wifi: ["wifi", "wi-fi", "wireless", "network", "router", "signal", "connect", "broadband"],
  cloud: ["cloud", "internet", "online", "web", "server", "upload", "sync", "backup", "remote"],
  lock: ["lock", "password", "safe", "secure", "security", "private", "privacy", "protect", "key", "pin", "passcode"],
  warning: ["warning", "scam", "danger", "suspicious", "fraud", "phishing", "phish", "hook", "fake", "risk", "alert", "unsafe", "virus", "careful", "beware", "crumpled", "threat", "hack"],
  check: ["check", "tick", "correct", "done", "complete", "success", "approve", "confirm", "valid", "genuine", "tidy", "ok", "yes", "right", "good"],
  trash: ["trash", "bin", "delete", "remove", "discard", "rubbish", "recycle", "erase"],
  download: ["download", "save", "receive", "install", "get"],
  printer: ["print", "printer", "printout", "paperwork"],
  phone: ["phone", "call", "mobile", "smartphone", "telephone", "ring", "dial", "text message", "sms"],
  video: ["video", "film", "movie", "record", "stream", "clip", "watch", "tv", "television", "zoom", "facetime"],
  person: ["person", "people", "man", "woman", "user", "friend", "family", "grand", "child", "older", "elderly", "face", "smiling", "profile", "account", "someone"],
};

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
}

function matches(word: string, keyword: string): boolean {
  if (word === keyword) return true;
  // Prefix match for stems of 4+ letters ("emails", "photos", "passwords", "organised").
  return keyword.length >= 4 && word.startsWith(keyword);
}

/** Priority for ties: earlier = preferred. Specific/safety icons beat generic ones. */
const PRIORITY: IconName[] = [
  "warning",
  "lock",
  "email",
  "cloud",
  "photo",
  "wifi",
  "download",
  "trash",
  "printer",
  "video",
  "phone",
  "folder",
  "file",
  "attach",
  "send",
  "search",
  "settings",
  "type",
  "click",
  "check",
  "person",
];

export function nearestIcon(text: string): IconName {
  const words = tokenize(text);
  if (words.length === 0) return DEFAULT_ICON;
  let best: IconName = DEFAULT_ICON;
  let bestScore = 0;
  for (const icon of PRIORITY) {
    const keywords = KEYWORDS[icon];
    let score = 0;
    for (const w of words) {
      for (const k of keywords) {
        if (matches(w, k)) {
          score += 1;
          break;
        }
      }
    }
    if (score > bestScore) {
      best = icon;
      bestScore = score;
    }
  }
  return best;
}
