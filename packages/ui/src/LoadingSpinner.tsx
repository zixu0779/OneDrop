export function LoadingSpinner() {
  return <span className="loading-spinner" aria-hidden="true" />;
}

export function AppLoading({ failed = false }: { failed?: boolean }) {
  return (
    <main className="app-loading" role={failed ? "alert" : "status"}>
      {failed ? (
        <>
          <p>OneDrop could not load your accounts. Local data has been kept.</p>
          <button onClick={() => window.location.reload()} type="button">
            Try again
          </button>
        </>
      ) : (
        <>
          <LoadingSpinner />
          <span>Loading OneDrop…</span>
        </>
      )}
    </main>
  );
}
