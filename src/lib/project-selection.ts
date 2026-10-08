export function selectedProjectId(href: string): string | undefined {
  const projectId = new URL(href).searchParams.get("project");
  return projectId && /^project_[a-f0-9]{20}$/.test(projectId) ? projectId : undefined;
}

export function projectSelectionUrl(href: string, projectId?: string): string {
  const url = new URL(href);
  if (projectId && /^project_[a-f0-9]{20}$/.test(projectId)) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");
  return url.toString();
}
