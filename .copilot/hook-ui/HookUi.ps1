# Shared user-visible output rule for our hooks: one cyan line per event; NO_COLOR (non-empty) turns colour off
# (same rule as extensions/cache-keeper/lib/statusline-render.mjs colorEnabled). Dot-sourced; defines functions only.

# Wraps a hook's progress message in ANSI cyan unless NO_COLOR is set to a non-empty value.
function Format-HookMessage([string] $Message) {
    if ($env:NO_COLOR) { return $Message }
    $esc = [char]27
    return "${esc}[36m$Message${esc}[0m"
}
