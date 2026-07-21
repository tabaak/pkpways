import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker image
  // ships only the traced dependencies instead of the whole node_modules tree.
  output: "standalone",
  reactCompiler: true,
  async headers() {
    return [
      {
        // The rail geometry is a large, rarely-changing asset fetched at
        // runtime. Serve it from cache on repeat visits and refresh it in the
        // background, so a regenerated snapshot still propagates within a day.
        source: "/data/rail-segments.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
