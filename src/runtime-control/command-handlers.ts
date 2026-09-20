// Project/App: gsd-pi
// File Purpose: Command handler registry. Test handlers only; production is not-ready until C06.

import type { CommandRequest, JobRecord, Operation, ResolvedProject } from "./types.ts";

export type CommandHandlerContext = {
  operation: Operation;
  request: CommandRequest;
  job: JobRecord;
  project: ResolvedProject;
};

export type CommandHandlerResult = {
  dispatch?: boolean;
  holdLease?: boolean;
};

export type CommandHandler = (
  context: CommandHandlerContext,
) => CommandHandlerResult | void | Promise<CommandHandlerResult | void>;

let testHandler: CommandHandler | null = null;

export function registerCommandHandlerForTest(handler: CommandHandler | null): void {
  testHandler = handler;
}

export function getCommandHandler(): CommandHandler | null {
  return testHandler;
}

export function resetCommandHandlerForTest(): void {
  testHandler = null;
}
