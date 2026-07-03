import type { ExperimentDiffFileSummary } from "@/lib/experiments/types";

export type FilesMatrixInput = {
  variantKey: string;
  replicateOrdinal: number;
  files: ExperimentDiffFileSummary[];
};

export type FilesMatrixClassification = "single" | "same" | "different";

export type FilesMatrixRow = {
  path: string;
  classification: FilesMatrixClassification;
  touchedBy: string[];
  variants: Record<string, ExperimentDiffFileSummary | null>;
};

export type FilesMatrixResult = {
  rows: FilesMatrixRow[];
  filters: {
    all: FilesMatrixRow[];
    different: FilesMatrixRow[];
    same: FilesMatrixRow[];
  };
};

function classify(files: ExperimentDiffFileSummary[]): FilesMatrixClassification {
  if (files.length <= 1) return "single";

  const hashes = new Set(files.map((file) => file.patchHash));

  return hashes.size === 1 ? "same" : "different";
}

export function buildFilesMatrix(inputs: FilesMatrixInput[]): FilesMatrixResult {
  const variantOrder = inputs.map((input) => input.variantKey);
  const byPath = new Map<string, Record<string, ExperimentDiffFileSummary>>();

  for (const input of inputs) {
    for (const file of input.files) {
      const current = byPath.get(file.path) ?? {};

      current[input.variantKey] = file;
      byPath.set(file.path, current);
    }
  }

  const rows = [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, byVariant]): FilesMatrixRow => {
      const files = variantOrder
        .map((variantKey) => byVariant[variantKey])
        .filter(
          (file): file is ExperimentDiffFileSummary => file !== undefined,
        );
      const variants = Object.fromEntries(
        variantOrder.map((variantKey) => [
          variantKey,
          byVariant[variantKey] ?? null,
        ]),
      );

      return {
        path,
        classification: classify(files),
        touchedBy: variantOrder.filter(
          (variantKey) => byVariant[variantKey] !== undefined,
        ),
        variants,
      };
    });

  return {
    rows,
    filters: {
      all: rows,
      different: rows.filter((row) => row.classification === "different"),
      same: rows.filter((row) => row.classification === "same"),
    },
  };
}
