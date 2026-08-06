import { useEffect, useState } from "react";

import type {
  AppFolderSummary,
  AuthStatus,
  MonthReadResult,
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";

async function sendRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  const response = (await browser.runtime.sendMessage(
    request,
  )) as RuntimeResponse;

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response;
}

async function sendAuthRequest(request: RuntimeRequest): Promise<AuthStatus> {
  const response = await sendRequest(request);

  if (!response.ok || response.type !== "auth/status") {
    throw new Error("OneDrop received an unexpected authentication response.");
  }

  return response.status;
}

export function App() {
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);
  const [appFolder, setAppFolder] = useState<AppFolderSummary>();
  const [monthResult, setMonthResult] = useState<MonthReadResult>();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void sendAuthRequest({ type: "auth/status" })
      .then(setStatus)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Unable to read status",
        );
      });
  }, []);

  async function run(request: RuntimeRequest) {
    setIsWorking(true);
    setError(undefined);

    try {
      setStatus(await sendAuthRequest(request));
      setAppFolder(undefined);
      setMonthResult(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function readCurrentMonth() {
    setIsWorking(true);
    setError(undefined);

    try {
      const response = await sendRequest({
        type: "messages/read-current-month",
      });

      if (!response.ok || response.type !== "messages/month") {
        throw new Error(
          "OneDrop received an unexpected monthly sync response.",
        );
      }

      setMonthResult(response.result);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Monthly message read failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function verifyOneDrive() {
    setIsWorking(true);
    setError(undefined);

    try {
      const response = await sendRequest({
        type: "onedrive/verify-app-folder",
      });

      if (!response.ok || response.type !== "onedrive/app-folder") {
        throw new Error("OneDrop received an unexpected OneDrive response.");
      }

      setAppFolder(response.appFolder);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "OneDrive check failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function sendText() {
    if (!draft.trim()) return;

    setIsWorking(true);
    setError(undefined);

    try {
      const response = await sendRequest({
        type: "messages/send-text",
        text: draft,
      });

      if (!response.ok || response.type !== "messages/month") {
        throw new Error("OneDrop received an unexpected send response.");
      }

      setMonthResult(response.result);
      setDraft("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Text message send failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  return (
    <main className="shell">
      <header className="header">
        <div className="brand-mark" aria-hidden="true" />
        <div>
          <h1>OneDrop</h1>
          <p>Microsoft identity compatibility check</p>
        </div>
      </header>

      {!status ? (
        <section className="card" aria-live="polite">
          <span className="eyebrow">Loading</span>
          <h2>Reading extension status…</h2>
        </section>
      ) : null}

      {status?.state === "unconfigured" ? (
        <section className="card" aria-labelledby="configuration-title">
          <span className="eyebrow">Configuration required</span>
          <h2 id="configuration-title">Register the development extension</h2>
          <p>
            Create a Microsoft Entra app registration, add the redirect URI
            below, and place its Application (client) ID in{" "}
            <code>.env.local</code>.
          </p>
          <RedirectUri value={status.redirectUri} />
        </section>
      ) : null}

      {status?.state === "signed-out" ? (
        <section className="card" aria-labelledby="sign-in-title">
          <span className="eyebrow">Ready to verify</span>
          <h2 id="sign-in-title">Connect your Microsoft account</h2>
          <p>
            This test requests access only to OneDrop&apos;s dedicated OneDrive
            App Folder. No files or messages will be created yet.
          </p>
          <button
            className="primary-button"
            disabled={isWorking}
            onClick={() => void run({ type: "auth/sign-in" })}
            type="button"
          >
            {isWorking ? "Opening Microsoft…" : "Sign in with Microsoft"}
          </button>
          <RedirectUri value={status.redirectUri} />
        </section>
      ) : null}

      {status?.state === "signed-in" ? (
        <section className="card success" aria-labelledby="signed-in-title">
          <span className="eyebrow">Compatibility check passed</span>
          <h2 id="signed-in-title">
            {status.account.displayName ?? "Microsoft account connected"}
          </h2>
          {status.account.username ? <p>{status.account.username}</p> : null}
          <p className="detail">
            Access token expires at{" "}
            {new Date(status.expiresAt).toLocaleString()}. This validation build
            keeps the token only for the current Edge session.
          </p>
          {!appFolder ? (
            <div className="verification-step">
              <strong>Next: verify OneDrive storage</strong>
              <p>
                This user-triggered check calls Microsoft Graph. On first use,
                OneDrive may create the dedicated Apps/OneDrop Development
                folder.
              </p>
              <button
                className="primary-button"
                disabled={isWorking}
                onClick={() => void verifyOneDrive()}
                type="button"
              >
                {isWorking
                  ? "Checking OneDrive…"
                  : "Verify OneDrive App Folder"}
              </button>
            </div>
          ) : (
            <>
              <div className="folder-result" aria-live="polite">
                <strong>OneDrive App Folder verified</strong>
                <span>{appFolder.name}</span>
                <code>{appFolder.id}</code>
                {appFolder.webUrl ? (
                  <a href={appFolder.webUrl} rel="noreferrer" target="_blank">
                    Open folder in OneDrive
                  </a>
                ) : null}
              </div>
              <div className="verification-step">
                <strong>Read current month</strong>
                <p>
                  Read and validate the current UTC month document without
                  creating or changing OneDrive content.
                </p>
                <button
                  className="primary-button"
                  disabled={isWorking}
                  onClick={() => void readCurrentMonth()}
                  type="button"
                >
                  {isWorking ? "Reading messages…" : "Read monthly messages"}
                </button>
              </div>
              {monthResult ? <MonthResult result={monthResult} /> : null}
              <div className="composer">
                <label htmlFor="message-text">Text message</label>
                <textarea
                  id="message-text"
                  maxLength={20_000}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a message to your other devices…"
                  rows={4}
                  value={draft}
                />
                <div className="composer-footer">
                  <span>{draft.length.toLocaleString()} / 20,000</span>
                  <button
                    className="primary-button"
                    disabled={isWorking || !draft.trim()}
                    onClick={() => void sendText()}
                    type="button"
                  >
                    {isWorking ? "Sending…" : "Send text"}
                  </button>
                </div>
              </div>
            </>
          )}
          <button
            className="secondary-button"
            disabled={isWorking}
            onClick={() => void run({ type: "auth/sign-out" })}
            type="button"
          >
            Sign out locally
          </button>
        </section>
      ) : null}

      {error ? (
        <div className="error" role="alert">
          <strong>Operation failed</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </main>
  );
}

function MonthResult({ result }: { result: MonthReadResult }) {
  return (
    <div className="month-result" aria-live="polite">
      <strong>{result.month} synchronization result</strong>
      {result.state === "missing" ? (
        <span>
          No monthly document exists yet. This is a valid empty state.
        </span>
      ) : (
        <>
          <span>
            {result.messages.length} messages passed schema validation.
          </span>
          <code>ETag: {result.eTag}</code>
          {result.messages.length > 0 ? (
            <ol className="message-list">
              {result.messages.map((message) => (
                <li key={message.id}>
                  {message.type === "text" ? (
                    <p>{message.text}</p>
                  ) : (
                    <p>File: {message.attachment.name}</p>
                  )}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}
    </div>
  );
}

function RedirectUri({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="redirect">
      <span>Redirect URI</span>
      <code>{value}</code>
      <button onClick={() => void copy()} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
