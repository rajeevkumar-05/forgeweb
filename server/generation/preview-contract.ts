export type SafePreviewResponse =
  | { status: "ready"; versionId: string; previewUrl: string; expiresAt: number }
  | { status: "unavailable"; versionId: string; message: string };
