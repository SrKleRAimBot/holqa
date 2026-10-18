// Never finishes evaluating in time, like a module that waits for a network connection.
await new Promise(resolve => setTimeout(resolve, 600_000));

export {};