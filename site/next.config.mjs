import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(currentDirectory, ".."),
  poweredByHeader: false,
  turbopack: {
    root: path.resolve(currentDirectory, ".."),
  },
};

export default nextConfig;
