export function StateVersion({ hash, version }: { hash: string; version: number }) {
  return (
    <div aria-label={`State version ${version}`} className="state-version">
      <span className="state-version__label">STATE</span>
      <strong>v{version}</strong>
      <code>{hash ? hash.slice(7, 15) : 'unbound'}</code>
    </div>
  )
}
