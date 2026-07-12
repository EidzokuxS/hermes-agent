const expected = 'v24.18.0'

if (process.version !== expected) {
  console.error(`Nox requires Node ${expected.slice(1)}; received ${process.version}`)
  process.exitCode = 1
} else {
  console.log(`Node ${process.version} matches .node-version`)
}
