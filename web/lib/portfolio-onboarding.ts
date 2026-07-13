export interface PortfolioOnboardingInput {
  enabledFlowCount: number;
  taskFlowRunCount: number;
  visibleProjectCount: number;
}

export interface PortfolioOnboarding {
  connected: boolean;
  flowReady: boolean;
  taskLaunched: boolean;
}

export function derivePortfolioOnboarding({
  enabledFlowCount,
  taskFlowRunCount,
  visibleProjectCount,
}: PortfolioOnboardingInput): PortfolioOnboarding {
  const connected = visibleProjectCount > 0;
  const flowReady = connected && enabledFlowCount > 0;

  return {
    connected,
    flowReady,
    taskLaunched: flowReady && taskFlowRunCount > 0,
  };
}
