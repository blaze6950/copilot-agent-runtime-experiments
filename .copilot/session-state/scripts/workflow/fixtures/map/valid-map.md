# Map: greeting CLI

## Current state

```mermaid
classDiagram
    class Greeter
    class Cli
    Cli --> Greeter : uses
```

| Element | Evidence | Note |
|---|---|---|
| Greeter | src/Greeter.cs:3 | class declaration |
| Cli | src/Cli.ps1:3 | entry point |
| Cli --> Greeter | src/Cli.ps1:4-5 | constructs and calls |

```mermaid
sequenceDiagram
    actor User
    participant Cli
    participant G as Greeter
    User->>Cli: run
    Cli->>G: Greet(name)
    G-->>Cli: greeting
    Cli-->>User: prints
```

| Element | Evidence | Note |
|---|---|---|
| User | src/Cli.ps1:3 | the caller |
| Cli | src/Cli.ps1:3 | participant |
| G | src/Greeter.cs:3 | alias of Greeter |

```mermaid
flowchart LR
    A[Cli] --> B[Greeter]
    B -.-> C[Greet]
```

| Element | Evidence | Note |
|---|---|---|
| A | src/Cli.ps1:3 | entry point |
| Greeter | src/Greeter.cs:3 | matched by label |
| C | src/Greeter.cs:5 | method |
| A --> Greeter | src/Cli.ps1:4-5 | calls |
| Greeter -.-> Greet | src/Greeter.cs:5 | calls the method |

## Target state

```mermaid
classDiagram
    class Greeter
    class Logger:::added
    Greeter --> Logger : logs
```

| Element | Evidence | Note |
|---|---|---|
| Greeter | src/Greeter.cs:3 | unchanged |
| Logger | new (T19) | added by T19 |
| Greeter --> Logger | new (T19) | logs greetings |
