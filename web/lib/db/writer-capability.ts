// S4.7 / D9 step 10: the schema floor the cut-over leaves behind refuses
// writers by CLASS, not by trust. Every binary that may write a preservation
// lane record declares this capability on its session; a binary that predates
// the floor never does, and the lane table's writer gate refuses it naming the
// class it saw. Raising the floor is a new value here and a new migration that
// requires it — never a relaxation of the gate.

export const WRITER_CAPABILITY_SETTING = "maister.writer_capability";
export const EXECUTION_AB_WRITER_CAPABILITY = "execution-ab-1";

type SessionClient = { query(text: string): Promise<unknown> };

// `SET` takes no bind parameters; both halves are compile-time constants.
export async function declareWriterCapability(
  client: SessionClient,
): Promise<void> {
  await client.query(
    `SET ${WRITER_CAPABILITY_SETTING} = '${EXECUTION_AB_WRITER_CAPABILITY}'`,
  );
}
