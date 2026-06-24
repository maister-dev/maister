export type ConsensusVerificationAssignment = {
  verifierId: string;
  targetParticipantId: string;
};

export function buildConsensusRotation(
  participantIds: readonly string[],
): ConsensusVerificationAssignment[] {
  if (participantIds.length < 2) {
    throw new RangeError("consensus rotation needs at least two participants");
  }

  return participantIds.map((verifierId, index) => ({
    verifierId,
    targetParticipantId: participantIds[(index + 1) % participantIds.length],
  }));
}
