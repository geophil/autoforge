export interface ProjectConfig {
  id: string;
  name: string;
  repoUrl: string;
  docsPath: string;
  defaultTier: "EXPRESS" | "STANDARD" | "THOROUGH";
}

export const DEFAULT_PROJECT: ProjectConfig = {
  id: "autoforge",
  name: "Autoforge",
  repoUrl: "https://github.com/geophil/autoforge.git",
  docsPath: "docs/",
  defaultTier: "STANDARD"
};
