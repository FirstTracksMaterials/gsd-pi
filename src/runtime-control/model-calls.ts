// Project/App: gsd-pi
// File Purpose: Read-path model-call counter. Snapshots/history/SSE must never increment this.

let count = 0;

export function recordModelCall(): void {
  count += 1;
}

export function modelCallCount(): number {
  return count;
}

export function resetModelCallsForTest(): void {
  count = 0;
}
