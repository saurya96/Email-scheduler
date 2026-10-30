import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

interface Sender {
  id: string;
  email: string;
}

interface EmailRecord {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  bodyHtml?: string | null;
  scheduledAt: string;
  sentAt?: string | null;
  status: "SCHEDULED" | "SENDING" | "SENT" | "FAILED";
  senderId: string;
  starred: boolean;
  error?: string | null;
  batchId?: string | null;
}

interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

interface AttachmentDraft {
  id: string;
  file: File;
  fingerprint: string;
  status: "ready" | "uploading" | "uploaded" | "failed";
}

interface ScheduleRequest {
  recipients: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  senderId: string;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
}

interface Account {
  user: User;
  slackConnected: boolean;
  slackChannel?: string | null;
  senders: Sender[];
  settings: {
    minDelayMs: number;
    maxEmailsPerHourPerSender: number;
    attachmentMaxFileSizeBytes?: number;
    attachmentMaxTotalSizeBytes?: number;
  };
}

type View = "scheduled" | "sent";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function postEmailForm<T>(
  form: FormData,
  idempotencyKey: string,
  onProgress: (progress: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/emails`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Idempotency-Key", idempotencyKey);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error while uploading attachments.")));
    xhr.addEventListener("load", () => {
      let data: { error?: string } & T;
      try {
        data = JSON.parse(xhr.responseText) as { error?: string } & T;
      } catch {
        reject(new Error(`Request failed (${xhr.status})`));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error ?? `Request failed (${xhr.status})`));
        return;
      }
      resolve(data);
    });
    xhr.send(form);
  });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function getInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function toLocalDateTimeInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<View>("scheduled");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [compose, setCompose] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<EmailRecord | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const data = await request<Account>("/api/me");
      setAccount(data);
    } catch (error) {
      if (error instanceof Error && !error.message.includes("401")) notify(error.message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const loadEmails = useCallback(async (currentView: View, search: string) => {
    if (!account) return;
    setLoadingEmails(true);
    try {
      const params = new URLSearchParams({ view: currentView, page: "1" });
      if (search.trim()) params.set("q", search.trim());
      const data = await request<{ emails: EmailRecord[]; hasMore: boolean }>(`/api/emails?${params}`);
      setEmails(data.emails);
      setPage(1);
      setHasMore(data.hasMore);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not load emails");
    } finally {
      setLoadingEmails(false);
    }
  }, [account, notify]);

  const loadMore = useCallback(async () => {
    if (!account || !hasMore || loadingMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ view, page: String(nextPage) });
      if (query.trim()) params.set("q", query.trim());
      const data = await request<{ emails: EmailRecord[]; hasMore: boolean }>(`/api/emails?${params}`);
      setEmails((current) => [...current, ...data.emails]);
      setPage(nextPage);
      setHasMore(data.hasMore);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not load more emails");
    } finally {
      setLoadingMore(false);
    }
  }, [account, hasMore, loadingMore, notify, page, query, view]);

  useEffect(() => {
    void loadAccount();
    if (new URLSearchParams(window.location.search).get("slack") === "connected") {
      notify("Slack is connected. Rate-limit alerts will be sent to your channel.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [loadAccount, notify]);

  useEffect(() => {
    void loadEmails(view, query);
  }, [view, query, loadEmails]);

  useEffect(() => {
    if (!account || compose || page > 1) return;
    const interval = window.setInterval(() => void loadEmails(view, query), 15000);
    return () => window.clearInterval(interval);
  }, [account, compose, loadEmails, page, query, view]);

  async function logout() {
    try {
      await request("/auth/logout", { method: "POST" });
      setAccount(null);
      setEmails([]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not log out");
    }
  }

  async function disconnectSlack() {
    try {
      await request("/auth/slack/disconnect", { method: "POST" });
      await loadAccount();
      notify("Slack disconnected");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not disconnect Slack");
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthSubmitting(true);
    try {
      await request(authMode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: authEmail,
          password: authPassword,
          ...(authMode === "register" ? { name: authName } : {})
        })
      });
      await loadAccount();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function toggleStar(email: EmailRecord) {
    const starred = !email.starred;
    try {
      await request<{ starred: boolean }>(`/api/emails/${encodeURIComponent(email.id)}/star`, {
        method: "POST",
        body: JSON.stringify({ starred })
      });
      setEmails((current) => current.map((item) => item.id === email.id ? { ...item, starred } : item));
      setSelectedEmail((current) => current?.id === email.id ? { ...current, starred } : current);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update star");
    }
  }

  if (loading) {
    return <main className="loading-screen"><span className="spinner" />Loading your workspace</main>;
  }

  if (!account) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Login</h1>
          <button className="google-button" onClick={() => { window.location.href = `${API_URL}/auth/google`; }}>
            <GoogleMark /> Login with Google
          </button>
          <div className="login-divider"><span>or sign up through email</span></div>
          <form className="login-form" onSubmit={(event) => void submitAuth(event)}>
            {authMode === "register" && <input value={authName} onChange={(event) => setAuthName(event.target.value)} type="text" placeholder="Full name" aria-label="Full name" autoComplete="name" minLength={1} maxLength={100} required />}
            <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} type="email" placeholder="Email ID" aria-label="Email ID" autoComplete="email" maxLength={254} required />
            <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} type="password" placeholder="Password" aria-label="Password" autoComplete={authMode === "login" ? "current-password" : "new-password"} minLength={authMode === "register" ? 10 : 1} maxLength={128} required />
            <button type="submit" disabled={authSubmitting}>{authSubmitting ? "Please wait…" : authMode === "login" ? "Login" : "Create account"}</button>
          </form>
          <button className="auth-mode-toggle" type="button" onClick={() => setAuthMode((mode) => mode === "login" ? "register" : "login")}>
            {authMode === "login" ? "Create an account" : "Already have an account? Login"}
          </button>
        </div>
        {toast && <Toast message={toast} />}
      </main>
    );
  }

  return (
    <div className={`app-shell${compose || selectedEmail ? " focused-view" : ""}`}>
      {!compose && !selectedEmail && <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-glyph">ONB</span>
        </a>
        <div className="profile-menu">
          {account.user.avatarUrl ? <img className="avatar" src={account.user.avatarUrl} alt="" /> : <div className="avatar avatar-fallback">{getInitials(account.user.name)}</div>}
          <div className="profile-text"><strong>{account.user.name}</strong><span>{account.user.email}</span></div>
          <button className="more-button" aria-label="Account options" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>⌄</button>
          {accountMenuOpen && <div className="account-popover">
            <button onClick={() => account.slackConnected ? void disconnectSlack() : window.location.assign(`${API_URL}/auth/slack`)}>{account.slackConnected ? `Disconnect Slack · ${account.slackChannel ?? "Connected"}` : "Connect Slack"}</button>
            <button onClick={() => window.open(`${API_URL}/admin/queues`, "_blank", "noopener,noreferrer")}>Queue monitor ↗</button>
          </div>}
        </div>
        <button className="compose-button" onClick={() => { setAccountMenuOpen(false); setCompose(true); }}>Compose</button>
        <div className="nav-label">CORE</div>
        <nav className="main-nav" aria-label="Email folders">
          <button className={view === "scheduled" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedEmail(null); setAccountMenuOpen(false); setView("scheduled"); }}>
            <span className="nav-icon">◷</span><span>Scheduled</span><span className="nav-count">{view === "scheduled" ? emails.length : ""}</span>
          </button>
          <button className={view === "sent" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedEmail(null); setAccountMenuOpen(false); setView("sent"); }}>
            <span className="nav-icon">↗</span><span>Sent</span><span className="nav-count">{view === "sent" ? emails.length : ""}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-logout" aria-label="Log out" title="Log out" onClick={() => void logout()}>
            <span className="sidebar-logout-icon" aria-hidden="true">↪</span><span>Log out</span>
          </button>
        </div>
      </aside>}

      <main className="main-area">
        {compose ? (
          <ComposePage
            account={account}
            onCancel={() => setCompose(false)}
            onScheduled={(count) => {
              setCompose(false);
              setView("scheduled");
              setQuery("");
              void loadEmails("scheduled", "");
              notify(`${count} email${count === 1 ? "" : "s"} queued for delivery`);
            }}
            onError={notify}
          />
        ) : selectedEmail ? (
          <EmailDetail
            email={selectedEmail}
            view={view}
            account={account}
            onBack={() => setSelectedEmail(null)}
            onToggleStar={() => void toggleStar(selectedEmail)}
            onError={notify}
            onCancelled={() => {
              setSelectedEmail(null);
              void loadEmails(view, query);
              notify("Scheduled email cancelled");
            }}
          />
        ) : (
          <>
            <header className="topbar">
              <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search emails" /></label>
              <div className="topbar-right">
                <button className="icon-button" aria-label="Refresh emails" onClick={() => void loadEmails(view, query)}>↻</button>
              </div>
            </header>
            <section className="mail-content">
              <div className="table-card">
                {loadingEmails && emails.length === 0 ? <div className="table-state"><span className="spinner" />Loading emails…</div> : emails.length === 0 ? (
                  <div className="empty-state"><div className="empty-art"><span>✉</span><i>✦</i></div><h2>{query ? "No matching emails" : view === "scheduled" ? "Your schedule is clear" : "No emails sent yet"}</h2><p>{query ? "Try a different search term." : view === "scheduled" ? "When you schedule your first email, it will show up here." : "Emails will appear here after they’ve been sent."}</p>{view === "scheduled" && !query && <button className="secondary-button" onClick={() => setCompose(true)}>Compose an email <span>→</span></button>}</div>
                ) : (
                  <div className="email-rows">
                    {emails.map((email) => <EmailRow key={email.id} email={email} view={view} onOpen={() => setSelectedEmail(email)} onToggleStar={() => void toggleStar(email)} />)}
                    {hasMore && <button className="load-more-button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? <><span className="button-spinner" /> Loading…</> : "Load more emails"}</button>}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
      {toast && <Toast message={toast} />}
    </div>
  );
}

function ComposePage({
  account,
  onCancel,
  onScheduled,
  onError
}: {
  account: Account;
  onCancel: () => void;
  onScheduled: (count: number) => void;
  onError: (message: string) => void;
}) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientsExpanded, setRecipientsExpanded] = useState(false);
  const [recipientInput, setRecipientInput] = useState("");
  const [recipientUploadCount, setRecipientUploadCount] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [startAt, setStartAt] = useState("");
  const [draftStartAt, setDraftStartAt] = useState(() => {
    const date = new Date(Date.now() + 5 * 60_000);
    date.setSeconds(0, 0);
    return toLocalDateTimeInput(date);
  });
  const [scheduled, setScheduled] = useState(false);
  const [selectedSenderId, setSelectedSenderId] = useState(account.senders[0]?.id ?? "");
  const [delaySeconds, setDelaySeconds] = useState(Math.max(2, Math.ceil(account.settings.minDelayMs / 1000)));
  const [hourlyLimit, setHourlyLimit] = useState(account.settings.maxEmailsPerHourPerSender);
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const allAttachmentsInput = useRef<HTMLInputElement>(null);
  const imagesInput = useRef<HTMLInputElement>(null);
  const documentsInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const bodyEditor = useRef<HTMLDivElement>(null);
  const maxAttachmentBytes = account.settings.attachmentMaxFileSizeBytes ?? 10 * 1024 * 1024;
  const maxAttachmentTotalBytes = account.settings.attachmentMaxTotalSizeBytes ?? 20 * 1024 * 1024;
  const allowedAttachmentExtensions = new Set([
    ".pdf", ".doc", ".docx", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".xls", ".xlsx", ".csv"
  ]);
  const addAttachments = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    const invalidFile = incoming.find((file) => !allowedAttachmentExtensions.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()));
    if (invalidFile) {
      onError(`${invalidFile.name} is not supported. Choose an image, PDF, Office document, TXT, or CSV file.`);
      return;
    }
    const oversizedFile = incoming.find((file) => file.size > maxAttachmentBytes);
    if (oversizedFile) {
      onError(`${oversizedFile.name} is larger than the ${formatFileSize(maxAttachmentBytes)} per-file limit.`);
      return;
    }
    if (incoming.some((file) => file.size === 0)) {
      onError("Empty attachments cannot be added.");
      return;
    }
    const knownFingerprints = new Set(attachments.map((item) => item.fingerprint));
    const additions: AttachmentDraft[] = [];
    for (const file of incoming) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const fingerprint = `${file.name.toLowerCase()}:${file.size}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (knownFingerprints.has(fingerprint)) continue;
      knownFingerprints.add(fingerprint);
      additions.push({ id: crypto.randomUUID(), file, fingerprint, status: "ready" });
    }
    if (!additions.length && incoming.length) {
      onError("Those files are already attached.");
      return;
    }
    if (attachments.length + additions.length > 5) {
      onError("You can attach up to 5 files.");
      return;
    }
    const totalSize = attachments.reduce((total, item) => total + item.file.size, 0)
      + additions.reduce((total, item) => total + item.file.size, 0);
    if (totalSize > maxAttachmentTotalBytes) {
      onError(`Attachments must total ${formatFileSize(maxAttachmentTotalBytes)} or less.`);
      return;
    }
    if (additions.length < incoming.length) onError("Duplicate files were skipped.");
    setAttachments((current) => [
      ...current,
      ...additions
    ]);
  }, [attachments, maxAttachmentBytes, maxAttachmentTotalBytes, onError]);
  const addAddresses = useCallback((text: string) => {
    const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    setRecipients((current) => Array.from(new Set([...current, ...matches.map((email) => email.toLowerCase())])));
    setRecipientInput("");
  }, []);

  async function uploadFile(file?: File) {
    if (!file) return;
    try {
      const text = await file.text();
      const detected = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((email) => email.toLowerCase())));
      if (!detected.length) {
        setRecipientUploadCount(0);
        onError("No email addresses were found in that file.");
        return;
      }
      setRecipientUploadCount(detected.length);
      addAddresses(text);
    } catch {
      onError("Could not read that file. Try a CSV or text file.");
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  function onRecipientKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === " ") {
      event.preventDefault();
      addAddresses(recipientInput);
    } else if (event.key === "Backspace" && !recipientInput && recipients.length) {
      setRecipients((current) => current.slice(0, -1));
    }
  }

  function applyFormatting(command: string, value?: string) {
    bodyEditor.current?.focus();
    document.execCommand(command, false, value);
    if (bodyEditor.current) {
      setBodyHtml(bodyEditor.current.innerHTML);
      setBody(bodyEditor.current.innerText.trim());
    }
  }

  function chooseQuickSchedule(hour: number, minute: number) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, minute, 0, 0);
    setDraftStartAt(toLocalDateTimeInput(tomorrow));
  }

  function finishSchedulePicker() {
    const selected = new Date(draftStartAt);
    if (!Number.isFinite(selected.getTime()) || selected.getTime() <= Date.now()) {
      onError("Choose a schedule time in the future.");
      return;
    }
    setStartAt(draftStartAt);
    setScheduled(true);
    setScheduleOpen(false);
  }

  function openSchedulePicker() {
    const selected = scheduled ? startAt : draftStartAt;
    setDraftStartAt(selected);
    setCalendarMonth(startOfMonth(new Date(selected)));
    setScheduleOpen((open) => !open);
  }

  function chooseCalendarDate(day: Date) {
    const selected = new Date(draftStartAt);
    selected.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    setDraftStartAt(toLocalDateTimeInput(selected));
  }

  function setScheduleTime(time: string) {
    const selected = new Date(draftStartAt);
    const [hour, minute] = time.split(":").map(Number);
    selected.setHours(hour ?? 0, minute ?? 0, 0, 0);
    setDraftStartAt(toLocalDateTimeInput(selected));
  }

  async function scheduleEmail() {
    addAddresses(recipientInput);
    const completeRecipients = Array.from(new Set([
      ...recipients,
      ...(recipientInput.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((email) => email.toLowerCase())
    ]));
    if (!completeRecipients.length) {
      onError("Add at least one recipient or upload a leads file.");
      return;
    }
    const editorText = bodyEditor.current?.innerText.trim() ?? body.trim();
    const editorHtml = bodyEditor.current?.innerHTML ?? bodyHtml;
    if (!subject.trim() || !editorText) {
      onError("Add a subject and message before scheduling.");
      return;
    }
    if (editorText.length > 20_000) {
      onError("Email message must be 20,000 characters or fewer.");
      return;
    }
    if (!selectedSenderId) {
      onError("No SMTP sender account is available.");
      return;
    }
    const requestedStart = scheduled ? new Date(startAt) : new Date(Date.now() + 2_000);
    setSending(true);
    setUploadProgress(attachments.length ? 0 : null);
    setAttachments((current) => current.map((item) => ({ ...item, status: "uploading" })));
    try {
      const metadata: ScheduleRequest = {
        recipients: completeRecipients,
        subject: subject.trim(),
        body: editorText,
        bodyHtml: editorHtml,
        senderId: selectedSenderId,
        startAt: requestedStart.toISOString(),
        delayMs: Math.max(delaySeconds * 1000, account.settings.minDelayMs),
        hourlyLimit: Math.min(hourlyLimit, account.settings.maxEmailsPerHourPerSender)
      };
      const form = new FormData();
      form.append("metadata", JSON.stringify(metadata));
      for (const { file } of attachments) form.append("attachments", file, file.name);
      const result = await postEmailForm<{ count: number }>(form, idempotencyKey, (progress) => {
        setUploadProgress(progress);
      });
      setAttachments((current) => current.map((item) => ({ ...item, status: "uploaded" })));
      onScheduled(result.count);
    } catch (error) {
      setAttachments((current) => current.map((item) => ({ ...item, status: "failed" })));
      onError(error instanceof Error ? error.message : "Could not schedule email");
    } finally {
      setSending(false);
      setUploadProgress(null);
    }
  }

  return (
    <section className="compose-page">
      <header className="compose-top">
        <h1 className="compose-page-title"><button className="back-button" onClick={onCancel} aria-label="Back to inbox">←</button>Compose New Email</h1>
        <div className="compose-actions">
          <button type="button" className="compose-icon-button attachment-trigger" aria-label="Add attachments" title="Add attachments" aria-expanded={attachmentMenuOpen} onClick={() => setAttachmentMenuOpen((open) => !open)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10.9 5.2-4.8 4.9a2 2 0 0 1-2.8-2.9l5.2-5.3a3 3 0 0 1 4.3 4.2l-5.5 5.6a4 4 0 0 1-5.7-5.7l4.6-4.7" /></svg>
            {attachments.length > 0 && <span>{attachments.length}</span>}
          </button>
          {attachmentMenuOpen && <div className="attachment-picker" role="menu" aria-label="Choose attachment source">
            <strong>Add attachments</strong>
            <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); allAttachmentsInput.current?.click(); }}>Upload from Computer</button>
            <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); imagesInput.current?.click(); }}>Browse Images</button>
            <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); documentsInput.current?.click(); }}>Browse Documents</button>
            <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); allAttachmentsInput.current?.click(); }}>Browse All Files</button>
          </div>}
          <input ref={allAttachmentsInput} className="hidden-input" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.csv,.xls,.xlsx" multiple onChange={(event) => {
            if (event.target.files) void addAttachments(event.target.files);
            event.target.value = "";
          }} />
          <input ref={imagesInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" multiple onChange={(event) => {
            if (event.target.files) void addAttachments(event.target.files);
            event.target.value = "";
          }} />
          <input ref={documentsInput} className="hidden-input" type="file" accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple onChange={(event) => {
            if (event.target.files) void addAttachments(event.target.files);
            event.target.value = "";
          }} />
          <button type="button" className="compose-icon-button" aria-label="Choose send time" aria-expanded={scheduleOpen} onClick={openSchedulePicker}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.2 1.4" /></svg></button>
          <button type="button" className="primary-button send-button" onClick={() => void scheduleEmail()} disabled={sending || !account.senders.length}>{sending ? <><span className="button-spinner" /> {uploadProgress !== null && uploadProgress < 100 ? `Uploading ${uploadProgress}%` : scheduled ? "Scheduling…" : "Sending…"}</> : scheduled ? "Send Later" : "Send"}</button>
          {scheduleOpen && <div className="schedule-popover">
            <header className="schedule-popover-heading">
              <div><strong>Schedule email</strong><small>Choose when your email should be sent</small></div>
              <button type="button" aria-label="Close schedule picker" onClick={() => setScheduleOpen(false)}>×</button>
            </header>
            <div className="schedule-calendar">
              <div className="calendar-month">
                <strong>{calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
                <span>
                  <button type="button" aria-label="Previous month" onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
                  <button type="button" aria-label="Next month" onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
                </span>
              </div>
              <div className="calendar-grid calendar-weekdays" aria-hidden="true">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="calendar-grid calendar-days" role="group" aria-label="Choose a date">
                {Array.from({ length: 42 }, (_, index) => {
                  const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - calendarMonth.getDay() + 1);
                  const selected = new Date(draftStartAt);
                  const isSelected = day.toDateString() === selected.toDateString();
                  const isCurrentMonth = day.getMonth() === calendarMonth.getMonth();
                  const isPast = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
                    < new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                  return <button type="button" key={day.toISOString()} className={`${isSelected ? "selected" : ""} ${!isCurrentMonth ? "outside-month" : ""}`} disabled={isPast} aria-pressed={isSelected} onClick={() => chooseCalendarDate(day)}>{day.getDate()}</button>;
                })}
              </div>
            </div>
            <label className="schedule-time-label">Send time
              <input type="time" value={new Date(draftStartAt).toTimeString().slice(0, 5)} onChange={(event) => setScheduleTime(event.target.value)} />
            </label>
            <div className="schedule-quick-options">
              {([[9, 0, "Tomorrow"], [10, 0, "10:00 AM"], [11, 0, "11:00 AM"], [15, 0, "3:00 PM"]] as const).map(([hour, minute, label]) => <button type="button" key={label} onClick={() => chooseQuickSchedule(hour, minute)}>{label}</button>)}
            </div>
            <div className="schedule-selection">{new Date(draftStartAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
            <div className="schedule-popover-actions">
              <button type="button" onClick={() => { setDraftStartAt(scheduled ? startAt : toLocalDateTimeInput(new Date(Date.now() + 5 * 60_000))); setScheduleOpen(false); }}>Cancel</button>
              <button type="button" onClick={finishSchedulePicker}>Done</button>
            </div>
          </div>}
        </div>
      </header>
      {scheduled && <div className="selected-schedule"><span>◷</span> Scheduled for {formatDate(new Date(startAt).toISOString())}<button type="button" onClick={() => setScheduled(false)}>Clear</button></div>}
      <form className="compose-card" onSubmit={(event) => { event.preventDefault(); void scheduleEmail(); }}>
        <div className="form-row from-row"><label htmlFor="sender-account">From</label><div className="sender-select"><select id="sender-account" value={selectedSenderId} onChange={(event) => setSelectedSenderId(event.target.value)} disabled={!account.senders.length} aria-label="From sender account">{account.senders.length ? account.senders.map((item) => <option value={item.id} key={item.id}>{item.email}</option>) : <option value="">No sender configured</option>}</select><span aria-hidden="true">⌄</span></div></div>
        <div className="form-row to-row"><label htmlFor="recipients">To</label><div className="recipient-entry" onClick={() => toInput.current?.focus()}>{(recipientsExpanded ? recipients : recipients.slice(0, 3)).map((email) => <span className="email-chip" key={email}>{email}<button type="button" aria-label={`Remove ${email}`} onClick={() => setRecipients((current) => current.filter((value) => value !== email))}>×</button></span>)}{recipients.length > 3 && <button type="button" className="recipient-overflow" aria-expanded={recipientsExpanded} onClick={() => setRecipientsExpanded((expanded) => !expanded)}>{recipientsExpanded ? "Show less" : `+${recipients.length - 3}`}</button>}<input id="recipients" ref={toInput} value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} onKeyDown={onRecipientKeyDown} onBlur={() => recipientInput && addAddresses(recipientInput)} placeholder={recipients.length ? "" : "recipient@example.com"} /><button type="button" className="upload-link" onClick={() => fileInput.current?.click()}><span>↑</span> Upload List</button><input ref={fileInput} className="hidden-input" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void uploadFile(event.target.files?.[0])} /></div></div>
        {recipientUploadCount !== null && <div className="recipient-upload-summary" aria-live="polite">{recipientUploadCount ? `${recipientUploadCount} email address${recipientUploadCount === 1 ? "" : "es"} detected in uploaded list` : "No email addresses detected"}</div>}
        <div className="form-row subject-row"><label htmlFor="subject">Subject</label><input id="subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" maxLength={998} /></div>
        <div className="schedule-options">
          <div className="field-control inline-control"><label htmlFor="delay">Delay between 2 emails</label><div className="number-input"><input id="delay" type="number" min={Math.ceil(account.settings.minDelayMs / 1000)} value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /></div></div>
          <div className="field-control inline-control"><label htmlFor="hourly-limit">Hourly Limit</label><div className="number-input"><input id="hourly-limit" type="number" min="1" max={account.settings.maxEmailsPerHourPerSender} value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /></div></div>
        </div>
        <div className="message-editor">
          <div ref={bodyEditor} className="message-editor-content" role="textbox" aria-label="Email body" aria-multiline="true" contentEditable suppressContentEditableWarning onInput={(event) => {
            setBody(event.currentTarget.innerText.trim());
            setBodyHtml(event.currentTarget.innerHTML);
          }} data-placeholder="Type Your Reply..." />
          <div className="editor-toolbar" role="toolbar" aria-label="Email formatting">
            {[
              { label: "Undo", command: "undo", text: "↶" },
              { label: "Redo", command: "redo", text: "↷" },
              { separator: true },
              { label: "Bold", command: "bold", text: "B", className: "format-bold" },
              { label: "Italic", command: "italic", text: "I", className: "format-italic" },
              { label: "Underline", command: "underline", text: "U", className: "format-underline" },
              { separator: true },
              { label: "Align left", command: "justifyLeft", text: "☰" },
              { label: "Align center", command: "justifyCenter", text: "≡" },
              { label: "Align right", command: "justifyRight", text: "☷" },
              { separator: true },
              { label: "Bulleted list", command: "insertUnorderedList", text: "•≡" },
              { label: "Numbered list", command: "insertOrderedList", text: "1≡" }
            ].map((tool, index) => "separator" in tool
              ? <span className="toolbar-separator" key={`separator-${index}`} />
              : <button type="button" key={tool.command} title={tool.label} aria-label={tool.label} className={tool.className} onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormatting(tool.command)}>{tool.text}</button>)}
          </div>
        </div>
        {sending && uploadProgress !== null && attachments.length > 0 && <div className="upload-progress" role="status" aria-live="polite"><div><span>Uploading attachments</span><strong>{uploadProgress}%</strong></div><progress value={uploadProgress} max="100" /></div>}
        {attachments.length > 0 && <div className="compose-attachments" aria-label="Attachments">{attachments.map(({ id, file, status }) => <AttachmentCard key={id} file={file} status={status} onPreview={() => setPreviewFile(file)} onRemove={() => setAttachments((current) => current.filter((item) => item.id !== id))} />)}</div>}
      </form>
      {previewFile && <AttachmentPreview file={previewFile} onClose={() => setPreviewFile(null)} />}
    </section>
  );
}

function AttachmentCard({ file, status, onPreview, onRemove }: { file: File; status: AttachmentDraft["status"]; onPreview: () => void; onRemove: () => void }) {
  const imageFile = file.type.startsWith("image/") || /\.(?:png|jpe?g)$/i.test(file.name);
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!imageFile) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, imageFile]);
  return (
    <article className="attachment-card">
      {imageFile && previewUrl
        ? <button className="attachment-preview-button" type="button" onClick={onPreview} aria-label={`Preview ${file.name}`}><img src={previewUrl} alt="" /></button>
        : <button className="attachment-preview-button" type="button" onClick={onPreview} aria-label={`Preview ${file.name}`}><span className={`attachment-file-icon file-${file.name.split(".").pop()?.toLowerCase() ?? "file"}`} aria-hidden="true">{file.name.split(".").pop()?.toUpperCase() ?? "FILE"}</span></button>}
      <div className="attachment-details"><strong title={file.name}>{file.name}</strong><span>{formatFileSize(file.size)} · {file.name.split(".").pop()?.toUpperCase()} file</span><small className={`attachment-status status-${status}`}>{status === "ready" ? "Ready" : status === "uploading" ? "Uploading…" : status === "uploaded" ? "Uploaded" : "Upload failed"}</small></div>
      <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove}>×</button>
    </article>
  );
}

function AttachmentPreview({ file, onClose }: { file: File; onClose: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const isImage = file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file.name);
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  return <div className="attachment-preview-overlay" role="presentation" onClick={onClose}>
    <section className="attachment-preview-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`} onClick={(event) => event.stopPropagation()}>
      <header><strong title={file.name}>{file.name}</strong><button type="button" aria-label="Close preview" onClick={onClose}>×</button></header>
      {url && (isImage ? <img src={url} alt={file.name} /> : isPdf ? <iframe title={`Preview ${file.name}`} src={url} /> : <div className="attachment-preview-unavailable">Preview is not available for this file type.</div>)}
      <a href={url} download={file.name}>Download file</a>
    </section>
  </div>;
}

function formatFileSize(size: number): string {
  return size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1_000))} KB`;
}

function EmailRow({ email, view, onOpen, onToggleStar }: { email: EmailRecord; view: View; onOpen: () => void; onToggleStar: () => void }) {
  const time = view === "sent" ? email.sentAt ?? email.scheduledAt : email.scheduledAt;
  const statusText = view === "scheduled"
    ? email.status === "SENDING" ? "Sending" : "Scheduled"
    : email.status === "FAILED" ? "Failed" : "Sent";
  return (
    <article className="email-row">
      <button className="email-open" onClick={onOpen}>
        <span className="email-recipient">To: {email.recipient}</span>
        <span className={`email-time ${view === "scheduled" ? "scheduled-time" : email.status === "FAILED" ? "failed-time" : "sent-time"}`}>
          {view === "scheduled" ? <><span>◷ {new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(time))}</span><small>{statusText}</small></> : statusText}
        </span>
        <span className="email-subject"><strong>{email.subject}</strong><span> - {email.body.replace(/\s+/g, " ").slice(0, 90)}{email.body.length > 90 ? "…" : ""}</span></span>
      </button>
      <button className="email-star" aria-label={email.starred ? "Remove star" : "Star email"} aria-pressed={email.starred} onClick={(event) => { event.stopPropagation(); onToggleStar(); }}>{email.starred ? "★" : "☆"}</button>
    </article>
  );
}

function EmailDetail({
  email,
  view,
  account,
  onBack,
  onToggleStar,
  onCancelled,
  onError
}: {
  email: EmailRecord;
  view: View;
  account: Account;
  onBack: () => void;
  onToggleStar: () => void;
  onCancelled: () => void;
  onError: (message: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const sentTime = email.sentAt ?? email.scheduledAt;
  useEffect(() => {
    setAttachments([]);
    if (!email.batchId) {
      setLoadingAttachments(false);
      return;
    }
    let active = true;
    setLoadingAttachments(true);
    void request<{ attachments: EmailAttachment[] }>(`/api/emails/${encodeURIComponent(email.id)}/attachments`)
      .then((data) => {
        if (active) setAttachments(data.attachments);
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Could not load attachments"))
      .finally(() => {
        if (active) setLoadingAttachments(false);
      });
    return () => { active = false; };
  }, [email.batchId, email.id, onError]);

  async function cancelScheduled() {
    setCancelling(true);
    try {
      await request(`/api/emails/${encodeURIComponent(email.id)}`, { method: "DELETE" });
      onCancelled();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not cancel scheduled email");
    } finally {
      setCancelling(false);
    }
  }
  return (
    <section className="detail-page">
      <header className="detail-header">
        <button className="detail-back" onClick={onBack} aria-label="Back to emails">←</button>
        <h1>{email.subject || "(no subject)"}</h1>
        <div className="detail-actions">
          <button aria-label={email.starred ? "Remove star" : "Add star"} aria-pressed={email.starred} onClick={onToggleStar}>{email.starred ? "★" : "☆"}</button>
          {email.status === "SCHEDULED" && <button className="cancel-email-button" onClick={() => void cancelScheduled()} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel email"}</button>}
          {account.user.avatarUrl ? <img className="avatar small" src={account.user.avatarUrl} alt="" /> : <span className="avatar avatar-fallback small">{getInitials(account.user.name)}</span>}
        </div>
      </header>
      <article className="detail-message">
        <div className="detail-sender">
          <span className="detail-sender-avatar" aria-hidden="true">{getInitials(account.user.name)}</span>
          <div className="detail-sender-info">
            <div className="detail-sender-identity"><strong>{account.user.name}</strong><span>&lt;{account.user.email}&gt;</span></div>
            <small>to {email.recipient}</small>
          </div>
          <time dateTime={view === "sent" ? sentTime : email.scheduledAt}>{formatDate(view === "sent" ? sentTime : email.scheduledAt)}</time>
        </div>
        {email.bodyHtml
          ? <div className="detail-body detail-rich-body" dangerouslySetInnerHTML={{ __html: email.bodyHtml }} />
          : <div className="detail-body">{email.body}</div>}
        {loadingAttachments && <div className="detail-attachments-loading">Loading attachments…</div>}
        {attachments.length > 0 && <div className="detail-attachments" aria-label="Attachments">
          {attachments.map((attachment) => {
            const attachmentUrl = `${API_URL}/api/emails/${encodeURIComponent(email.id)}/attachments/${encodeURIComponent(attachment.id)}`;
            const inlineUrl = `${attachmentUrl}?inline=1`;
            const imagePreview = /^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.contentType);
            const pdfPreview = attachment.contentType === "application/pdf";
            return <div className="detail-attachment" key={attachment.id}>
              {imagePreview ? <a href={inlineUrl} target="_blank" rel="noreferrer" aria-label={`Preview ${attachment.filename}`}><img src={inlineUrl} alt="" /></a> : <span className="attachment-file-icon" aria-hidden="true">{attachment.filename.split(".").pop()?.toUpperCase() ?? "FILE"}</span>}
              <span className="detail-attachment-info"><strong title={attachment.filename}>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small>
                <span className="detail-attachment-actions">{pdfPreview && <a href={inlineUrl} target="_blank" rel="noreferrer">Preview</a>}<a href={attachmentUrl} download={attachment.filename}>Download</a></span>
              </span>
            </div>;
          })}
        </div>}
      </article>
    </section>
  );
}

function Toast({ message }: { message: string }) {
  return <div className="toast"><span className="toast-check">✓</span>{message}<span className="toast-accent" /></div>;
}

function GoogleMark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.75 3.27-8.1Z" /><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.15v2.84A11 11 0 0 0 12 23Z" /><path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.12-1.44.34-2.11V7.05H2.15A11 11 0 0 0 1 12c0 1.78.43 3.46 1.15 4.95l3.69-2.84Z" /><path fill="#EA4335" d="M12 5.36c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.55 10.55 0 0 0 12 1a11 11 0 0 0-9.85 6.05l3.69 2.84C6.71 7.29 9.14 5.36 12 5.36Z" /></svg>;
}
