import { readCachedAccountAvatar } from "@onedrop/app-runtime/features/settings/avatar-cache";
import { LoadingSpinner } from "./LoadingSpinner";
import { useEffect, useRef, useState } from "react";
import type { LocalAccounts } from "@onedrop/core/domain/local-account";
import type { RuntimeRequest } from "@onedrop/core/contracts/runtime-messages";
import { getPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { EditIcon } from "./AccountIcons";

export function AccountSwitcher({
  hideWhenEmpty = false,
}: {
  hideWhenEmpty?: boolean;
}) {
  const [accounts, setAccounts] = useState<LocalAccounts>({ accounts: [] });
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<RuntimeRequest>();
  const pendingRef = useRef(false);
  const revisionRef = useRef(0);
  const busy = pending !== undefined;
  const [error, setError] = useState("");
  async function request(command: RuntimeRequest) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    revisionRef.current++;
    setPending(command);
    setError("");
    let awaitingSwitch = false;
    try {
      const result = await getPlatformBridge().request(command);
      if (!result.ok) throw new Error(result.error);
      if (command.type === "accounts/switch") awaitingSwitch = true;
      else if (result.type === "accounts/list") setAccounts(result.accounts);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The account could not be updated.",
      );
    } finally {
      if (!awaitingSwitch) {
        pendingRef.current = false;
        setPending(undefined);
      }
    }
  }
  useEffect(() => {
    const update = () => {
      const revision = revisionRef.current;
      void getPlatformBridge()
        .request({ type: "accounts/list" })
        .then((result) => {
          if (
            revision === revisionRef.current &&
            !pendingRef.current &&
            result.ok &&
            result.type === "accounts/list"
          )
            setAccounts(result.accounts);
        })
        .catch(() => {
          if (revision === revisionRef.current && !pendingRef.current)
            setError("The account list could not be read.");
        });
    };
    update();
    window.addEventListener("onedrop-accounts-updated", update);
    return () => window.removeEventListener("onedrop-accounts-updated", update);
  }, []);
  useEffect(() => {
    let active = true;
    const update = () => {
      void Promise.all(
        accounts.accounts.map(
          async (account) =>
            [
              account.key,
              (await readCachedAccountAvatar(account.key)).dataUrl,
            ] as const,
        ),
      ).then((entries) => {
        if (active) setAvatars(Object.fromEntries(entries));
      });
    };
    update();
    window.addEventListener("onedrop-avatar-updated", update);
    window.addEventListener("storage", update);
    return () => {
      active = false;
      window.removeEventListener("onedrop-avatar-updated", update);
      window.removeEventListener("storage", update);
    };
  }, [accounts]);
  if (hideWhenEmpty && accounts.accounts.length === 0) return null;
  const current = accounts.accounts.find(
    (account) => account.key === accounts.activeKey,
  );
  const others = accounts.accounts.filter(
    (account) => account.key !== accounts.activeKey,
  );
  return (
    <div className="account-switcher">
      {current?.signInRequired ? (
        <button
          className="account-menu-action"
          aria-busy={
            pending?.type === "accounts/add" &&
            pending.reauthenticateKey === current.key
          }
          disabled={busy}
          onClick={() =>
            void request({
              type: "accounts/add",
              reauthenticateKey: current.key,
            })
          }
          type="button"
        >
          {pending?.type === "accounts/add" &&
          pending.reauthenticateKey === current.key ? (
            <LoadingSpinner />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="M15 7a6 6 0 1 0 1 5M15 3v4h-4" />
            </svg>
          )}
          <span>Sign in again</span>
        </button>
      ) : null}
      <div className="account-switcher-heading">
        <span className="account-section-label">Switch account</span>
        <button
          className="account-edit-toggle"
          aria-label={editing ? "Done editing accounts" : "Edit accounts"}
          aria-pressed={editing}
          disabled={busy || others.length === 0}
          onClick={() => setEditing(!editing)}
          type="button"
        >
          {editing ? (
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="m4 10 4 4 8-8" />
            </svg>
          ) : (
            <EditIcon />
          )}
        </button>
      </div>
      {others.map((account) => {
        const name =
          account.displayName || account.username || "Microsoft account";
        const label =
          [account.displayName, account.username].filter(Boolean).join(" — ") ||
          name;
        return (
          <div className="account-choice" key={account.key}>
            <button
              className="account-choice-button"
              aria-label={`Switch to ${label}`}
              title={label}
              aria-busy={
                pending?.type === "accounts/switch" &&
                pending.accountKey === account.key
              }
              disabled={busy}
              onClick={() =>
                void request({
                  type: "accounts/switch",
                  accountKey: account.key,
                })
              }
              type="button"
            >
              <span className="account-choice-avatar" aria-hidden="true">
                {pending?.type === "accounts/switch" &&
                pending.accountKey === account.key ? (
                  <LoadingSpinner />
                ) : avatars[account.key] ? (
                  <img src={avatars[account.key]!} alt="" />
                ) : (
                  name.slice(0, 1).toUpperCase()
                )}
              </span>
              <strong>{name}</strong>
              <small>{account.username}</small>
            </button>
            {account.signInRequired && !editing ? (
              <button
                className="account-secondary-action"
                disabled={busy}
                onClick={() =>
                  void request({
                    type: "accounts/add",
                    reauthenticateKey: account.key,
                  })
                }
                type="button"
                aria-label={`Sign in again to ${label}`}
                aria-busy={
                  pending?.type === "accounts/add" &&
                  pending.reauthenticateKey === account.key
                }
              >
                {pending?.type === "accounts/add" &&
                pending.reauthenticateKey === account.key ? (
                  <LoadingSpinner />
                ) : null}
                Sign in again
              </button>
            ) : null}
            {editing ? (
              <button
                className="account-secondary-action"
                disabled={busy}
                onClick={() =>
                  void request({
                    type: "accounts/remove",
                    accountKey: account.key,
                  })
                }
                type="button"
                aria-label={`Remove ${label}`}
                aria-busy={
                  pending?.type === "accounts/remove" &&
                  pending.accountKey === account.key
                }
              >
                {pending?.type === "accounts/remove" &&
                pending.accountKey === account.key ? (
                  <LoadingSpinner />
                ) : null}
                Remove
              </button>
            ) : null}
          </div>
        );
      })}
      <div className="account-menu-section account-add-section">
        <button
          className="account-menu-action"
          aria-busy={
            pending?.type === "accounts/add" && !pending.reauthenticateKey
          }
          disabled={busy || accounts.accounts.length >= 3}
          onClick={() => void request({ type: "accounts/add" })}
          type="button"
        >
          {pending?.type === "accounts/add" && !pending.reauthenticateKey ? (
            <LoadingSpinner />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="M10 4v12M4 10h12" />
            </svg>
          )}
          <span>Add account</span>
        </button>
      </div>
      {accounts.accounts.length >= 3 ? (
        <p className="account-switcher-note">Three accounts maximum</p>
      ) : null}
      {error ? (
        <p className="account-switcher-note" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
