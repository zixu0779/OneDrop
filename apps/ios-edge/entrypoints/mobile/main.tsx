import React from "react";
import ReactDOM from "react-dom/client";

import { appMetadata } from "@onedrop/core/config/app";
import "./styles.css";

function Preview() {
  const manifest = browser.runtime.getManifest();

  return (
    <main className="preview-shell">
      <div className="status-mark" aria-hidden="true">
        ✓
      </div>
      <p className="eyebrow">iOS Edge preview</p>
      <h1>OneDrop opened successfully</h1>
      <p className="summary">
        The CRX popup entrypoint and extension runtime are available on this
        device.
      </p>
      <dl>
        <div>
          <dt>App version</dt>
          <dd>{appMetadata.version}</dd>
        </div>
        <div>
          <dt>Manifest version</dt>
          <dd>{manifest.manifest_version}</dd>
        </div>
        <div>
          <dt>Runtime ID</dt>
          <dd className="runtime-id">{browser.runtime.id}</dd>
        </div>
      </dl>
      <p className="scope-note">
        This first preview does not sign in, access OneDrive, or download files.
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("OneDrop iOS Edge preview root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
