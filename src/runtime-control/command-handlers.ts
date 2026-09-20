// Project/App: gsd-pi
// File Purpose: Command handler registry. Production wires native domain; tests may inject.

import { productionCommandHandler } from "./native-commands.ts";
import type { CommandRequest, JobRecord, Operation, ResolvedProject } from "./types.ts";
import type { CommandHost } from "./native-commands.ts";

export type CommandHandlerContext = {
  operation: Operation;
  request: CommandRequest;
  job: JobRecord;
  project: ResolvedProject;
  host: CommandHost;
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

export function getCommandHandler(): CommandHandler {
  return testHandler ?? productionCommandHandler;
}

export function resetCommandHandlerForTest(): void {
  testHandler = null;
}
