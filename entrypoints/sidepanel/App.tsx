export function App() {
  return (
    <main className="shell">
      <header className="header">
        <div className="brand-mark" aria-hidden="true" />
        <div>
          <h1>OneDrop</h1>
          <p>Project foundation</p>
        </div>
      </header>

      <section className="empty-state" aria-labelledby="foundation-title">
        <span className="eyebrow">Architecture approved</span>
        <h2 id="foundation-title">Your OneDrive sharing space</h2>
        <p>
          The Edge extension shell is ready. Authentication, messages, and file
          transfers have intentionally not been implemented yet.
        </p>
      </section>
    </main>
  );
}
