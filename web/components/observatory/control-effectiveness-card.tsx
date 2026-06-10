import type { ReactElement } from "react";
import type { ControlEffectivenessCardProps } from "@/components/observatory/types";

import {
  formatLift,
  formatRateWithN,
  formatRatioWithN,
} from "@/components/observatory/harness-format";

export function ControlEffectivenessCard({
  effectiveness,
  labels,
}: ControlEffectivenessCardProps): ReactElement {
  const harness = labels.harness;

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <h2 className="m-0 text-sm font-semibold text-ink">
        {harness.effectivenessTitle}
      </h2>
      {effectiveness.gates.length === 0 ? (
        <p className="mt-2 text-sm text-mute">{harness.noEffectiveness}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              <tr>
                <th className="border-b border-line px-2 py-2">
                  {harness.gate}
                </th>
                <th className="border-b border-line px-2 py-2">
                  {harness.reworkAfterFail}
                </th>
                <th className="border-b border-line px-2 py-2">
                  {harness.reworkAfterPass}
                </th>
                <th className="border-b border-line px-2 py-2">
                  {harness.lift}
                </th>
              </tr>
            </thead>
            <tbody>
              {effectiveness.gates.map((gate) => (
                <tr
                  key={`${gate.flowId}:${gate.nodeId}:${gate.gateId}`}
                  className="border-b border-line-soft"
                >
                  <td className="px-2 py-2">
                    <span className="font-mono text-xs font-semibold text-ink">
                      {gate.gateId}
                    </span>
                    <span className="ml-2 font-mono text-[10px] text-mute">
                      {gate.flowRefId} · {gate.nodeId}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {formatRateWithN(
                      gate.reworkRateAfterFail,
                      gate.failedAttempts,
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {formatRateWithN(
                      gate.reworkRateAfterPass,
                      gate.passedAttempts,
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {formatLift(
                      gate.lift,
                      gate.failedAttempts,
                      gate.passedAttempts,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="mb-0 mt-4 text-xs font-semibold text-ink">
        {harness.capabilitiesTitle}
      </h3>
      {effectiveness.capabilities.length === 0 ? (
        <p className="mt-2 text-sm text-mute">{harness.noCapabilities}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              <tr>
                <th className="border-b border-line px-2 py-2">
                  {harness.capability}
                </th>
                <th className="border-b border-line px-2 py-2">
                  {labels.correctionRate} · {harness.withCapability}
                </th>
                <th className="border-b border-line px-2 py-2">
                  {labels.correctionRate} · {harness.withoutCapability}
                </th>
              </tr>
            </thead>
            <tbody>
              {effectiveness.capabilities.map((capability) => (
                <tr
                  key={capability.refId}
                  className="border-b border-line-soft"
                >
                  <td className="px-2 py-2">
                    <span className="font-mono text-xs font-semibold text-ink">
                      {capability.refId}
                    </span>
                    <span className="ml-2 font-mono text-[10px] text-mute">
                      {capability.capabilityKind}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {formatRatioWithN(
                      capability.withCapability.correctionRate,
                      capability.withCapability.runCount,
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {formatRatioWithN(
                      capability.withoutCapability.correctionRate,
                      capability.withoutCapability.runCount,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
