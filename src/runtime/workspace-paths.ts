import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

// Shared host-side path-safety helpers used by both LocalWorkspace and
// ContainerWorkspace. Both providers ultimately go through the host
// filesystem (LocalWorkspace via spawn, ContainerWorkspace via a bind mount
// at /workspace), so the same root-containment rules apply.
//
// Rules:
//   resolveInsideRoot           – syntactic check; throws if the literal
//                                 resolved path is not under rootPath.
//   assertRealPathInsideRoot    – stat-based check; throws if the realpath of
//                                 an EXISTING path escapes rootPath (catches
//                                 symlink escapes). Use for read paths and
//                                 for `cwd` in exec calls (cwd must exist).
//   assertWritablePathInsideRoot – stat-based check that tolerates the leaf
//                                 not yet existing; walks up to find the
//                                 nearest existing ancestor and checks that.
//                                 Use for write paths (writeFile creates the
//                                 file).

export function resolveInsideRoot(rootPath: string, path: string): string {
  const target = resolve(rootPath, path);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Path is outside workspace root: ${path}`);
  }
  return target;
}

export async function assertRealPathInsideRoot(
  rootPath: string,
  target: string,
  originalPath: string
): Promise<void> {
  const [rootRealPath, targetRealPath] = await Promise.all([
    realpath(rootPath),
    realpath(target)
  ]);
  if (!isPathInside(targetRealPath, rootRealPath)) {
    throw new Error(`Path is outside workspace root: ${originalPath}`);
  }
}

export async function assertWritablePathInsideRoot(
  rootPath: string,
  target: string,
  originalPath: string
): Promise<void> {
  const rootRealPath = await realpath(rootPath);

  try {
    const targetRealPath = await realpath(target);
    if (!isPathInside(targetRealPath, rootRealPath)) {
      throw new Error(`Path is outside workspace root: ${originalPath}`);
    }
    return;
  } catch (error) {
    if (error instanceof Error && !isMissingPathError(error)) {
      throw error;
    }
  }

  let ancestor = dirname(target);
  while (ancestor !== dirname(ancestor)) {
    try {
      const ancestorRealPath = await realpath(ancestor);
      if (!isPathInside(ancestorRealPath, rootRealPath)) {
        throw new Error(`Path is outside workspace root: ${originalPath}`);
      }
      return;
    } catch (error) {
      if (error instanceof Error && !isMissingPathError(error)) {
        throw error;
      }
      ancestor = dirname(ancestor);
    }
  }

  throw new Error(`Path is outside workspace root: ${originalPath}`);
}

export function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function isMissingPathError(error: Error): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
