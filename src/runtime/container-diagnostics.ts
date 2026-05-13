export type ContainerFailureCategory = "preflight" | "create" | "start" | "exec" | "cleanup";

export interface DockerPreflightCheck {
  category: "preflight";
  cmd: string;
  args: string[];
}

export interface ContainerFailureClassification {
  category: ContainerFailureCategory;
  reason:
    | "docker_daemon_unavailable"
    | "docker_image_missing"
    | "container_create_failed"
    | "container_start_failed"
    | "container_exec_failed"
    | "container_cleanup_failed";
}

export function buildDockerPreflightChecks(image: string): DockerPreflightCheck[] {
  return [
    { category: "preflight", cmd: "docker", args: ["info"] },
    { category: "preflight", cmd: "docker", args: ["image", "inspect", image] }
  ];
}

export function classifyContainerFailure(
  category: ContainerFailureCategory,
  stderr: string
): ContainerFailureClassification {
  const normalized = stderr.toLowerCase();
  if (category === "preflight" && normalized.includes("cannot connect to the docker daemon")) {
    return { category, reason: "docker_daemon_unavailable" };
  }
  if (category === "preflight" && (normalized.includes("no such image") || normalized.includes("no such object"))) {
    return { category, reason: "docker_image_missing" };
  }
  if (category === "create") return { category, reason: "container_create_failed" };
  if (category === "start") return { category, reason: "container_start_failed" };
  if (category === "cleanup") return { category, reason: "container_cleanup_failed" };
  return { category, reason: "container_exec_failed" };
}
