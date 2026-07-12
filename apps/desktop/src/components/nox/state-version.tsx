export function StateVersion({ hash, version }: { hash: string; version: number }) {
  return (
    <div aria-label={`State version ${version}`} className="state-version" title={hash || 'State is not available'}>
      <span className="state-version__label">State</span>
      <strong>v{version}</strong>
      <code>{hash ? hash.slice(7, 15) : 'not available'}</code>
    </div>
  )
}
