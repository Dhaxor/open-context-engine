#!/usr/bin/env node
import { Command } from "commander";
import { packageVersion } from "../version";
import { createCliIo, CliFatalError, CliIo } from "./io";
import { registerIndexingCommands } from "./commands/indexing";
import { registerSearchCommands } from "./commands/search";
import { registerAgentCommands } from "./commands/agent";
import { registerMcpCommand } from "./commands/mcp";
import { registerTeamCommands } from "./commands/team";
import { registerMiscCommands } from "./commands/license";

/** The full `oce` command tree around one io, so tests can run commands
 *  in-process against captured output instead of spawning the binary. */
export function buildProgram(io: CliIo = createCliIo()): import("commander").Command {
  const program = new Command();
  program.name("oce").description("Open Context Engine").version(packageVersion());
  registerIndexingCommands(program, io);
  registerSearchCommands(program, io);
  registerAgentCommands(program, io);
  registerMcpCommand(program, io);
  registerTeamCommands(program, io);
  registerMiscCommands(program, io);
  return program;
}

// Only the real entry point parses argv and owns process exit codes. Tests
// call buildProgram().parseAsync() with their own io and never get killed.
if (require.main === module) {
  buildProgram().parseAsync().catch((err: any) => {
    // Every action is async. `parse()` left their rejections unhandled, so a
    // misconfiguration surfaced as a raw Node stack trace — the first thing a
    // new user saw. Print the message; keep the stack for OCE_DEBUG.
    if (!(err instanceof CliFatalError)) {
      const human = createCliIo();
      human.error(String(err?.message ?? err));
      if (process.env.OCE_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  });
}
