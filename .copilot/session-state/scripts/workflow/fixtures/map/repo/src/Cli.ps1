param([string] $Name = 'world')

# Cli entry point: greets the User.
$greeter = [Demo.Greeter]::new()
Write-Output $greeter.Greet($Name)
