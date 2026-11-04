Repository conventions (AGENTS.md, .github instructions, existing code) override every rule in this pack.

# General conventions

## Design and integration

- Apply an accepted rule to every occurrence in code the change adds or modifies, not only the line that was commented on. List occurrences in pre-existing code separately as a follow-up; do not fix them in a feature change.
- Name a type for what it does.
- Keep the mapping from domain facts to an external system's meaning in one explicit place at that system's boundary. Domain types hold facts only. Do not mix "fact" and "derived for system X" properties in one type.
- Orchestrator methods call one method per concern. Building the inputs of a sub-concern belongs to the component that owns that concern.
- Do not pass a delegate to obtain data the argument already carries.
- Extract a shared static helper only for a pure rule used by two or more callers. Otherwise keep the logic with its single consumer. Reuse an existing helper before adding a near-duplicate.
- Mirror a dependency's input limit only when the dependency enforces it, and name the source in a one-line comment.
- Validate or filter inputs symmetrically: if one kind of blank input is dropped, equally blank inputs of the same kind are dropped too.
- Normalize values (trim, case) once at the owning boundary. Consumers do not repeat the normalization.

## Naming

- A variable name states its content and kind. Use plural nouns for collections, name services by their role, and make inputs and outputs distinguishable (for example `countInputs` versus `countsByGroup`). Avoid names that repeat their type or accessor, such as `count.Count`.
- Name a variable, parameter, field or local for what its value is: the domain thing it holds, in the domain language the code already uses. Do not name it for a generic category or role (`totals`, `result`, `data`, `info`, `plan`, `counted`), and do not name a value `request` unless it is a request. A collection name says what it contains and, when keyed, by what (`purchaseUnitCountsByGroup`, `purchaseUnitCountsBySdo`). Do not introduce new terms when a domain term or the type's name already exists.
- A method name states its effect. Avoid vague verbs such as `Prepare` for methods that validate, look up and throw.

## Methods and data flow

- Split long methods into phases as private helpers named after the phase. Add phase comments only in long workflows.
- Build failure-only data (for example the list of missing items) only on the failure path.
- Never swallow exceptions — log or rethrow.
- Catch broad exception types only at boundaries, where they are logged and translated.
- Never share mutable state between concurrent operations without synchronization.

## Performance

- Optimize round trips, query plans and payload size first.
- In hot paths, avoid per-iteration allocations (for example string concatenation in loops).

## Logging

- On failure, include the identifiers needed to reproduce the problem. Never log unbounded payloads.

## Tests

- Name test data: class-level constants for repeated literals; arrange-local variables for inputs that are used in act and assert.
- Test each behaviour at one level; do not duplicate coverage across levels.
- Test behaviour through the public contract, not implementation details.
- Follow the repository's test naming pattern. If none exists, use `Method_WhenCondition_ExpectedResult`. Name the test class after the component under test.

## Documentation

- Keep one place per fact (DRY) and link to it elsewhere. If the repository has a glossary, it defines terms; feature pages explain behaviour.
- Make every behavioural claim precise about where and when it applies, and make it match the code. Name API fields by their API names and wire fields by their wire names.
- Headings name their content accurately.
- Put a rule, doc or config note in the change whose code it describes.

## Security

- Pass user-controlled input to SQL, shell commands and file paths only through parameterization or validation.
- Never log or return secrets, tokens or passwords.
