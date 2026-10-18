// Starts a long-lived child process that inherits the output pipes, then never finishes evaluating.
Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"], { stdout: "inherit", stderr: "inherit" });
await new Promise(resolve => setTimeout(resolve, 600_000));

export {};