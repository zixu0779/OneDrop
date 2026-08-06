import { useEffect, useState } from "react";

import type {
  AuthStatus,
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";

async function sendRequest(request: RuntimeRequest): Promise<AuthStatus> {
  const response = (await browser.runtime.sendMessage(
    request,
  )) as RuntimeResponse;

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.status;
}

export function App() {
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    void sendRequest({ type: "auth/status" })
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
      setStatus(await sendRequest(request));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed",
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
          <strong>Authentication failed</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </main>
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
