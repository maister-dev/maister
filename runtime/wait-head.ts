export type WaitHeadObservationRequest = {
  waitId: string;
  workspaceGeneration: number;
  register?: true;
};

export type WaitHeadObservation = { headSha: string };

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
