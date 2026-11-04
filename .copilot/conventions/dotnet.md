Repository conventions (AGENTS.md, .github instructions, existing code) override every rule in this pack.

# .NET conventions

## Language and design

- Make nullability state the real contract: make a parameter non-nullable when every caller guarantees a value, instead of null-checking it and throwing. Do not suppress nullable warnings without a comment that justifies it (e.g. framework-initialised properties).
- Follow the .NET naming guidelines: PascalCase for types and members, camelCase for parameters and locals.

## Async

- Never block on async code with `.Result` or `.Wait()`.
- Name Task-returning methods with the `Async` suffix.
- Do not do synchronous I/O on async paths.
- Accept a `CancellationToken` and pass it through async call chains.

## Dependency injection and configuration

- Prefer constructor injection; never use a service locator.
- Bind configuration to options (`IOptions<T>` and friends) instead of reading `IConfiguration` in business code.
- When the repository uses Microsoft.Extensions.Options: validate options at startup with `ValidateDataAnnotations().ValidateOnStart()` in the registration extension method. Register each validator once.

## Adapters and data access

- When the repository uses Entity Framework Core: use `AsNoTracking()` for read-only queries.
- When the repository uses Entity Framework Core: avoid N+1 queries; use `Include` or projections.
- When the repository uses Entity Framework Core: do not use lazy loading unless explicitly required.
- When the repository uses Entity Framework Core: never modify a migration that is already applied to a shared database; add a new migration.

## Performance

- When the repository uses Entity Framework Core: check the SQL generated for large `Contains` id lists (translation depends on the EF version and database compatibility level); bound large lists.
- Pre-size a collection when its final count is known.

## Tests

- A mock setup does not prove a call happened. When the assertion cannot prove it, verify the call explicitly (Moq `Verify`, NSubstitute `Received`).
- Dispose custom `HttpMessageHandler` stubs.
