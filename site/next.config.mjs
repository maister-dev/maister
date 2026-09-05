import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(currentDirectory, ".."),
  poweredByHeader: false,
  async redirects() {
    return [
      {
        // `curl -fsSL https://imaister.dev/quickstart.sh | bash`: the script
        // lives in the repository, so the site only forwards to it.
        source: "/quickstart.sh",
        destination:
          "https://raw.githubusercontent.com/maister-dev/maister/master/scripts/quickstart.sh",
        permanent: false,
      },
    ];
  },
  turbopack: {
    root: path.resolve(currentDirectory, ".."),
  },
};

export default nextConfig;
