/* eslint-disable no-console */
import { seedNativeCompanyBrain } from "./seed-e2e";

seedNativeCompanyBrain().catch((error: unknown) => {
  console.error("seed-native-company-brain failed:", error);
  process.exitCode = 1;
});
