import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker image
  // ships only the traced dependencies instead of the whole node_modules tree.
  output: "standalone",
  reactCompiler: true,
};

export default nextConfig;
