import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LocalAccounts } from "@onedrop/core/domain/local-account";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@onedrop/platform/platform/platform-bridge", () => ({
  getPlatformBridge: () => mock,
}));
import { AccountSwitcher } from "../../packages/ui/src/AccountSwitcher";
let saved: LocalAccounts;
beforeEach(() => {
  saved = {
    activeKey: "A",
    accounts: ["A", "B", "C"].map((key) => ({
      key,
      displayName: `Name ${key}`,
      username: `${key}@example.com`,
      lastUsedAt: 1,
      signInRequired: false,
    })),
  };
  mock.request.mockReset();
  mock.request.mockImplementation(async (command) => {
    if (command.type === "accounts/remove")
      saved = {
        ...saved,
        accounts: saved.accounts.filter((a) => a.key !== command.accountKey),
      };
    return { ok: true, type: "accounts/list", accounts: saved };
  });
});
afterEach(cleanup);
test("only other accounts are selectable; pencil removes credentials without discard/export UI", async () => {
  render(<AccountSwitcher />);
  await screen.findByRole("button", {
    name: "Switch to Name B — B@example.com",
  });
  expect(
    screen.queryByRole("button", { name: /Switch to Name A/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Accounts \(/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Remove/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Edit accounts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Name B — B@example.com" }),
  );
  await waitFor(() =>
    expect(mock.request).toHaveBeenCalledWith({
      type: "accounts/remove",
      accountKey: "B",
    }),
  );
  expect(screen.queryByText(/Discard unsent/)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add account" })).toBeEnabled(),
  );
  expect(saved.activeKey).toBe("A");
});
test("expired current account can reauthenticate at the three-account limit without appearing in switch list", async () => {
  saved.accounts[0]!.signInRequired = true;
  render(<AccountSwitcher />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
  await waitFor(() =>
    expect(mock.request).toHaveBeenCalledWith({
      type: "accounts/add",
      reauthenticateKey: "A",
    }),
  );
  expect(
    screen.queryByRole("button", { name: /Switch to Name A/ }),
  ).not.toBeInTheDocument();
});

test("editing reserves other-account actions for removal and restores reauthentication on Done", async () => {
  saved.accounts[1]!.signInRequired = true;
  render(<AccountSwitcher />);
  expect(
    await screen.findByRole("button", {
      name: "Sign in again to Name B — B@example.com",
    }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Edit accounts" }));
  expect(
    screen.queryByRole("button", {
      name: "Sign in again to Name B — B@example.com",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Remove Name B — B@example.com" }),
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Done editing accounts" }),
  );
  expect(
    screen.getByRole("button", {
      name: "Sign in again to Name B — B@example.com",
    }),
  ).toBeEnabled();
});

test("switch shows a row spinner, blocks repeated calls and keeps waiting for page replacement", async () => {
  let finish!: (value: unknown) => void;
  mock.request.mockImplementation(async (command) =>
    command.type === "accounts/switch"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ok: true, type: "accounts/list", accounts: saved },
  );
  render(<AccountSwitcher />);
  const button = await screen.findByRole("button", {
    name: "Switch to Name B — B@example.com",
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button.querySelector(".loading-spinner")).not.toBeNull();
  window.dispatchEvent(new Event("onedrop-accounts-updated"));
  await waitFor(() =>
    expect(
      mock.request.mock.calls.filter(
        ([command]) => command.type === "accounts/switch",
      ),
    ).toHaveLength(1),
  );
  finish({
    ok: true,
    type: "accounts/list",
    accounts: { ...saved, activeKey: "B" },
  });
  await waitFor(() => expect(button).toBeDisabled());
  expect(button.querySelector(".loading-spinner")).not.toBeNull();
});
test("failed switch clears its spinner and allows retry", async () => {
  mock.request.mockImplementation(async (command) =>
    command.type === "accounts/switch"
      ? { ok: false, error: "Try again" }
      : { ok: true, type: "accounts/list", accounts: saved },
  );
  render(<AccountSwitcher />);
  const button = await screen.findByRole("button", {
    name: "Switch to Name B — B@example.com",
  });
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
  expect(button).toBeEnabled();
  expect(button.querySelector(".loading-spinner")).toBeNull();
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      mock.request.mock.calls.filter(
        ([command]) => command.type === "accounts/switch",
      ),
    ).toHaveLength(2),
  );
});

test.each(["add", "remove", "reauth"])(
  "%s shows progress on its own button and recovers on failure",
  async (action) => {
    if (action === "add") saved.accounts.pop();
    if (action === "reauth") saved.accounts[1]!.signInRequired = true;
    let finish!: (value: unknown) => void;
    mock.request.mockImplementation(async (command) =>
      command.type === "accounts/list"
        ? { ok: true, type: "accounts/list", accounts: saved }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    render(<AccountSwitcher />);
    await screen.findByRole("button", {
      name: "Switch to Name B — B@example.com",
    });
    if (action === "remove")
      fireEvent.click(screen.getByRole("button", { name: "Edit accounts" }));
    const name =
      action === "add"
        ? "Add account"
        : action === "remove"
          ? "Remove Name B — B@example.com"
          : "Sign in again to Name B — B@example.com";
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".loading-spinner")).not.toBeNull();
    finish({ ok: false, error: "Try again" });
    await screen.findByRole("alert");
    expect(button).toBeEnabled();
    expect(button.querySelector(".loading-spinner")).toBeNull();
    expect(
      mock.request.mock.calls.filter(
        ([command]) => command.type !== "accounts/list",
      ),
    ).toHaveLength(1);
  },
);
