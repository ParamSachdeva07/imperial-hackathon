import { IconName } from "@pointy/shared/overlay";
import { describe, expect, it } from "vitest";
import { nearestIcon } from "./iconMatch.js";

describe("nearestIcon", () => {
  const cases: Array<[string, string]> = [
    ["photo", "photo"],
    ["Pictures from the camera", "photo"],
    ["cloud", "cloud"],
    ["your files live on the internet", "cloud"],
    ["online storage", "cloud"],
    ["mail", "email"],
    ["a letter in an envelope", "email"],
    ["password", "lock"],
    ["keep it safe and secure", "lock"],
    ["scam", "warning"],
    ["danger ahead", "warning"],
    ["a suspicious message", "warning"],
    ["a crumpled envelope with a fishing hook coming out of it", "warning"],
    ["a neat envelope with a green tick seal, friendly and tidy", "check"],
    ["wifi router", "wifi"],
    ["delete it", "trash"],
    ["download the file", "download"],
    ["print it", "printer"],
    ["call your daughter", "phone"],
    ["a video call", "video"],
    ["a smiling older person", "person"],
  ];
  for (const [text, icon] of cases) {
    it(`"${text}" -> ${icon}`, () => expect(nearestIcon(text)).toBe(icon));
  }

  it("is case and punctuation insensitive and handles plurals", () => {
    expect(nearestIcon("PHOTOS!")).toBe("photo");
    expect(nearestIcon("Emails, mostly.")).toBe("email");
  });

  it("defaults to photo for empty or unknown text", () => {
    expect(nearestIcon("")).toBe("photo");
    expect(nearestIcon("   ")).toBe("photo");
    expect(nearestIcon("zzz qqq")).toBe("photo");
    expect(nearestIcon("123 !!!")).toBe("photo");
  });

  it("the stronger match wins", () => {
    expect(nearestIcon("a safe password for the cloud")).toBe("lock");
  });

  it("always returns a valid IconName", () => {
    for (const t of ["x", "the building of shelves", "hello world", "wi-fi password scam"]) {
      expect(IconName.options).toContain(nearestIcon(t));
    }
  });
});
