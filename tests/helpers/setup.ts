import { afterEach } from "bun:test";
import { cleanupAllTestServices } from "./create-service";

// Global safety net: after every test, tear down any TestService that was
// created but not explicitly cleaned up. Prevents worktrees, git branches,
// and temp directories from leaking between test runs.
afterEach(() => {
  cleanupAllTestServices();
});
