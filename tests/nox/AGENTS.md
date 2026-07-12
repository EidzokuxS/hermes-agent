# Nox Migration Tests

- Test production boundaries mechanically and include a negative fixture for every forbidden route.
- Do not traverse, open, or inspect closed paths. Tests may reject their literal path names when those names appear in allowed production sources.
- Keep production-graph evidence deterministic: no timestamps, machine paths, user data, credentials, or generated runtime state.
- A graph change is accepted only when its source change, boundary documentation, negative fixtures, and checked-in baseline agree.
