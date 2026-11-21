import { z } from "zod";

export const flowPublicationGrantSchema = z.strictObject({
  flowRevisionId: z.string().min(1),
  repoIdentity: z.string().min(1),
  targetBranch: z.string().min(1),
  branchTemplate: z.string().nullable(),
});

export type FlowPublicationGrant = z.infer<typeof flowPublicationGrantSchema>;
