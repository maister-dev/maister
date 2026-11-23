export type NodeRestartCheckpoint = Readonly<{
  attemptId: string;
  checkpointSha: string;
  previewToken: string;
  rescueRef: string | null;
}>;

export type NodeRestartPreview = Readonly<{
  token: string;
  files: readonly { path: string; removed: boolean }[];
  fileCount: number;
  rewindsCommits: boolean;
}>;
