/**
 * Fixture app (spec §6): a fake mail + files window with stable element ids, used as the test
 * surface before real accessibility data exists. Every element with `data-element-id` is reported
 * to main (viewport-relative DIP) on layout, resize, scroll and DOM changes.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./fixture.css";

const EMAILS = [
  { id: "fixture.email.1", from: "Sarah (daughter)", subject: "Photos from Sunday", time: "10:42" },
  { id: "fixture.email.2", from: "Bank Security Team", subject: "URGENT: verify your account now", time: "09:15" },
  { id: "fixture.email.3", from: "Dr Patel's surgery", subject: "Appointment reminder", time: "Yesterday" },
  { id: "fixture.email.4", from: "Garden Club", subject: "Spring meeting", time: "Mon" },
];

const FILES = [
  "Birthday 2025.jpg",
  "Grandchildren.jpg",
  "Recipe - apple pie.pdf",
  "Insurance letter.pdf",
  "Holiday in Cornwall.jpg",
  "Christmas card list.docx",
  "Garden plan.png",
  "Pension statement.pdf",
  "Church newsletter.pdf",
  "Family tree.docx",
];

function reportBounds(): void {
  const els = document.querySelectorAll<HTMLElement>("[data-element-id]");
  const elements: { id: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    // Clip to the nearest scroll container and the viewport; skip elements scrolled out of view.
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    const clip = el.closest<HTMLElement>("[data-scroll]")?.getBoundingClientRect();
    if (clip) {
      left = Math.max(left, clip.left);
      top = Math.max(top, clip.top);
      right = Math.min(right, clip.right);
      bottom = Math.min(bottom, clip.bottom);
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    if (right - left < 4 || bottom - top < 4) continue;
    elements.push({ id: el.dataset.elementId!, rect: { x: left, y: top, width: right - left, height: bottom - top } });
  }
  window.pointyFixture?.reportBounds({ elements });
}

function scheduleReport(): void {
  requestAnimationFrame(reportBounds);
}

function App() {
  const [dark, setDark] = useState(false);
  const [composing, setComposing] = useState(true);
  const [selected, setSelected] = useState(EMAILS[1]!.id);

  useEffect(() => {
    scheduleReport();
    const ro = new ResizeObserver(scheduleReport);
    ro.observe(document.body);
    const mo = new MutationObserver(scheduleReport);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener("resize", scheduleReport);
    document.addEventListener("scroll", scheduleReport, true);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", scheduleReport);
      document.removeEventListener("scroll", scheduleReport, true);
    };
  }, []);

  const email = EMAILS.find((e) => e.id === selected)!;

  return (
    <div className={dark ? "app dark" : "app"}>
      <header className="toolbar" data-element-id="fixture.toolbar">
        <button data-element-id="fixture.newEmail" onClick={() => setComposing(true)}>✉︎ New email</button>
        <button data-element-id="fixture.reply">↩︎ Reply</button>
        <button data-element-id="fixture.delete" className="danger">🗑 Delete</button>
        <button data-element-id="fixture.attach">📎 Attach</button>
        <button data-element-id="fixture.sendButton" className="primary">➤ Send</button>
        <span className="spacer" />
        <input data-element-id="fixture.search" placeholder="Search mail" />
        <button data-element-id="fixture.themeToggle" onClick={() => setDark((d) => !d)}>{dark ? "☀︎ Light" : "☾ Dark"}</button>
      </header>
      <div className="body">
        <nav className="sidebar">
          <div data-element-id="fixture.folder.inbox" className="folder active">Inbox</div>
          <div data-element-id="fixture.folder.sent" className="folder">Sent</div>
          <div data-element-id="fixture.folder.photos" className="folder">Photos</div>
          <div data-element-id="fixture.folder.documents" className="folder">Documents</div>
          <div data-element-id="fixture.folder.trash" className="folder">Trash</div>
        </nav>
        <section className="list" data-scroll>
          {EMAILS.map((e) => (
            <div key={e.id} data-element-id={e.id} className={e.id === selected ? "row selected" : "row"} onClick={() => setSelected(e.id)}>
              <strong>{e.from}</strong>
              <span>{e.subject}</span>
              <time>{e.time}</time>
            </div>
          ))}
        </section>
        <section className="reader" data-scroll>
          <h1 data-element-id="fixture.emailSubject">{email.subject}</h1>
          <p data-element-id="fixture.emailSender" className="sender">From: {email.from}</p>
          <p data-element-id="fixture.emailBody">
            Dear customer, we noticed unusual activity on your account. Please confirm your details within 24 hours
            or your account will be closed.
          </p>
          <p>
            <a data-element-id="fixture.emailLink" href="#" onClick={(e) => e.preventDefault()}>
              http://secure-bank-login.example-verify.com/confirm
            </a>
          </p>
          {composing && (
            <div className="compose" data-element-id="fixture.compose">
              <label>
                To <input data-element-id="fixture.to" placeholder="Who is it for?" />
              </label>
              <label>
                Subject <input data-element-id="fixture.subject" placeholder="What is it about?" />
              </label>
              <textarea data-element-id="fixture.message" placeholder="Write your message" />
              <div className="compose-actions">
                <button data-element-id="fixture.composeAttach">📎 Attach photo</button>
                <button data-element-id="fixture.send" className="primary">➤ Send</button>
              </div>
            </div>
          )}
        </section>
        <aside className="files" data-scroll data-element-id="fixture.fileList">
          <h2>My files</h2>
          {FILES.map((f, i) => (
            <div key={f} data-element-id={`fixture.file.${i + 1}`} className="file">
              {f.endsWith(".jpg") || f.endsWith(".png") ? "🖼" : "📄"} {f}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
