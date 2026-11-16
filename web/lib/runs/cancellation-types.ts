/** Server-recorded company stop intent, retained independently of transport and prompt completion. */
export type CompanyRunCancellationIntent = Readonly<{
  version: 1;
  userId: string;
  requestedAt: string;
  assignmentId: string | null;
  driverToken: string | null;
}>;
